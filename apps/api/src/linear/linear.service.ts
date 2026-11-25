import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { canManageProject } from "@treepm/domain";
import { refuseWhileActingAs } from "../access/act-as.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { uniqueConstraintName } from "../common/conflict.js";
import { CredentialCipherError } from "../common/credential-cipher.js";
import type { CredentialAad, CredentialCipher } from "../common/credential-cipher.js";
import type { TenantRunner } from "../db/own-transactions.js";
import type { ConnectionOutput, ProjectLinearOutput, TeamOutput } from "./linear.schema.js";
import { CREDENTIAL_CIPHER, LINEAR_CLIENT, LinearError } from "./ports.js";
import type { LinearClient } from "./ports.js";

const PROVIDER = "linear";

type SourceRow = {
  projectId: string;
  externalWorkspaceId: string;
  externalWorkspaceName: string;
  externalTeamId: string;
  externalTeamKey: string;
  externalTeamName: string;
  linkedByPersonId: string;
  linkedAt: Date;
};

const sourceView = (row: SourceRow): NonNullable<ProjectLinearOutput["source"]> => ({
  workspace: { id: row.externalWorkspaceId, name: row.externalWorkspaceName },
  team: { id: row.externalTeamId, key: row.externalTeamKey, name: row.externalTeamName },
  linkedAt: row.linkedAt.toISOString(),
  linkedBy: { id: row.linkedByPersonId },
});

const notConnected = (message = "Conecte a sua chave do Linear primeiro."): ConflictException => new ConflictException({ code: "linear_not_connected", message });
const archived = (): ConflictException => new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
const alreadyLinked = (): ConflictException => new ConflictException({ code: "linear_already_linked", message: "Este projeto já está ligado a um time do Linear, e a ligação não muda." });
const teamInUse = (): ConflictException => new ConflictException({ code: "linear_team_in_use", message: "Este time do Linear já está ligado a outro projeto da organização." });

const PK_CONSTRAINT = "project_external_sources_pkey";
const TEAM_CONSTRAINT = "project_external_sources_team_key";

/**
 * A violação de UNIQUE de uma ligação: só a do time vira `linear_team_in_use` e só a da chave primária (projeto) vira
 * `linear_already_linked`. Qualquer outra (ou erro que não seja unicidade) devolve `null` e quem chama propaga o original.
 */
export function linkConflict(error: unknown): HttpException | null {
  const name = uniqueConstraintName(error);
  if (name === TEAM_CONSTRAINT) return teamInUse();
  if (name === PK_CONSTRAINT) return alreadyLinked();
  return null;
}

/** Erro do cliente do Linear → resposta HTTP com código estável (sem texto do Linear, sem a chave). */
function http(error: LinearError): HttpException {
  switch (error.code) {
    case "linear_key_invalid":
      return new UnprocessableEntityException({ code: error.code, message: "O Linear recusou a chave." });
    case "linear_rate_limited":
      return new HttpException(
        { code: error.code, message: "O Linear limitou as consultas. Tente de novo mais tarde.", details: { retryAfterSeconds: error.retryAfterSeconds ?? 60 } },
        429,
      );
    default:
      return new ServiceUnavailableException({ code: "linear_unavailable", message: "Não foi possível falar com o Linear agora." });
  }
}

/**
 * Chave do Linear por pessoa e vínculo permanente do projeto com um time (ADR 0060, seções 1 e 2). As chamadas ao Linear (rede) ficam
 * fora de transação; cada gravação abre a sua, que reconfere papel e projeto. A chave decifrada só existe dentro de uma chamada.
 */
@Injectable()
export class LinearService {
  private readonly logger = new Logger("Linear");

  constructor(
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher | null,
    @Inject(LINEAR_CLIENT) private readonly client: LinearClient,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  private requireCipher(): CredentialCipher {
    if (!this.cipher) throw new ServiceUnavailableException({ code: "linear_not_configured", message: "A ligação com o Linear não está configurada neste servidor." });
    return this.cipher;
  }

  private async viaLinear<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LinearError) throw http(error);
      throw error;
    }
  }

  private aad(principal: Principal): CredentialAad {
    return { orgId: principal.organization.orgId, personId: principal.person.id, provider: PROVIDER };
  }

  // ---- conexão (a chave da própria pessoa) ----

  async getConnection(tx: TenantClient, principal: Principal): Promise<ConnectionOutput> {
    if (principal.via?.kind === "act-as") return { configured: this.cipher !== null, connection: null, actingAs: true };
    if (!this.cipher) return { configured: false, connection: null };
    const row = await tx.externalCredential.findUnique({ where: { orgId_personId_provider: { orgId: principal.organization.orgId, personId: principal.person.id, provider: PROVIDER } } });
    return { configured: true, connection: row ? this.connectionView(row) : null };
  }

  private connectionView(row: { externalWorkspaceId: string; externalWorkspaceName: string; secretHint: string; createdAt: Date; updatedAt: Date }): NonNullable<ConnectionOutput["connection"]> {
    return { workspace: { id: row.externalWorkspaceId, name: row.externalWorkspaceName }, hint: row.secretHint, connectedAt: row.updatedAt.toISOString() };
  }

  /** Confere a chave no Linear e só então a grava (ou substitui) cifrada. */
  async connect(tenant: TenantRunner, principal: Principal, apiKey: string): Promise<ConnectionOutput> {
    refuseWhileActingAs(principal);
    const cipher = this.requireCipher();
    const identity = await this.viaLinear(() => this.client.whoami(apiKey));
    return tenant.run(async (tx, current) => {
      const sealed = cipher.encrypt(apiKey, this.aad(current));
      const data = {
        // `Uint8Array` novo: o Prisma não aceita o `Buffer` (ArrayBufferLike) como bytes.
        secretCiphertext: new Uint8Array(sealed.ciphertext),
        secretNonce: new Uint8Array(sealed.nonce),
        keyVersion: sealed.keyVersion,
        externalWorkspaceId: identity.workspace.id,
        externalWorkspaceName: identity.workspace.name,
        secretHint: apiKey.slice(-4),
      };
      const row = await tx.externalCredential.upsert({
        where: { orgId_personId_provider: { orgId: current.organization.orgId, personId: current.person.id, provider: PROVIDER } },
        create: { orgId: current.organization.orgId, personId: current.person.id, provider: PROVIDER, ...data },
        update: data,
      });
      return { configured: true, connection: this.connectionView(row) };
    });
  }

  /** Remove só a credencial da própria pessoa; nenhum vínculo é tocado. */
  async disconnect(tx: TenantClient, principal: Principal): Promise<void> {
    refuseWhileActingAs(principal);
    await tx.externalCredential.deleteMany({ where: { orgId: principal.organization.orgId, personId: principal.person.id, provider: PROVIDER } });
  }

  /** A chave decifrada da própria pessoa e o workspace dela. 409 `linear_not_connected` sem credencial ou com credencial ilegível. */
  private async loadKey(tx: TenantClient, principal: Principal): Promise<{ key: string; workspaceId: string }> {
    const cipher = this.requireCipher();
    const row = await tx.externalCredential.findUnique({ where: { orgId_personId_provider: { orgId: principal.organization.orgId, personId: principal.person.id, provider: PROVIDER } } });
    if (!row) throw notConnected();
    try {
      const key = cipher.decrypt({ ciphertext: Buffer.from(row.secretCiphertext), nonce: Buffer.from(row.secretNonce), keyVersion: row.keyVersion }, this.aad(principal));
      return { key, workspaceId: row.externalWorkspaceId };
    } catch (error) {
      if (!(error instanceof CredentialCipherError)) throw error;
      this.logger.warn("credencial do Linear ilegível (chave de cifra trocada ou linha adulterada); a pessoa precisa colar a chave de novo");
      throw notConnected("A chave guardada não pôde ser lida. Cole a chave do Linear de novo.");
    }
  }

  // ---- times que a chave enxerga ----

  async listTeams(tenant: TenantRunner, principal: Principal): Promise<TeamOutput[]> {
    refuseWhileActingAs(principal);
    const credential = await tenant.run((tx, current) => this.loadKey(tx, current));
    const teams = await this.viaLinear(() => this.client.listTeams(credential.key));
    return tenant.run(async (tx, current) => {
      const sources = await tx.projectExternalSource.findMany({
        where: { orgId: current.organization.orgId, provider: PROVIDER, externalWorkspaceId: credential.workspaceId, externalTeamId: { in: teams.map((team) => team.id) } },
      });
      const projects = await tx.project.findMany({ where: { orgId: current.organization.orgId, id: { in: sources.map((source) => source.projectId) } } });
      const visible = new Map(this.authorization.visible(current.actor, projects).map((project) => [project.id, project]));
      const byTeam = new Map(sources.map((source) => [source.externalTeamId, source.projectId]));
      return teams.map((team) => {
        const projectId = byTeam.get(team.id);
        const project = projectId === undefined ? undefined : visible.get(projectId);
        return {
          id: team.id,
          key: team.key,
          name: team.name,
          linkedProject: project ? { id: project.id, name: project.name } : null,
          linkedElsewhere: projectId !== undefined && !project,
        };
      });
    });
  }

  // ---- o projeto ----

  /** Inexistente, de outra organização (RLS) ou privado sem papel: o mesmo 404, como nas rotas de projeto. */
  private async findVisible(tx: TenantClient, principal: Principal, projectId: string) {
    const project = await tx.project.findFirst({ where: { orgId: principal.organization.orgId, id: projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  /**
   * Não chama o Linear. `keyMatches` compara só o workspace da chave guardada com o do vínculo (`null` sem chave ou sem origem); a
   * visibilidade do time é conferida na hora de operar (`requireLinearAccess`).
   */
  async projectLinear(tenant: TenantRunner, principal: Principal, projectId: string): Promise<ProjectLinearOutput> {
    refuseWhileActingAs(principal);
    return tenant.run(async (tx, current) => {
      const project = await this.findVisible(tx, current, projectId);
      const source = await tx.projectExternalSource.findUnique({ where: { orgId_projectId: { orgId: current.organization.orgId, projectId } } });
      const canLink = source === null && project.archivedAt === null && canManageProject(current.actor, projectId);
      if (!source) return { source: null, canLink, keyMatches: null };
      const own = await tx.externalCredential.findUnique({ where: { orgId_personId_provider: { orgId: current.organization.orgId, personId: current.person.id, provider: PROVIDER } }, select: { externalWorkspaceId: true } });
      return { source: sourceView(source), canLink, keyMatches: own ? own.externalWorkspaceId === source.externalWorkspaceId : null };
    });
  }

  /**
   * Liga o projeto a um time. Quem administra o projeto, com a PRÓPRIA chave: o time é conferido no Linear na hora e a chave do time
   * digitada tem de bater (a confirmação dupla da ADR 0060). A ligação não muda nem se desfaz depois.
   */
  async link(tenant: TenantRunner, principal: Principal, projectId: string, body: { teamId: string; confirmTeamKey: string }): Promise<ProjectLinearOutput> {
    refuseWhileActingAs(principal);
    const credential = await tenant.run(async (tx, current) => {
      const project = await this.findVisible(tx, current, projectId);
      this.authorization.manageProject(current.actor, projectId);
      if (project.archivedAt) throw archived();
      if (await tx.projectExternalSource.findUnique({ where: { orgId_projectId: { orgId: current.organization.orgId, projectId } } })) throw alreadyLinked();
      return this.loadKey(tx, current);
    });
    const identity = await this.viaLinear(() => this.client.whoami(credential.key));
    const team = await this.viaLinear(() => this.client.getTeam(credential.key, body.teamId));
    if (!team) throw new NotFoundException({ code: "linear_team_not_found", message: "A sua chave do Linear não enxerga este time." });
    if (team.key.toLowerCase() !== body.confirmTeamKey.toLowerCase()) {
      throw new UnprocessableEntityException({ code: "linear_confirmation_mismatch", message: "A chave digitada não é a do time escolhido." });
    }
    try {
      return await tenant.run(async (tx, current) => {
        const project = await this.findVisible(tx, current, projectId);
        this.authorization.manageProject(current.actor, projectId);
        if (project.archivedAt) throw archived();
        // A chave pode ter sido removida ou trocada por outra de outro workspace durante a chamada ao Linear.
        const stored = await tx.externalCredential.findUnique({ where: { orgId_personId_provider: { orgId: current.organization.orgId, personId: current.person.id, provider: PROVIDER } }, select: { externalWorkspaceId: true } });
        if (!stored || stored.externalWorkspaceId !== identity.workspace.id) throw notConnected();
        const row = await tx.projectExternalSource.create({
          data: {
            orgId: current.organization.orgId,
            projectId,
            provider: PROVIDER,
            externalWorkspaceId: identity.workspace.id,
            externalWorkspaceName: identity.workspace.name,
            externalTeamId: team.id,
            externalTeamKey: team.key,
            externalTeamName: team.name,
            linkedByPersonId: current.person.id,
          },
        });
        await this.activity.record(tx, current, {
          kind: "project.linear_linked",
          subjectType: "project",
          subjectId: projectId,
          payload: { provider: PROVIDER, workspaceName: row.externalWorkspaceName, teamKey: row.externalTeamKey },
        });
        return { source: sourceView(row), canLink: false, keyMatches: true };
      });
    } catch (error) {
      // Corrida: a conferência passou e o banco recusou; o nome da restrição diz qual (sem reler nada).
      throw linkConflict(error) ?? error;
    }
  }

  // ---- para a fatia 2 ----

  /**
   * Tudo o que uma operação num projeto ligado precisa conferir antes de usar o Linear com a chave de QUEM opera: a credencial existe,
   * o projeto tem vínculo, o workspace da chave é o do vínculo e a chave enxerga o time (consulta só esse time, não a lista toda).
   * Lê credencial e vínculo numa transação curta, fecha, e só então chama o Linear: quem chama NÃO pode estar com transação aberta
   * (por isso recebe o `TenantRunner`, e não um `tx`). A visibilidade do projeto para a pessoa é conferida por quem chama.
   */
  async requireLinearAccess(tenant: TenantRunner, principal: Principal, projectId: string): Promise<{ key: string; source: SourceRow }> {
    refuseWhileActingAs(principal);
    const { key, workspaceId, source } = await tenant.run(async (tx, current) => {
      const loaded = await this.loadKey(tx, current);
      const row = await tx.projectExternalSource.findUnique({ where: { orgId_projectId: { orgId: current.organization.orgId, projectId } } });
      return { ...loaded, source: row };
    });
    if (!source) throw new ConflictException({ code: "linear_not_linked", message: "Este projeto não está ligado a um time do Linear." });
    if (workspaceId !== source.externalWorkspaceId) {
      throw new ForbiddenException({
        code: "linear_workspace_mismatch",
        message: `A sua chave é de outro workspace do Linear. Use uma chave do workspace "${source.externalWorkspaceName}".`,
        details: { workspaceName: source.externalWorkspaceName },
      });
    }
    const team = await this.viaLinear(() => this.client.getTeam(key, source.externalTeamId));
    if (!team) {
      throw new ForbiddenException({ code: "linear_team_not_visible", message: `A sua chave do Linear não enxerga o time "${source.externalTeamName}".` });
    }
    return { key, source };
  }
}
