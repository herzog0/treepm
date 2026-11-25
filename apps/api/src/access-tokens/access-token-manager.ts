import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { ACCESS_TOKEN_CLOCK } from "./clock.js";
import type { AccessTokenClock } from "./clock.js";
import { MAX_ACTIVE_TOKENS, createdTokenSchema, organizationTokenSchema, tokenSchema } from "./access-token.schema.js";
import type { CreateTokenBody, CreatedTokenOutput, McpState, OrganizationTokenOutput, TokenOutput } from "./access-token.schema.js";
import { buildToken } from "./token.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type TokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scope: string;
  people: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  project: { id: string; key: string };
};

const withProject = { project: { select: { id: true, key: true } } } as const;

/** Campos públicos de um token. Nunca o token nem o resumo. */
function view(row: TokenRow): Omit<TokenOutput, never> {
  return {
    id: row.id,
    name: row.name,
    project: { id: row.project.id, key: row.project.key },
    tokenPrefix: row.tokenPrefix,
    scope: row.scope === "write" ? ("write" as const) : ("read" as const),
    people: row.people,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** Criar, listar e revogar tokens de acesso (ADR 0038), dentro da transação da requisição. */
@Injectable()
export class AccessTokenManager {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {}

  private async mcpState(tx: TenantClient, orgId: string): Promise<McpState["mcp"]> {
    const row = await tx.organization.findUnique({ where: { orgId }, select: { mcpEnabled: true, mcpWriteEnabled: true, mcpPeopleEnabled: true } });
    return { enabled: row?.mcpEnabled ?? false, writeEnabled: row?.mcpWriteEnabled ?? false, peopleEnabled: row?.mcpPeopleEnabled ?? false };
  }

  /** Liga ou desliga a chave da organização. Só administrador; o evento só sai quando o estado muda. */
  async setMcpEnabled(tx: TenantClient, principal: Principal, enabled: boolean): Promise<{ mcp: McpState["mcp"] }> {
    this.authorization.manageMcpAccess(principal.actor);
    const orgId = principal.organization.orgId;
    const current = await this.mcpState(tx, orgId);
    if (current.enabled !== enabled) {
      await tx.organization.update({ where: { orgId }, data: { mcpEnabled: enabled } });
      await this.activity.record(tx, principal, {
        kind: "organization.mcp_changed",
        subjectType: "organization",
        subjectId: orgId,
        payload: { enabled },
      });
    }
    return { mcp: { ...current, enabled } };
  }

  /** Liga ou desliga "Permitir escrita por MCP" (ADR 0043). Só administrador; o evento só sai quando o estado muda. */
  async setMcpWriteEnabled(tx: TenantClient, principal: Principal, enabled: boolean): Promise<{ mcp: McpState["mcp"] }> {
    this.authorization.manageMcpAccess(principal.actor);
    const orgId = principal.organization.orgId;
    const current = await this.mcpState(tx, orgId);
    if (current.writeEnabled !== enabled) {
      await tx.organization.update({ where: { orgId }, data: { mcpWriteEnabled: enabled } });
      await this.activity.record(tx, principal, { kind: "organization.mcp_write_changed", subjectType: "organization", subjectId: orgId, payload: { enabled } });
    }
    return { mcp: { ...current, writeEnabled: enabled } };
  }

  /**
   * Liga ou desliga "Pessoas e conversas" (ADR 0062). Só administrador; só pode ser LIGADA com a chave geral ligada (409
   * `mcp_disabled`); desligar a geral não desliga esta, mas ela não vale sem a outra. O evento só sai quando o estado muda.
   */
  async setMcpPeopleEnabled(tx: TenantClient, principal: Principal, enabled: boolean): Promise<{ mcp: McpState["mcp"] }> {
    this.authorization.manageMcpAccess(principal.actor);
    const orgId = principal.organization.orgId;
    const current = await this.mcpState(tx, orgId);
    if (enabled && !current.enabled) {
      throw new ConflictException({ code: "mcp_disabled", message: "Ligue primeiro o acesso por MCP da organização." });
    }
    if (current.peopleEnabled !== enabled) {
      await tx.organization.update({ where: { orgId }, data: { mcpPeopleEnabled: enabled } });
      await this.activity.record(tx, principal, { kind: "organization.mcp_people_changed", subjectType: "organization", subjectId: orgId, payload: { enabled } });
    }
    return { mcp: { ...current, peopleEnabled: enabled } };
  }

  /** O token inteiro sai desta resposta e de mais nenhum lugar. */
  async create(tx: TenantClient, principal: Principal, body: CreateTokenBody): Promise<CreatedTokenOutput> {
    const { orgId } = principal.organization;
    // As chaves são relidas AQUI, dentro da transação, com trava compartilhada na linha da organização: quem liga ou desliga uma
    // chave grava essa linha, então uma criação que chega no meio espera a confirmação dele e enxerga o estado novo. O que foi
    // carregado antes (`principal.organization`) pode estar velho. A chave de escrita não é conferida na criação (o `scope` vale por
    // chamada), então não há o que reler dela.
    const [keys] = await tx.$queryRaw<{ mcp_enabled: boolean; mcp_people_enabled: boolean }[]>`select mcp_enabled, mcp_people_enabled from organizations where org_id = ${orgId} for share`;
    if (!keys?.mcp_enabled) {
      throw new ForbiddenException({ code: "mcp_disabled", message: "O acesso por MCP está desligado nesta organização." });
    }
    // O alcance de pessoas só nasce com a chave da organização ligada naquele momento (ADR 0062).
    if (body.people && !keys.mcp_people_enabled) {
      throw new ForbiddenException({ code: "mcp_people_disabled", message: "O alcance \"Pessoas e conversas\" está desligado nesta organização." });
    }
    // O RLS esconde projetos de outra organização; privado sem papel também vira 404, como nas outras rotas.
    const project = await tx.project.findFirst({ where: { id: body.projectId }, select: { id: true, key: true, visibility: true } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");

    // Serializa as criações da mesma pessoa: sem isto, duas simultâneas contariam 9 e passariam as duas.
    await tx.$queryRaw`select 1 from people where org_id = ${orgId} and id = ${principal.person.id}::uuid for update`;
    const now = this.clock.now();
    const active = await tx.accessToken.count({
      where: { personId: principal.person.id, revokedAt: null, expiresAt: { gt: new Date(now) } },
    });
    if (active >= MAX_ACTIVE_TOKENS) {
      throw new ConflictException({
        code: "access_token_limit",
        message: `Limite de ${MAX_ACTIVE_TOKENS} tokens ativos atingido; revogue algum antes de criar outro.`,
      });
    }

    const built = buildToken(orgId);
    const row = await tx.accessToken.create({
      data: {
        orgId,
        personId: principal.person.id,
        projectId: project.id,
        name: body.name,
        tokenPrefix: built.prefix,
        tokenHash: built.hash,
        scope: body.scope,
        people: body.people,
        expiresAt: new Date(now + body.expiresInDays * DAY_MS),
      },
      include: withProject,
    });
    await this.activity.record(tx, principal, {
      kind: "access_token.created",
      subjectType: "project",
      subjectId: project.id,
      payload: { tokenId: row.id, name: row.name, projectKey: project.key, tokenPrefix: row.tokenPrefix, scope: row.scope, people: row.people },
    });
    return parseOutput(createdTokenSchema, { ...view(row), token: built.token });
  }

  async listOwn(tx: TenantClient, principal: Principal): Promise<TokenOutput[]> {
    const rows = await tx.accessToken.findMany({
      where: { personId: principal.person.id },
      include: withProject,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return rows.map((row) => parseOutput(tokenSchema, view(row)));
  }

  async listOrganization(tx: TenantClient, principal: Principal): Promise<OrganizationTokenOutput[]> {
    this.authorization.manageMcpAccess(principal.actor);
    const rows = await tx.accessToken.findMany({
      include: { ...withProject, person: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return rows.map((row) =>
      parseOutput(organizationTokenSchema, { ...view(row), person: { id: row.person.id, displayName: row.person.displayName } }),
    );
  }

  /**
   * A pessoa revoga os seus; o administrador, qualquer um da organização. Quem não pode ver o token recebe 404.
   * Marca `revoked_at` (não apaga); revogar de novo é sucesso sem efeito e sem evento.
   */
  async revoke(tx: TenantClient, principal: Principal, id: string): Promise<void> {
    const row = await tx.accessToken.findFirst({ where: { id }, include: withProject });
    const mine = row?.personId === principal.person.id;
    if (!row || !(mine || principal.actor.clerkRole === "admin")) throw new NotFoundException("Token não encontrado.");
    if (!mine) this.authorization.manageMcpAccess(principal.actor);
    if (row.revokedAt) return;
    const revoked = await tx.accessToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(this.clock.now()) },
    });
    if (revoked.count === 0) return;
    await this.activity.record(tx, principal, {
      kind: "access_token.revoked",
      subjectType: "project",
      subjectId: row.project.id,
      payload: { tokenId: row.id, name: row.name, projectKey: row.project.key, tokenPrefix: row.tokenPrefix },
    });
  }
}
