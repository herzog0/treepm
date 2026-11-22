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
export const RATE_LIMIT_PER_WINDOW = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * - `invalid`: token malformado, desconhecido, revogado ou vencido; pessoa inativa ou fora da organização (401, sem
 *   dizer qual).
 * - `disabled`: a chave "Permitir acesso por MCP" da organização está desligada (403).
 * - `not_found`: o projeto não é o do token ou a pessoa não o enxerga (404).
 * - `rate_limited`: mais de 60 requisições por minuto no token (429).
 */
export type ResolveFailure = "invalid" | "disabled" | "not_found" | "rate_limited";

export type ResolveResult =
  | {
      ok: true;
      tokenId: string;
      /** O mesmo `Principal` que uma sessão produz, com o papel ATUAL do Clerk e os papéis do banco. */
      principal: Principal;
      project: { id: string; key: string; name: string; archivedAt: Date | null };
    }
  | { ok: false; reason: ResolveFailure; retryAfterSeconds?: number };

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
  async resolve(rawToken: string, projectKey: string): Promise<ResolveResult> {
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
        include: { person: true, organization: { select: { mcpEnabled: true } } },
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
      return { tokenId: row.id, projectId: row.projectId, personId: row.person.id, clerkUserId: row.person.clerkUserId, lastUsedAt: row.lastUsedAt };
    });
    if ("ok" in checked) return checked;

    // 5. Participação no Clerk: rede, fora de qualquer transação.
    const orgRole = await this.membership(orgId, checked.clerkUserId);
    const clerkRole = orgRole === null ? null : parseClerkRole(orgRole);
    if (orgRole === null) await this.personLeft(orgId, checked);
    if (!clerkRole || orgRole === null) return this.reject(checked.tokenId, "invalid");

    // 6 a 8. Principal pelo mesmo caminho da sessão, projeto e último uso.
    const session: AuthenticatedSession = { userId: checked.clerkUserId, orgId, orgRole, sessionStatus: "active" };
    return this.tenants.run({ orgId, userId: checked.clerkUserId }, async (tx): Promise<ResolveResult> => {
      // Revogação, validade e a chave podem ter mudado durante a chamada ao Clerk: relê antes de devolver sucesso.
      const again = await tx.accessToken.findUnique({
        where: { tokenHash },
        include: { person: { select: { active: true } }, organization: { select: { mcpEnabled: true } } },
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
      };
    });
  }

  /** Esquece a participação guardada e o limite de requisições (para testes: o relógio falso volta no tempo). */
  resetMemory(): void {
    this.memberships.clear();
    this.inflight.clear();
    this.limiter.clear();
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
  private membership(orgId: string, userId: string): Promise<string | null> {
    const key = `${orgId}\u0000${userId}`;
    const now = this.clock.now();
    const cached = this.memberships.get(key);
    if (cached && cached.until > now) return Promise.resolve(cached.role);
    this.memberships.delete(key);
    const running = this.inflight.get(key);
    if (running) return running;
    const fetching = this.directory.getMembership(orgId, userId).then(
      (role) => {
        if (role !== null) this.memberships.set(key, { role, until: this.clock.now() + MEMBERSHIP_TTL_MS });
        return role;
      },
    );
    const done = (): void => void this.inflight.delete(key);
    this.inflight.set(key, fetching);
    fetching.then(done, done);
    return fetching;
  }
}
