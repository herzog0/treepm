import { Inject, Injectable, Logger } from "@nestjs/common";
import { parseClerkRole } from "../access/actor.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { PrincipalService } from "../access/principal.service.js";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import { DIRECTORY_PROVIDER } from "../auth/directory-provider.js";
import type { DirectoryProvider } from "../auth/directory-provider.js";
import { PROJECT_KEY_PATTERN } from "../common/schemas.js";
import { TenantTransactions } from "../db/tenant-transactions.js";
import { ACCESS_TOKEN_CLOCK } from "./clock.js";
import type { AccessTokenClock } from "./clock.js";
import { RateLimiter } from "./rate-limiter.js";
import { hashToken, parseToken } from "./token.js";

/** Quanto o Clerk pode ficar sem ser consultado sobre a mesma pessoa (ADR 0038: sair da organização corta em até 5 min). */
export const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
/** `last_used_at` é regravado no máximo uma vez por este intervalo, por token. */
export const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;
export const RATE_LIMIT_PER_WINDOW = 5000;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * Prazo de cada ida ao Clerk para conferir a participação. Mesmo padrão das chamadas à IA (`callClaude`): um temporizador e
 * `Promise.race` que rejeita; a chamada do SDK não é cancelável, mas deixa de segurar a vaga de resolução. Falha por prazo vira 503.
 */
export const MEMBERSHIP_TIMEOUT_MS = 5_000;

/**
 * - `invalid`: token malformado, desconhecido, revogado ou vencido; pessoa inativa ou fora da organização (401, sem
 *   dizer qual).
 * - `disabled`: a chave "Permitir acesso por MCP" da organização está desligada (403).
 * - `not_found`: o projeto não é o do token ou a pessoa não o enxerga (404).
 * - `rate_limited`: mais de `RATE_LIMIT_PER_WINDOW` requisições por minuto no token (429).
 */
export type ResolveFailure = "invalid" | "disabled" | "not_found" | "rate_limited";

export type ResolveResult =
  | {
      ok: true;
      tokenId: string;
      /** O mesmo `Principal` que uma sessão produz, com o papel ATUAL do Clerk e os papéis do banco. */
      principal: Principal;
      project: { id: string; key: string; name: string; archivedAt: Date | null };
      /** Alcance do token e a chave de escrita da organização (ADR 0043). */
      scope: "read" | "write";
      writeEnabled: boolean;
      /**
       * O alcance "pessoas e conversas" EFETIVO (ADR 0062): o token o tem E a chave da organização está ligada, lida de novo do
       * banco a cada requisição (a memória de 5 minutos é só a da participação no Clerk), então desligar a chave corta na
       * chamada seguinte.
       */
      people: boolean;
      /** `true` quando a participação no Clerk foi conferida de novo agora, sem a memória de 5 minutos (exigido para escrever). */
      fresh: boolean;
    }
  | { ok: false; reason: ResolveFailure; retryAfterSeconds?: number };

export type ResolveOptions = {
  /** O pedido é de uma ferramenta de escrita (pelo nome). Só vira consulta fresca se o token e a organização permitirem escrever. */
  fresh?: boolean;
  /** Chamado uma vez por tentativa de escrita, antes de qualquer ida ao Clerk; `allowed: false` recusa com 429. */
  onWriteAttempt?: (tokenId: string, personKey: string) => ReturnType<RateLimiter["hit"]>;
};

const invalid: ResolveResult = { ok: false, reason: "invalid" };

type Found = {
  tokenId: string;
  projectId: string;
  personId: string;
  clerkUserId: string;
  lastUsedAt: Date | null;
};

/**
 * Resolve um token de acesso em identidade (ADR 0038): pessoa, organização e papéis, mais o projeto. Sem rota; o
 * endereço MCP é a fatia seguinte. Cada chamada confere tudo de novo, exceto a participação no Clerk, que fica em
 * memória por até 5 minutos por par organização/pessoa (e o limite de requisições, também em memória).
 *
 * Nada aqui escreve o token nem o resumo em log: os logs levam só o id do registro.
 */
@Injectable()
export class AccessTokenService {
  private readonly logger = new Logger(AccessTokenService.name);
  private readonly memberships = new Map<string, { role: string; until: number }>();
  /** Consultas ao Clerk em andamento por organização/pessoa: requisições simultâneas esperam a mesma. */
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly limiter: RateLimiter;
  /** Prazo da consulta ao Clerk; mutável só para os testes. */
  membershipTimeoutMs = MEMBERSHIP_TIMEOUT_MS;

  constructor(
    @Inject(TenantTransactions) private readonly tenants: TenantTransactions,
    @Inject(PrincipalService) private readonly principals: PrincipalService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(DIRECTORY_PROVIDER) private readonly directory: DirectoryProvider,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {
    // Uma máquina só: o limite vale por processo (ADR 0038, "Em aberto" 5).
    this.limiter = new RateLimiter(clock, RATE_LIMIT_PER_WINDOW, RATE_LIMIT_WINDOW_MS);
  }

  /** Falha de operação (Clerk fora do ar, banco) sobe como erro: nunca vira "válido". */
  async resolve(rawToken: string, projectKey: string, options: ResolveOptions = {}): Promise<ResolveResult> {
    // `fresh` só vale depois de a primeira transação mostrar token `write` E a chave de escrita da organização ligada; antes disso
    // é só o PEDIDO (o nome da ferramenta). Sem os dois, o caminho é o da leitura, com a memória (ADR 0043, revisão 2).
    const wantsFresh = options.fresh === true;
    let fresh = false;
    // 1. Desmonta.
    const parsed = parseToken(rawToken);
    if (!parsed) return invalid;
    const { orgId } = parsed;
    // Chave fora do formato nunca vai ao banco: não existe projeto assim.
    if (!PROJECT_KEY_PATTERN.test(projectKey)) return { ok: false, reason: "not_found" };
    const tokenHash = hashToken(rawToken);

    // 2 a 4. Abre a transação da organização indicada e procura pelo resumo.
    const checked = await this.tenants.run({ orgId, userId: "access-token" }, async (tx): Promise<ResolveResult | Found> => {
      const row = await tx.accessToken.findUnique({
        where: { tokenHash },
        include: { person: true, organization: { select: { mcpEnabled: true, mcpWriteEnabled: true } } },
      });
      if (!row) return invalid;
      if (row.revokedAt || row.expiresAt.getTime() <= this.clock.now()) return this.reject(row.id, "invalid");
      const limited = this.limiter.hit(row.id);
      if (!limited.allowed) {
        this.logger.warn(`access_token ${row.id} rejected: rate_limited`);
        return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.ceil(limited.retryAfterMs / 1000) };
      }
      if (!row.organization.mcpEnabled) return this.reject(row.id, "disabled");
      if (!row.person.active) return this.reject(row.id, "invalid");
      if (wantsFresh && row.scope === "write" && row.organization.mcpWriteEnabled) {
        // Só quem PODE escrever gasta o limite de escrita (token de leitura ou chave desligada não o esgotam para os outros tokens da
        // pessoa; a recusa fica por conta do limite geral de requisições do token e do IP, acima). A tentativa conta ANTES de ir ao Clerk.
        const writes = options.onWriteAttempt?.(row.id, `${orgId}:${row.person.id}`);
        if (writes && !writes.allowed) return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.ceil(writes.retryAfterMs / 1000) };
        fresh = true;
      }
      return { tokenId: row.id, projectId: row.projectId, personId: row.person.id, clerkUserId: row.person.clerkUserId, lastUsedAt: row.lastUsedAt };
    });
    if ("ok" in checked) return checked;

    // 5. Participação no Clerk: rede, fora de qualquer transação.
    const orgRole = await this.membership(orgId, checked.clerkUserId, fresh);
    const clerkRole = orgRole === null ? null : parseClerkRole(orgRole);
    if (orgRole === null) await this.personLeft(orgId, checked);
    if (!clerkRole || orgRole === null) return this.reject(checked.tokenId, "invalid");

    // 6 a 8. Principal pelo mesmo caminho da sessão, projeto e último uso.
    const session: AuthenticatedSession = { userId: checked.clerkUserId, orgId, orgRole, sessionStatus: "active" };
    return this.tenants.run({ orgId, userId: checked.clerkUserId }, async (tx): Promise<ResolveResult> => {
      // Revogação, validade e a chave podem ter mudado durante a chamada ao Clerk: relê antes de devolver sucesso.
      const again = await tx.accessToken.findUnique({
        where: { tokenHash },
        include: { person: { select: { active: true } }, organization: { select: { mcpEnabled: true, mcpWriteEnabled: true, mcpPeopleEnabled: true } } },
      });
      if (!again || again.revokedAt || again.expiresAt.getTime() <= this.clock.now()) return this.reject(checked.tokenId, "invalid");
      if (!again.organization.mcpEnabled) return this.reject(checked.tokenId, "disabled");
      if (!again.person.active) return this.reject(checked.tokenId, "invalid");
      const loaded = await this.principals.load(tx, session, clerkRole, null);
      // O papel atual é o do Clerk, como a sessão faz ao atualizar a pessoa.
      const principal: Principal = { ...loaded, person: { ...loaded.person, clerkRole } };
      const project = await tx.project.findFirst({
        where: { key: projectKey },
        select: { id: true, key: true, name: true, visibility: true, archivedAt: true },
      });
      if (!project || project.id !== checked.projectId || !this.authorization.canView(principal.actor, project)) {
        return this.reject(checked.tokenId, "not_found");
      }
      const now = this.clock.now();
      if (!checked.lastUsedAt || now - checked.lastUsedAt.getTime() >= LAST_USED_INTERVAL_MS) {
        await tx.accessToken.updateMany({
          where: { id: checked.tokenId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_INTERVAL_MS) } }] },
          data: { lastUsedAt: new Date(now) },
        });
      }
      return {
        ok: true,
        tokenId: checked.tokenId,
        principal,
        project: { id: project.id, key: project.key, name: project.name, archivedAt: project.archivedAt },
        scope: again.scope === "write" ? "write" : "read",
        writeEnabled: again.organization.mcpWriteEnabled,
        people: again.people && again.organization.mcpPeopleEnabled,
        fresh,
      };
    });
  }

  /** Esquece a participação guardada e o limite de requisições (para testes: o relógio falso volta no tempo). */
  resetMemory(): void {
    this.memberships.clear();
    this.inflight.clear();
    this.limiter.clear();
    this.limiter.limit = RATE_LIMIT_PER_WINDOW;
  }

  /** Troca o teto por janela do token; só para os testes, que provam o bloqueio com um teto pequeno. `resetMemory` volta ao de produção. */
  setRateLimit(limit: number): void {
    this.limiter.limit = limit;
  }

  private reject(tokenId: string, reason: ResolveFailure): ResolveResult {
    this.logger.warn(`access_token ${tokenId} rejected: ${reason}`);
    return { ok: false, reason };
  }

  /**
   * A pessoa saiu da organização: fica inativa e TODOS os tokens ativos dela são revogados, cada um com o seu evento
   * (automático, sem pessoa autora). Assim, se ela voltar e a sessão a reativar, os tokens antigos não voltam a valer.
   */
  private async personLeft(orgId: string, found: Found): Promise<void> {
    await this.tenants.run({ orgId, userId: found.clerkUserId }, async (tx) => {
      await tx.person.updateMany({ where: { id: found.personId, active: true }, data: { active: false } });
      // A chave pessoal de um provedor externo (Linear, ADR 0060) não sobrevive à saída: se a pessoa voltar, cola de novo.
      await tx.externalCredential.deleteMany({ where: { orgId, personId: found.personId } });
      const now = this.clock.now();
      const active = await tx.accessToken.findMany({
        where: { personId: found.personId, revokedAt: null, expiresAt: { gt: new Date(now) } },
        include: { project: { select: { id: true, key: true } } },
      });
      for (const token of active) {
        const revoked = await tx.accessToken.updateMany({ where: { id: token.id, revokedAt: null }, data: { revokedAt: new Date(now) } });
        if (revoked.count === 0) continue;
        await tx.activityEvent.create({
          data: {
            orgId,
            actorPersonId: null,
            kind: "access_token.revoked",
            subjectType: "project",
            subjectId: token.project.id,
            payload: { tokenId: token.id, name: token.name, projectKey: token.project.key, tokenPrefix: token.tokenPrefix, automatic: true, reason: "left_organization" },
          },
        });
      }
    });
  }

  /**
   * Papel da pessoa no Clerk, com memória de até 5 minutos. Quem saiu (`null`) não fica guardado, e uma consulta que
   * falha também não: só os resultados positivos entram na memória. Consultas simultâneas da mesma pessoa dividem
   * a mesma promessa (uma ida ao Clerk por vez).
   */
  private membership(orgId: string, userId: string, fresh = false): Promise<string | null> {
    const key = `${orgId}\u0000${userId}`;
    const now = this.clock.now();
    const cached = this.memberships.get(key);
    // Escrita (ADR 0043) nunca usa a memória de 5 minutos nem divide a consulta de outra requisição: vai ao Clerk.
    if (!fresh && cached && cached.until > now) return Promise.resolve(cached.role);
    const running = fresh ? undefined : this.inflight.get(key);
    if (running) return running;
    // A entrada boa só é trocada depois de a consulta voltar com sucesso: falha ou demora do Clerk numa escrita não derruba as leituras.
    const fetching = this.withDeadline(this.directory.getMembership(orgId, userId)).then((role) => {
      if (role !== null) this.memberships.set(key, { role, until: this.clock.now() + MEMBERSHIP_TTL_MS });
      else this.memberships.delete(key);
      return role;
    });
    if (fresh) return fetching;
    const done = (): void => void this.inflight.delete(key);
    this.inflight.set(key, fetching);
    fetching.then(done, done);
    return fetching;
  }

  private withDeadline<T>(call: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Directory lookup timed out.")), this.membershipTimeoutMs);
    });
    call.catch(() => undefined);
    return Promise.race([call, expired]).finally(() => clearTimeout(timer));
  }
}
