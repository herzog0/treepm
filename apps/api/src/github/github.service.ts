import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { orConflict } from "../common/conflict.js";
import { parseOutput } from "../common/zod.js";
import { CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { installationEnvelope, linkedRepositoryOutput, providerRepositoryOutput } from "./github.schema.js";
import type { CompleteBody, LinkedRepository } from "./github.schema.js";
import { InvalidCodeError, REPOSITORY_PROVIDER } from "./ports.js";
import type { InstallationDetails, ProviderRepository, RepositoryProvider } from "./ports.js";
import { signState, verifyState } from "./state.js";

type InstallationRow = { id: string; installationId: bigint; accountLogin: string; accountType: string; repositorySelection: string; createdAt: Date };
type RepositoryRow = {
  id: string;
  repoId: bigint;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string;
  createdAt: Date;
};

const unavailable = () =>
  new ConflictException({ code: "installation_unavailable", message: "A instalação do GitHub não existe mais, é de outro app ou está suspensa." });
const notConnected = () => new ConflictException({ code: "not_connected", message: "A organização não está ligada ao GitHub." });

/**
 * Ligação com o GitHub (ADR 0032, passo 1): conectar a instalação do app à organização, consultar e desconectar,
 * e ligar repositórios da instalação aos projetos. Toda chamada ao provedor passa por `call`: qualquer falha vira
 * 503 `github_unavailable`, e o log leva só o nome da operação e da classe do erro, nunca a mensagem nem o corpo.
 */
@Injectable()
export class GithubService {
  private readonly logger = new Logger("GithubService");

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(REPOSITORY_PROVIDER) private readonly providerOrNull: RepositoryProvider | null,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  private get provider(): RepositoryProvider {
    // O guard já respondeu 404 com o GitHub desligado; chegar aqui sem provedor é erro de montagem.
    if (!this.providerOrNull) throw new Error("Provedor de repositórios ausente com o GitHub ligado.");
    return this.providerOrNull;
  }

  private get stateSecret(): string {
    const secret = this.config.GITHUB_APP_CLIENT_SECRET;
    if (!secret) throw new Error("GITHUB_APP_CLIENT_SECRET ausente com o GitHub ligado.");
    return secret;
  }

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof InvalidCodeError) throw error;
      this.logger.warn(`Falha do provedor de repositórios em ${operation}: ${error instanceof Error ? error.name : "erro desconhecido"}.`);
      throw new ServiceUnavailableException({ code: "github_unavailable", message: "O GitHub não está disponível agora. Tente de novo em instantes." });
    }
  }

  /** `POST /github/connect`: a URL de instalação com um `state` assinado para esta organização e este usuário. */
  connect(principal: Principal): { url: string } {
    this.authorization.manageGithubConnection(principal.actor);
    const state = signState(this.stateSecret, { orgId: principal.organization.orgId, userId: principal.session.userId }, new Date());
    return { url: this.provider.installUrl(state) };
  }

  /** `POST /github/connect/complete`: confere o `state`, o código e a posse da instalação antes de gravar. */
  async complete(tenant: TenantRunner, principal: Principal, body: CompleteBody) {
    const subject = { orgId: principal.organization.orgId, userId: principal.session.userId };
    if (!verifyState(this.stateSecret, body.state, subject, new Date())) {
      throw new BadRequestException({ code: "invalid_state", message: "A conexão expirou ou não é desta sessão. Comece de novo." });
    }
    this.authorization.manageGithubConnection(principal.actor);

    let exchange;
    try {
      exchange = await this.call("exchangeCode", () => this.provider.exchangeCode(body.code));
    } catch (error) {
      if (error instanceof InvalidCodeError) {
        throw new BadRequestException({ code: "invalid_code", message: "O GitHub recusou o código de autorização. Comece de novo." });
      }
      throw error;
    }

    // O `installation_id` do corpo só vale se o GitHub o lista para o usuário do token.
    let chosen: number;
    if (body.installationId !== undefined) {
      if (!exchange.installations.some((item) => item.installationId === body.installationId)) {
        throw new ForbiddenException({ code: "installation_not_yours", message: "Esta instalação não é acessível pela sua conta do GitHub." });
      }
      chosen = body.installationId;
    } else if (exchange.installations.length === 0) {
      throw new ConflictException({ code: "no_installation", message: "Nenhuma instalação do app foi encontrada na sua conta do GitHub." });
    } else if (exchange.installations.length > 1) {
      throw new ConflictException({ code: "installation_ambiguous", message: "Há mais de uma instalação do app na sua conta; informe qual." });
    } else {
      chosen = exchange.installations[0]?.installationId ?? 0;
    }

    const details = await this.usableInstallation(chosen);

    // Acesso não é posse: a lista do usuário inclui instalações a que ele só tem acesso. A conta vem de `getInstallation`.
    if (details.accountType === "User") {
      if (details.accountLogin.toLowerCase() !== exchange.userLogin.toLowerCase()) {
        throw new ForbiddenException({ code: "installation_not_yours", message: "Esta instalação não é da sua conta do GitHub." });
      }
    } else {
      throw new ConflictException({
        code: "organization_account_unsupported",
        message: "Instalações em organizações do GitHub ainda não são aceitas; instale o app na sua conta pessoal.",
      });
    }

    return tenant.run(async (tx, current) => {
      this.authorization.manageGithubConnection(current.actor);
      const orgId = current.organization.orgId;
      const taken = new ConflictException({ code: "already_connected", message: "Esta organização já está ligada ao GitHub." });
      if (await tx.githubInstallation.findFirst({ where: { orgId } })) throw taken;
      // `ON CONFLICT DO NOTHING` não aborta a transação: a unicidade global de `installation_id` enxerga outras organizações.
      const inserted = await tx.$queryRaw<{ id: string; createdAt: Date }[]>`
        insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by_person_id)
        values (${orgId}, ${BigInt(details.installationId)}, ${details.accountLogin}, ${details.accountType}, ${details.repositorySelection}, ${current.person.id}::uuid)
        on conflict do nothing
        returning id, created_at as "createdAt"`;
      const row = inserted[0];
      if (!row) {
        if (await tx.githubInstallation.findFirst({ where: { orgId } })) throw taken;
        throw new ConflictException({ code: "installation_in_use", message: "Esta instalação do GitHub já está em uso." });
      }
      await this.activity.record(tx, current, {
        kind: "github.connected",
        subjectType: "organization",
        subjectId: orgId,
        payload: { accountLogin: details.accountLogin, accountType: details.accountType, repositorySelection: details.repositorySelection },
      });
      return parseOutput(installationEnvelope, {
        installation: {
          accountLogin: details.accountLogin,
          accountType: details.accountType,
          repositorySelection: details.repositorySelection,
          connectedAt: row.createdAt.toISOString(),
        },
      });
    });
  }

  /** A instalação existe no GitHub, é deste app e não está suspensa; senão, 409 `installation_unavailable`. */
  private async usableInstallation(installationId: number): Promise<InstallationDetails> {
    const details = await this.call("getInstallation", () => this.provider.getInstallation(installationId));
    if (!details || details.suspended || details.appId !== Number(this.config.GITHUB_APP_ID)) throw unavailable();
    return details;
  }

  async installation(tx: TenantClient, orgId: string) {
    const row = await tx.githubInstallation.findFirst({ where: { orgId } });
    return parseOutput(installationEnvelope, { installation: row ? this.toInstallation(row) : null });
  }

  private toInstallation(row: InstallationRow) {
    return {
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      connectedAt: row.createdAt.toISOString(),
    };
  }

  /** Remove só a ligação no TreePM (repositórios dos projetos e vínculos em cascata); nada é desinstalado no GitHub. */
  async disconnect(tx: TenantClient, principal: Principal): Promise<void> {
    this.authorization.manageGithubConnection(principal.actor);
    const orgId = principal.organization.orgId;
    const row = await tx.githubInstallation.findFirst({ where: { orgId } });
    if (!row) throw new NotFoundException({ code: "not_connected", message: "A organização não está ligada ao GitHub." });
    await tx.githubInstallation.delete({ where: { orgId_id: { orgId, id: row.id } } });
    await this.activity.record(tx, principal, {
      kind: "github.disconnected",
      subjectType: "organization",
      subjectId: orgId,
      payload: { accountLogin: row.accountLogin, accountType: row.accountType },
    });
  }

  /** Os repositórios da instalação, buscados na hora. A ligação local nunca é apagada por aqui. */
  async listInstallationRepositories(tenant: TenantRunner, principal: Principal) {
    this.authorization.listInstallationRepositories(principal.actor);
    const row = await tenant.run((tx, current) => tx.githubInstallation.findFirst({ where: { orgId: current.organization.orgId } }));
    if (!row) throw notConnected();
    const repositories = await this.fetchRepositories(Number(row.installationId));
    return repositories.map((item) => parseOutput(providerRepositoryOutput, item));
  }

  private async fetchRepositories(installationId: number): Promise<ProviderRepository[]> {
    await this.usableInstallation(installationId);
    return this.call("listRepositories", () => this.provider.listRepositories(installationId));
  }

  async linkedRepositories(tx: TenantClient, orgId: string, projectId: string): Promise<LinkedRepository[]> {
    const rows = await tx.projectRepository.findMany({ where: { orgId, projectId }, orderBy: [{ fullName: "asc" }, { id: "asc" }] });
    return rows.map((row) => this.toLinked(row));
  }

  private toLinked(row: RepositoryRow): LinkedRepository {
    return parseOutput(linkedRepositoryOutput, {
      id: row.id,
      repoId: Number(row.repoId),
      fullName: row.fullName,
      private: row.private,
      htmlUrl: row.htmlUrl,
      defaultBranch: row.defaultBranch,
      linkedAt: row.createdAt.toISOString(),
    });
  }

  /**
   * Liga um repositório a um projeto. A pertença à instalação é conferida buscando a lista na hora, fora de
   * transação; as escritas conferem de novo o papel e o projeto na transação que grava.
   */
  async linkRepository(
    tenant: TenantRunner,
    projectId: string,
    repoId: number,
    findProject: (tx: TenantClient, principal: Principal) => Promise<{ archivedAt: Date | null }>,
  ): Promise<LinkedRepository> {
    const installation = await tenant.run(async (tx, current) => {
      const project = await findProject(tx, current);
      this.authorization.linkRepository(current.actor, projectId);
      if (project.archivedAt) throw archived();
      const row = await tx.githubInstallation.findFirst({ where: { orgId: current.organization.orgId } });
      if (!row) throw notConnected();
      return row;
    });

    const repositories = await this.fetchRepositories(Number(installation.installationId));
    const found = repositories.find((item) => item.repoId === repoId);
    if (!found) throw new NotFoundException({ code: "repository_not_found", message: "Este repositório não está na instalação do GitHub." });

    return tenant.run(async (tx, current) => {
      const project = await findProject(tx, current);
      this.authorization.linkRepository(current.actor, projectId);
      if (project.archivedAt) throw archived();
      const orgId = current.organization.orgId;
      if (!(await tx.githubInstallation.findFirst({ where: { orgId, id: installation.id } }))) throw notConnected();
      const row = await orConflict("repository_already_linked", "Este repositório já está ligado ao projeto.", () =>
        tx.projectRepository.create({
          data: {
            orgId,
            projectId,
            installationRowId: installation.id,
            repoId: BigInt(found.repoId),
            fullName: found.fullName,
            htmlUrl: found.htmlUrl,
            private: found.private,
            defaultBranch: found.defaultBranch,
            linkedByPersonId: current.person.id,
          },
        }),
      );
      await this.activity.record(tx, current, {
        kind: "project.repository_linked",
        subjectType: "project",
        subjectId: projectId,
        payload: { repositoryId: row.id, fullName: row.fullName, private: row.private },
      });
      return this.toLinked(row);
    });
  }

  async unlinkRepository(tx: TenantClient, principal: Principal, project: { archivedAt: Date | null }, projectId: string, repositoryId: string): Promise<void> {
    this.authorization.linkRepository(principal.actor, projectId);
    if (project.archivedAt) throw archived();
    const orgId = principal.organization.orgId;
    const row = await tx.projectRepository.findFirst({ where: { orgId, projectId, id: repositoryId } });
    if (!row) throw new NotFoundException({ code: "repository_not_found", message: "Repositório não ligado ao projeto." });
    await tx.projectRepository.delete({ where: { orgId_id: { orgId, id: row.id } } });
    await this.activity.record(tx, principal, {
      kind: "project.repository_unlinked",
      subjectType: "project",
      subjectId: projectId,
      payload: { repositoryId: row.id, fullName: row.fullName },
    });
  }
}

function archived(): ConflictException {
  return new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
}
