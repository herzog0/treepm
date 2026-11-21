import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { ticketNumbersIn } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { codeRefreshOutput, ticketCodeOutput } from "./github.schema.js";
import type { CodeRefresh, TicketCode } from "./github.schema.js";
import { BRANCH_PAGE_CEILING, ProviderUnavailableError, PULL_PAGE_CEILING, REPOSITORY_PROVIDER } from "./ports.js";
import type { BranchItem, PullRequestItem, RepositoryProvider, SyncPage } from "./ports.js";

/** Freio da sincronização (ADR 0032): com todos os repositórios sincronizados há menos disso, o GitHub não é chamado. */
const REFRESH_BRAKE_MS = 30_000;
/** Linhas por comando de gravação em lote. */
const CHUNK = 500;

type Resource = "branches" | "pulls";
type RepositoryStatus = "ok" | "truncated" | "unavailable";
type StoredPage = { resource: string; page: number; etag: string | null; syncedAt: Date };
type RepoRow = { id: string; fullName: string; htmlUrl: string };

/** O que a rede devolveu para um recurso: nada mudou, ou a lista inteira refeita (páginas na ordem). */
type Fetched<T> = { changed: false; truncated: boolean } | { changed: true; truncated: boolean; pages: { etag: string | null; items: T[] }[] };

type Desired = { ticketId: string; ref: string; number: number | null; title: string | null; state: string; url: string; updatedAt: string | null };

const gone = () => new NotFoundException("Projeto não encontrado.");
const archived = () => new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });

function oldest(times: (Date | null)[]): Date | null {
  if (times.length === 0 || times.some((time) => time === null)) return null;
  return new Date(Math.min(...times.map((time) => (time as Date).getTime())));
}

/** A sincronização mais antiga entre os recursos de um repositório; nula se algum recurso nunca foi sincronizado. */
function repositorySyncedAt(pages: StoredPage[]): Date | null {
  if (!pages.some((page) => page.resource === "branches") || !pages.some((page) => page.resource === "pulls")) return null;
  return oldest(pages.map((page) => page.syncedAt));
}

function branchUrl(htmlUrl: string, ref: string): string {
  return `${htmlUrl}/tree/${ref.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Vínculos de código dos tickets (ADR 0032, passo 2). A sincronização é sob demanda, repositório por repositório e
 * em série; nenhuma transação fica aberta durante uma chamada de rede. Nomes de branch e títulos de PR nunca vão
 * para log: uma falha do provedor registra só o nome da classe do erro.
 */
@Injectable()
export class CodeService {
  private readonly logger = new Logger("CodeService");

  constructor(
    @Optional() @Inject(REPOSITORY_PROVIDER) private readonly providerOrNull: RepositoryProvider | null,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  private get provider(): RepositoryProvider {
    if (!this.providerOrNull) throw new Error("Provedor de repositórios ausente com o GitHub ligado.");
    return this.providerOrNull;
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async visibleProject(tx: TenantClient, principal: Principal, projectId: string) {
    const project = await tx.project.findFirst({ where: { orgId: principal.organization.orgId, id: projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw gone();
    return project;
  }

  async refresh(tenant: TenantRunner, projectId: string): Promise<CodeRefresh> {
    const snapshot = await tenant.run(async (tx, principal) => {
      const orgId = principal.organization.orgId;
      const project = await this.visibleProject(tx, principal, projectId);
      if (project.archivedAt) throw archived();
      const installation = await tx.githubInstallation.findFirst({ where: { orgId } });
      if (!installation) throw new ConflictException({ code: "not_connected", message: "A organização não está ligada ao GitHub." });
      const repositories = await tx.projectRepository.findMany({ where: { orgId, projectId }, orderBy: [{ fullName: "asc" }, { id: "asc" }] });
      const pages = await tx.repositorySyncPage.findMany({
        where: { orgId, projectRepositoryId: { in: repositories.map((row) => row.id) } },
        orderBy: [{ page: "asc" }],
      });
      return { installationId: Number(installation.installationId), repositories, pages };
    });

    const stored = new Map<string, StoredPage[]>();
    for (const page of snapshot.pages) stored.set(page.projectRepositoryId, [...(stored.get(page.projectRepositoryId) ?? []), page]);
    const pagesOf = (repositoryId: string, resource: Resource) => (stored.get(repositoryId) ?? []).filter((page) => page.resource === resource);
    const ceilingOf = (resource: Resource) => (resource === "branches" ? BRANCH_PAGE_CEILING : PULL_PAGE_CEILING);
    const storedStatus = (repositoryId: string): RepositoryStatus =>
      (["branches", "pulls"] as const).some((resource) => pagesOf(repositoryId, resource).length >= ceilingOf(resource)) ? "truncated" : "ok";

    const syncedAt = new Map<string, Date | null>(snapshot.repositories.map((row) => [row.id, repositorySyncedAt(stored.get(row.id) ?? [])]));
    const summary = (refreshed: boolean, statuses: Map<string, RepositoryStatus>): CodeRefresh =>
      parseOutput(codeRefreshOutput, {
        refreshed,
        syncedAt: oldest(snapshot.repositories.map((row) => syncedAt.get(row.id) ?? null))?.toISOString() ?? null,
        repositories: snapshot.repositories.map((row) => ({ id: row.id, fullName: row.fullName, status: statuses.get(row.id) ?? storedStatus(row.id) })),
      });

    const now = Date.now();
    const braked = snapshot.repositories.length > 0 && snapshot.repositories.every((row) => {
      const at = syncedAt.get(row.id);
      return at != null && now - at.getTime() < REFRESH_BRAKE_MS;
    });
    if (snapshot.repositories.length === 0 || braked) return summary(false, new Map());

    const statuses = new Map<string, RepositoryStatus>();
    for (const repository of snapshot.repositories) {
      let branches: Fetched<BranchItem>;
      let pulls: Fetched<PullRequestItem>;
      try {
        branches = await this.fetchResource(
          (etags) => this.provider.listBranches(snapshot.installationId, repository.fullName, etags),
          pagesOf(repository.id, "branches"),
          BRANCH_PAGE_CEILING,
        );
        pulls = await this.fetchResource(
          (etags) => this.provider.listPullRequests(snapshot.installationId, repository.fullName, etags),
          pagesOf(repository.id, "pulls"),
          PULL_PAGE_CEILING,
        );
      } catch (error) {
        // Só o nome da classe: a mensagem e o corpo do GitHub podem trazer nomes de branch e títulos de PR.
        this.logger.warn(`Falha do provedor de repositórios ao sincronizar: ${error instanceof Error ? error.name : "erro desconhecido"}.`);
        statuses.set(repository.id, "unavailable");
        continue;
      }
      const written = await tenant.run((tx, principal) => this.write(tx, principal, projectId, repository, branches, pulls));
      if (written === null) {
        // O repositório foi desligado do projeto durante a chamada: some do resultado.
        syncedAt.delete(repository.id);
        continue;
      }
      syncedAt.set(repository.id, written);
      statuses.set(repository.id, branches.truncated || pulls.truncated ? "truncated" : "ok");
    }
    const present = snapshot.repositories.filter((row) => syncedAt.has(row.id));
    return parseOutput(codeRefreshOutput, {
      refreshed: true,
      syncedAt: oldest(present.map((row) => syncedAt.get(row.id) ?? null))?.toISOString() ?? null,
      repositories: present.map((row) => ({ id: row.id, fullName: row.fullName, status: statuses.get(row.id) ?? storedStatus(row.id) })),
    });
  }

  /**
   * Um recurso de um repositório. Com páginas guardadas, pede cada uma com o ETag; só `304` em todas (e na última
   * sem próxima) é "nada mudou". Qualquer `200`, página a mais ou a menos refaz o recurso inteiro sem condicional.
   */
  private async fetchResource<T>(list: (etags: readonly (string | null)[]) => Promise<SyncPage<T>[]>, stored: StoredPage[], ceiling: number): Promise<Fetched<T>> {
    const etags: (string | null)[] = [];
    for (const page of stored) etags[page.page - 1] = page.etag;
    for (let index = 0; index < etags.length; index += 1) etags[index] ??= null;

    const fresh = (pages: SyncPage<T>[]): Fetched<T> => {
      const items: { etag: string | null; items: T[] }[] = [];
      for (const page of pages) {
        // Sem condicional o GitHub nunca responde 304; se responder, a lista está incompleta.
        if (page.notModified) throw new ProviderUnavailableError();
        items.push({ etag: page.etag, items: page.items });
      }
      const last = pages[pages.length - 1];
      return { changed: true, truncated: pages.length >= ceiling && last !== undefined && !last.notModified && last.hasNext, pages: items };
    };

    const first = await list(etags);
    if (etags.length > 0) {
      if (first.length === etags.length && first.every((page) => page.notModified)) return { changed: false, truncated: etags.length >= ceiling };
      if (first.every((page) => !page.notModified)) return fresh(first);
      return fresh(await list([]));
    }
    return fresh(first);
  }

  /** Grava um repositório numa transação curta; devolve o instante gravado, ou `null` se o repositório já não é do projeto. */
  private async write(
    tx: TenantClient,
    principal: Principal,
    projectId: string,
    repository: RepoRow,
    branches: Fetched<BranchItem>,
    pulls: Fetched<PullRequestItem>,
  ): Promise<Date | null> {
    const orgId = principal.organization.orgId;
    const project = await this.visibleProject(tx, principal, projectId);
    if (project.archivedAt) throw archived();
    // Serializa as gravações do mesmo repositório (duas atualizações ao mesmo tempo) e confirma que ele segue ligado.
    const locked = await tx.$queryRaw<{ id: string }[]>`select id from project_repositories where org_id = ${orgId} and project_id = ${projectId}::uuid and id = ${repository.id}::uuid for update`;
    if (locked.length === 0) return null;

    const now = new Date();
    const tickets = new Map<number, string>();
    if (branches.changed || pulls.changed) {
      for (const ticket of await tx.ticket.findMany({ where: { orgId, projectId }, select: { id: true, number: true } })) tickets.set(ticket.number, ticket.id);
    }
    const idsFor = (...texts: string[]) => [...new Set(texts.flatMap((text) => ticketNumbersIn(text, project.key)))].sort((a, b) => a - b).flatMap((number) => tickets.get(number) ?? []);

    if (branches.changed) {
      const desired: Desired[] = [];
      for (const page of branches.pages) {
        for (const item of page.items) {
          for (const ticketId of idsFor(item.name)) {
            desired.push({ ticketId, ref: item.name, number: null, title: null, state: "active", url: branchUrl(repository.htmlUrl, item.name), updatedAt: null });
          }
        }
      }
      await this.reconcile(tx, orgId, projectId, repository.id, "branch", desired, now);
    }
    if (pulls.changed) {
      const desired: Desired[] = [];
      for (const page of pulls.pages) {
        for (const item of page.items) {
          for (const ticketId of idsFor(item.title, item.headRef)) {
            desired.push({ ticketId, ref: item.headRef, number: item.number, title: item.title, state: item.state, url: item.url, updatedAt: item.updatedAt });
          }
        }
      }
      await this.reconcile(tx, orgId, projectId, repository.id, "pull_request", desired, now);
    }
    await this.storePages(tx, orgId, repository.id, "branches", branches, now);
    await this.storePages(tx, orgId, repository.id, "pulls", pulls, now);
    return now;
  }

  /** Grava os ETags novos e apaga as páginas guardadas que deixaram de existir; sem mudança, só renova `synced_at`. */
  private async storePages<T>(tx: TenantClient, orgId: string, repositoryId: string, resource: Resource, fetched: Fetched<T>, now: Date): Promise<void> {
    if (!fetched.changed) {
      await tx.repositorySyncPage.updateMany({ where: { orgId, projectRepositoryId: repositoryId, resource }, data: { syncedAt: now } });
      return;
    }
    for (const [index, page] of fetched.pages.entries()) {
      const key = { orgId, projectRepositoryId: repositoryId, resource, page: index + 1 };
      await tx.repositorySyncPage.upsert({
        where: { orgId_projectRepositoryId_resource_page: key },
        create: { ...key, etag: page.etag, syncedAt: now },
        update: { etag: page.etag, syncedAt: now },
      });
    }
    await tx.repositorySyncPage.deleteMany({ where: { orgId, projectRepositoryId: repositoryId, resource, page: { gt: fetched.pages.length } } });
  }

  /** Insere ou atualiza os vínculos encontrados e remove os do repositório e do tipo que não apareceram. */
  private async reconcile(tx: TenantClient, orgId: string, projectId: string, repositoryId: string, kind: "branch" | "pull_request", desired: Desired[], seenAt: Date): Promise<void> {
    const keyOf = (item: { ticketId: string; ref: string; number: number | null }) => (kind === "branch" ? `${item.ticketId}|${item.ref}` : `${item.ticketId}|${item.number}`);
    const keep = new Set(desired.map(keyOf));
    const existing = await tx.ticketCodeLink.findMany({ where: { orgId, projectRepositoryId: repositoryId, kind }, select: { id: true, ticketId: true, ref: true, number: true } });
    const stale = existing.filter((row) => !keep.has(keyOf(row))).map((row) => row.id);
    for (let start = 0; start < stale.length; start += CHUNK) {
      await tx.ticketCodeLink.deleteMany({ where: { orgId, id: { in: stale.slice(start, start + CHUNK) } } });
    }
    const seen = seenAt.toISOString();
    for (let start = 0; start < desired.length; start += CHUNK) {
      const chunk = desired.slice(start, start + CHUNK);
      const ticketIds = chunk.map((item) => item.ticketId);
      const refs = chunk.map((item) => item.ref);
      const urls = chunk.map((item) => item.url);
      if (kind === "branch") {
        await tx.$executeRaw`
          insert into ticket_code_links (org_id, project_id, ticket_id, project_repository_id, kind, ref, state, url, seen_at)
          select ${orgId}, ${projectId}::uuid, t.ticket_id, ${repositoryId}::uuid, 'branch', t.ref, 'active', t.url, ${seen}::timestamptz
          from unnest(${ticketIds}::uuid[], ${refs}::text[], ${urls}::text[]) as t(ticket_id, ref, url)
          on conflict (org_id, project_repository_id, ticket_id, kind, ref) where kind = 'branch'
          do update set url = excluded.url, seen_at = excluded.seen_at`;
      } else {
        const numbers = chunk.map((item) => item.number);
        const titles = chunk.map((item) => item.title);
        const states = chunk.map((item) => item.state);
        const updated = chunk.map((item) => item.updatedAt);
        await tx.$executeRaw`
          insert into ticket_code_links (org_id, project_id, ticket_id, project_repository_id, kind, ref, number, title, state, url, provider_updated_at, seen_at)
          select ${orgId}, ${projectId}::uuid, t.ticket_id, ${repositoryId}::uuid, 'pull_request', t.ref, t.number, t.title, t.state, t.url, t.updated_at::timestamptz, ${seen}::timestamptz
          from unnest(${ticketIds}::uuid[], ${refs}::text[], ${numbers}::int[], ${titles}::text[], ${states}::text[], ${urls}::text[], ${updated}::text[]) as t(ticket_id, ref, number, title, state, url, updated_at)
          on conflict (org_id, project_repository_id, ticket_id, number) where kind = 'pull_request'
          do update set ref = excluded.ref, title = excluded.title, state = excluded.state, url = excluded.url,
                        provider_updated_at = excluded.provider_updated_at, seen_at = excluded.seen_at`;
      }
    }
  }

  /** `GET /api/tickets/:id/code`: só lê o banco. Agrupador traz os vínculos dele e os de todos os descendentes. */
  async read(tx: TenantClient, principal: Principal, ticketId: string): Promise<TicketCode> {
    const orgId = principal.organization.orgId;
    const ticket = await tx.ticket.findFirst({ where: { orgId, id: ticketId } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { orgId, id: ticket.projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");

    const family = new Map<string, { id: string; number: number; title: string }>([[ticket.id, ticket]]);
    if (ticket.kind === "group") {
      const all = await tx.ticket.findMany({ where: { orgId, projectId: project.id }, select: { id: true, parentId: true, number: true, title: true } });
      const children = new Map<string, typeof all>();
      for (const row of all) if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
      const queue = [ticket.id];
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        for (const child of children.get(id) ?? []) {
          family.set(child.id, child);
          queue.push(child.id);
        }
      }
    }

    const [rows, repositories, pages] = await Promise.all([
      tx.ticketCodeLink.findMany({
        where: { orgId, ticketId: { in: [...family.keys()] } },
        include: { repository: { select: { fullName: true, htmlUrl: true } } },
      }),
      tx.projectRepository.findMany({ where: { orgId, projectId: project.id }, select: { id: true } }),
      tx.repositorySyncPage.findMany({ where: { orgId, repository: { projectId: project.id } } }),
    ]);

    const rank = (kind: string, state: string) => (kind === "pull_request" && state === "open" ? 0 : kind === "branch" ? 1 : state === "merged" ? 2 : 3);
    const numberOf = (id: string) => family.get(id)?.number ?? 0;
    rows.sort((a, b) => {
      const byRank = rank(a.kind, a.state) - rank(b.kind, b.state);
      if (byRank !== 0) return byRank;
      if (a.kind === "branch") {
        return a.ref.localeCompare(b.ref) || a.repository.fullName.localeCompare(b.repository.fullName) || numberOf(a.ticketId) - numberOf(b.ticketId);
      }
      const byDate = (b.providerUpdatedAt?.getTime() ?? 0) - (a.providerUpdatedAt?.getTime() ?? 0);
      return byDate || (b.number ?? 0) - (a.number ?? 0) || a.repository.fullName.localeCompare(b.repository.fullName) || numberOf(a.ticketId) - numberOf(b.ticketId);
    });

    const byRepository = new Map<string, StoredPage[]>();
    for (const page of pages) byRepository.set(page.projectRepositoryId, [...(byRepository.get(page.projectRepositoryId) ?? []), page]);
    return parseOutput(ticketCodeOutput, {
      repositories: repositories.length,
      syncedAt: oldest(repositories.map((row) => repositorySyncedAt(byRepository.get(row.id) ?? [])))?.toISOString() ?? null,
      links: rows.map((row) => {
        const owner = family.get(row.ticketId);
        return {
          id: row.id,
          kind: row.kind,
          ticket: { id: row.ticketId, key: `${project.key}-${owner?.number ?? 0}`, title: owner?.title ?? "" },
          repository: { fullName: row.repository.fullName, htmlUrl: row.repository.htmlUrl },
          ref: row.ref,
          number: row.number,
          title: row.title,
          state: row.state,
          url: row.url,
          updatedAt: row.providerUpdatedAt?.toISOString() ?? null,
        };
      }),
    });
  }
}
