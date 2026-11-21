import { vi } from "vitest";
import type { ApiClient, ApiResult, Area, CodeLink, CodeRefresh, ConversationDetail, GithubInstallation, GroupSummary, GithubRepository, Me, Person, PlacementOutcome, Project, ProjectRepository, Team, TicketCode, TicketDetail, TicketStatus, TicketSummary } from "../api/client.js";

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export const failed = (kind: "unavailable" | "forbidden" | "unauthenticated" | "not_found" | "conflict" | "invalid" | "server_error", code?: string): ApiResult<never> => ({
  ok: false,
  error: code === undefined ? { kind } : { kind, code },
});

export function makeMe(overrides: { clerk?: "admin" | "member"; orgId?: string; orgName?: string; assistant?: boolean; github?: boolean } = {}): Me {
  return {
    ...(overrides.assistant === undefined ? {} : { assistant: { enabled: overrides.assistant } }),
    ...(overrides.github === undefined ? {} : { github: { enabled: overrides.github } }),
    person: { id: "person-1", displayName: "Ana", email: "ana@example.com", avatarUrl: null },
    organization: { orgId: overrides.orgId ?? "org-1", name: overrides.orgName ?? "Equipe Alfa", slug: "alfa" },
    roles: { clerk: overrides.clerk ?? "admin", teams: [], projects: [] },
  };
}

export function makePerson(id: string, displayName: string, extra: Partial<Person> = {}): Person {
  return { id, displayName, email: `${id}@example.com`, avatarUrl: null, clerkRole: "member", active: true, ...extra };
}

export function makeProject(id: string, key: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, key, name, visibility: "organization", archivedAt: null, members: [], teamIds: [], ...extra };
}

export function makeTicket(id: string, projectId: string, number: number, title: string, extra: Partial<TicketSummary> = {}): TicketSummary {
  const key = extra.key ?? `${projectId.toUpperCase()}-${number}`;
  return { id, projectId, number, key, parentId: null, title, kind: "ticket", status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", ...extra };
}

/** Agrupador (ADR 0031): sem situação própria e com progresso sempre presente (vazio é 0 de 0). */
export function makeGroup(id: string, projectId: string, number: number, title: string, extra: Partial<TicketSummary> = {}): TicketSummary {
  return makeTicket(id, projectId, number, title, { kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 }, ...extra });
}

/** Conversa de criação com a IA (ADR 0029): uma troca de mensagens e, por padrão, um rascunho. */
export function makeConversation(id: string, projectId: string, extra: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id,
    projectId,
    status: "open",
    draft: { title: "Corrigir o login", description: "O login falha no Safari." },
    ready: true,
    createdTicketId: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    messages: [
      { id: `${id}-m1`, author: "person", body: "O login quebra no Safari", model: null, createdAt: "2026-11-20T10:00:00.000Z" },
      { id: `${id}-m2`, author: "assistant", body: "Entendi. Isso acontece em todas as versões?", model: "claude-opus-5-5", createdAt: "2026-11-20T10:00:05.000Z" },
    ],
    ...extra,
  };
}

export function makePlacement(extra: Partial<PlacementOutcome> = {}): PlacementOutcome {
  return { destination: { parentId: null, path: [] }, alternatives: [], discarded: [], uncertain: false, stoppedEarly: null, scope: null, groupProposal: null, groupProposalSkipped: null, ...extra };
}

interface FakeData {
  me?: Me;
  projects?: Project[];
  areas?: Area[];
  teams?: Team[];
  people?: Person[];
  /** Tickets por ID de projeto, na ordem da listagem. */
  tickets?: Record<string, TicketSummary[]>;
  /** Liga as rotas do GitHub (ADR 0032) com as regras do contrato; sem isso elas lançam, como o resto. */
  github?: FakeGithub;
  /** Liga as rotas de "O que entra aqui" (ADR 0033) com as regras do contrato; sem isso elas lançam, como o resto. */
  summaries?: FakeSummaries;
}

export interface FakeSummaries {
  /** Texto guardado por ID de agrupador; sem entrada, o agrupador está sem texto. */
  texts?: Record<string, NonNullable<GroupSummary["summary"]>>;
  /** O que `POST …/summary/regenerate` escreve quando dá certo. */
  regenerated?: string;
  /** Falso: o provedor da IA não responde (503 `assistant_unavailable`) em `regenerate`. */
  providerUp?: boolean;
  /** Instante gravado em `updatedAt` pelas escritas. */
  now?: string;
}

export interface FakeGithub {
  /** Falso: toda rota responde 404 `github_disabled`. */
  enabled?: boolean;
  /** Instalação da organização; `null` é "não ligada". */
  installation?: GithubInstallation | null;
  /** Repositórios que o app enxerga. */
  repositories?: GithubRepository[];
  /** Repositórios já ligados, por ID de projeto. */
  linked?: Record<string, ProjectRepository[]>;
  /** Vínculos de código por ID de ticket (e de agrupador, que já traz os dos filhos). */
  code?: Record<string, { links: CodeLink[]; syncedAt?: string | null }>;
  /** O que `POST /github/connect/complete` instala quando dá certo. */
  pendingInstallation?: GithubInstallation;
  /** Erro de `POST /github/connect/complete`, no formato `[tipo, código]`. */
  completeError?: [Parameters<typeof failed>[0], string?];
  /** O GitHub não enxerga a instalação (409 `installation_unavailable` nas rotas de repositório). */
  installationUnavailable?: boolean;
  /** Resultado de `POST /projects/:id/code/refresh`; o padrão é tudo `ok`. */
  refresh?: CodeRefresh | ApiResult<never>;
  /** URL devolvida por `POST /github/connect`. */
  connectUrl?: string;
}

export const makeInstallation = (extra: Partial<GithubInstallation> = {}): GithubInstallation => ({
  accountLogin: "herzog0",
  accountType: "User",
  repositorySelection: "all",
  connectedAt: "2026-11-20T15:00:00.000Z",
  ...extra,
});

export const makeGithubRepository = (repoId: number, fullName: string, extra: Partial<GithubRepository> = {}): GithubRepository => ({
  repoId,
  fullName,
  private: false,
  htmlUrl: `https://github.com/${fullName}`,
  defaultBranch: "main",
  ...extra,
});

export function makeCodeLink(id: string, ticket: { id: string; key: string; title: string }, extra: Partial<CodeLink> = {}): CodeLink {
  const repository = extra.repository ?? { fullName: "herzog0/treepm", htmlUrl: "https://github.com/herzog0/treepm" };
  return {
    id,
    kind: "pull_request",
    ticket,
    repository,
    ref: "feat/login",
    number: 12,
    title: "Corrige o login",
    state: "open",
    url: `${repository.htmlUrl}/pull/12`,
    updatedAt: "2026-11-21T10:00:00.000Z",
    ...extra,
  };
}

const GITHUB_NAMES = [
  "getGithubInstallation", "connectGithub", "completeGithubConnection", "disconnectGithub", "listGithubRepositories",
  "listProjectRepositories", "linkProjectRepository", "unlinkProjectRepository", "refreshProjectCode", "getTicketCode",
] as const;

/**
 * As rotas do GitHub do contrato da ADR 0032, em memória: papéis (administrador da organização, gestor do projeto),
 * códigos de erro e o estado ligado/desligado. As chamadas continuam espiáveis (`vi.fn`).
 */
function githubMethods(data: FakeData): Partial<ApiClient> {
  const github = data.github!;
  const me = data.me ?? makeMe();
  const disabled = () => github.enabled === false;
  const gone = () => failed("not_found", "github_disabled");
  const isAdmin = me.roles.clerk === "admin";
  const managerOf = (projectId: string) => me.roles.projects.some((entry) => entry.projectId === projectId && entry.role === "manager");
  const canLink = (projectId: string) => isAdmin || managerOf(projectId);
  let installation = github.installation ?? null;
  const linked = new Map<string, ProjectRepository[]>(Object.entries(github.linked ?? {}).map(([id, list]) => [id, [...list]]));
  const code = new Map(Object.entries(github.code ?? {}));
  let sequence = 0;
  const archived = (projectId: string) => data.projects?.find((entry) => entry.id === projectId)?.archivedAt != null;
  const unavailable = () => (installation === null ? failed("conflict", "not_connected") : github.installationUnavailable ? failed("conflict", "installation_unavailable") : null);

  return {
    getGithubInstallation: vi.fn(async () => (disabled() ? gone() : ok({ installation }))),
    connectGithub: vi.fn(async () => {
      if (disabled()) return gone();
      if (!isAdmin) return failed("forbidden");
      return ok({ url: github.connectUrl ?? "https://github.com/apps/treepm-dev/installations/new?state=abc" });
    }),
    completeGithubConnection: vi.fn(async () => {
      if (disabled()) return gone();
      if (!isAdmin) return failed("forbidden");
      if (github.completeError) return failed(...github.completeError);
      if (installation !== null) return failed("conflict", "already_connected");
      installation = github.pendingInstallation ?? makeInstallation();
      return ok({ installation });
    }),
    disconnectGithub: vi.fn(async () => {
      if (disabled()) return gone();
      if (!isAdmin) return failed("forbidden");
      if (installation === null) return failed("not_found", "not_connected");
      installation = null;
      linked.clear();
      code.clear();
      return ok(undefined);
    }),
    listGithubRepositories: vi.fn(async () => {
      if (disabled()) return gone();
      if (!isAdmin && me.roles.projects.every((entry) => entry.role !== "manager")) return failed("forbidden");
      return unavailable() ?? ok((github.repositories ?? []).map((entry) => ({ ...entry })));
    }),
    listProjectRepositories: vi.fn(async (projectId: string) => (disabled() ? gone() : ok((linked.get(projectId) ?? []).map((entry) => ({ ...entry }))))),
    linkProjectRepository: vi.fn(async (projectId: string, body: { repoId: number }) => {
      if (disabled()) return gone();
      if (!canLink(projectId)) return failed("forbidden");
      if (archived(projectId)) return failed("conflict", "project_archived");
      const problem = unavailable();
      if (problem) return problem;
      const found = (github.repositories ?? []).find((entry) => entry.repoId === body.repoId);
      if (!found) return failed("not_found", "repository_not_found");
      const list = linked.get(projectId) ?? [];
      if (list.some((entry) => entry.repoId === body.repoId)) return failed("conflict", "repository_already_linked");
      const entry: ProjectRepository = { ...found, id: `link-${++sequence}`, linkedAt: "2026-11-21T12:00:00.000Z" };
      linked.set(projectId, [...list, entry]);
      return ok(entry);
    }),
    unlinkProjectRepository: vi.fn(async (projectId: string, repositoryId: string) => {
      if (disabled()) return gone();
      if (!canLink(projectId)) return failed("forbidden");
      if (archived(projectId)) return failed("conflict", "project_archived");
      linked.set(projectId, (linked.get(projectId) ?? []).filter((entry) => entry.id !== repositoryId));
      return ok(undefined);
    }),
    refreshProjectCode: vi.fn(async (projectId: string) => {
      if (disabled()) return gone();
      if (archived(projectId)) return failed("conflict", "project_archived");
      if (installation === null) return failed("conflict", "not_connected");
      if (github.refresh && "ok" in github.refresh) return github.refresh;
      const result: CodeRefresh = github.refresh ?? {
        refreshed: true,
        syncedAt: "2026-11-21T12:00:00.000Z",
        repositories: (linked.get(projectId) ?? []).map((entry) => ({ id: entry.id, fullName: entry.fullName, status: "ok" as const })),
      };
      for (const [id, entry] of code) code.set(id, { ...entry, syncedAt: result.syncedAt });
      return ok(result);
    }),
    getTicketCode: vi.fn(async (id: string): Promise<ApiResult<TicketCode>> => {
      if (disabled()) return gone();
      const entry = code.get(id);
      const repositories = [...linked.values()].reduce((count, list) => count + list.length, 0);
      return ok({ repositories, syncedAt: entry?.syncedAt ?? null, links: (entry?.links ?? []).map((link) => ({ ...link })) });
    }),
  };
}

const SUMMARY_NAMES = ["getTicketSummary", "putTicketSummary", "regenerateTicketSummary"] as const;
export const SUMMARY_MAX = 1000;

/**
 * As rotas de "O que entra aqui" do contrato da ADR 0033, em memória: leitura para quem vê o projeto; gravar e pedir
 * à IA só para quem edita (administrador, gestor ou colaborador) e fora de projeto arquivado; 409 `not_a_group`,
 * 409 `group_empty`, 400 `validation_error` (de 1 a 1.000 caracteres) e a origem (`person` ao gravar, `assistant`
 * ao pedir) com a data. As chamadas continuam espiáveis (`vi.fn`).
 */
function summaryMethods(data: FakeData): Partial<ApiClient> {
  const config = data.summaries!;
  const me = data.me ?? makeMe();
  const all = Object.values(data.tickets ?? {}).flat();
  const texts = new Map(Object.entries(config.texts ?? {}));
  const now = () => config.now ?? "2026-11-21T12:00:00.000Z";
  const find = (id: string) => all.find((entry) => entry.id === id);
  const canEdit = (projectId: string) =>
    me.roles.clerk === "admin" || me.roles.projects.some((entry) => entry.projectId === projectId && (entry.role === "manager" || entry.role === "contributor"));
  const archived = (projectId: string) => data.projects?.find((entry) => entry.id === projectId)?.archivedAt != null;
  const answer = (id: string): ApiResult<GroupSummary> => ok({ summary: texts.has(id) ? { ...texts.get(id)! } : null });
  const writable = (id: string): ApiResult<never> | null => {
    const entry = find(id);
    if (!entry) return failed("not_found");
    if (!canEdit(entry.projectId)) return failed("forbidden");
    if (archived(entry.projectId)) return failed("conflict", "project_archived");
    if (entry.kind !== "group") return failed("conflict", "not_a_group");
    return null;
  };

  return {
    getTicketSummary: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (entry.kind !== "group") return failed("conflict", "not_a_group");
      return answer(id);
    }),
    putTicketSummary: vi.fn(async (id: string, body: { text: string }) => {
      const problem = writable(id);
      if (problem) return problem;
      const text = body.text.trim();
      if (text.length < 1 || text.length > SUMMARY_MAX) return failed("invalid", "validation_error");
      texts.set(id, { text, source: "person", updatedAt: now() });
      return answer(id);
    }),
    regenerateTicketSummary: vi.fn(async (id: string) => {
      const problem = writable(id);
      if (problem) return problem;
      if (!all.some((entry) => entry.parentId === id)) return failed("conflict", "group_empty");
      if (config.providerUp === false) return failed("unavailable", "assistant_unavailable");
      texts.set(id, { text: config.regenerated ?? "Reúne os trabalhos de agora deste agrupador.", source: "assistant", updatedAt: now() });
      return answer(id);
    }),
  };
}

/** Cliente falso: cada método lança se não for configurado, para o teste dizer o que precisa. */
export function makeClient(data: FakeData = {}): ApiClient {
  const unexpected = (name: string) => vi.fn(async () => {
    throw new Error(`chamada inesperada: ${name}`);
  });
  const names = [
    "createTeam", "renameTeam", "removeTeam", "putTeamMember", "removeTeamMember",
    "createArea", "renameArea", "removeArea", "getProject", "createProject", "updateProject",
    "putProjectMember", "removeProjectMember", "putProjectTeam", "removeProjectTeam",
    "getTicket", "createTicket", "updateTicket", "removeTicket", "putTicketAssignee", "removeTicketAssignee",
    "importTickets", "openConversation", "sendConversationMessage", "updateConversationDraft", "findPlacement",
    "createTicketFromConversation", "listConversations", "getConversation", "removeConversation",
    ...GITHUB_NAMES,
    ...SUMMARY_NAMES,
  ] as const;
  const base = Object.fromEntries(names.map((name) => [name, unexpected(name)])) as unknown as ApiClient;
  return {
    ...base,
    getMe: vi.fn(async () => ok(data.me ?? makeMe())),
    listProjects: vi.fn(async () => ok(data.projects ?? [])),
    listAreas: vi.fn(async () => ok(data.areas ?? [])),
    listTeams: vi.fn(async () => ok(data.teams ?? [])),
    listPeople: vi.fn(async () => ok(data.people ?? [])),
    listTickets: vi.fn(async (projectId: string) => ok(data.tickets?.[projectId] ?? [])),
    ...(data.github ? githubMethods(data) : {}),
    ...(data.summaries ? summaryMethods(data) : {}),
  };
}

/**
 * Cliente falso com a árvore de tickets em memória, que respeita o contrato da ADR 0031: o pai tem que ser
 * agrupador (409 `parent_not_group`), agrupador não tem situação (409 `group_has_no_status`), agrupador só vira
 * ticket vazio e só sai se estiver vazio (409 `ticket_has_children`). As chamadas continuam espiáveis (`vi.fn`).
 */
export function makeTreeClient(data: FakeData = {}): ApiClient {
  const base = makeClient(data);
  const all: TicketSummary[] = Object.values(data.tickets ?? {}).flat().map((entry) => ({ ...entry }));
  // A situação guardada de um agrupador, que volta a valer se ele virar ticket de novo (ADR 0031).
  const stored = new Map<string, TicketStatus>();
  const descriptions = new Map<string, string>();
  const find = (id: string) => all.find((entry) => entry.id === id);
  const childrenOf = (id: string) => all.filter((entry) => entry.parentId === id);
  const ticketLeaves = (id: string): TicketSummary[] => childrenOf(id).flatMap((child) => (child.kind === "group" ? ticketLeaves(child.id) : [child]));
  const withProgress = (entry: TicketSummary): TicketSummary => {
    if (entry.kind !== "group") return { ...entry };
    const leaves = ticketLeaves(entry.id);
    const excluded = leaves.filter((leaf) => leaf.status === "cancelled").length;
    return { ...entry, status: null, progress: { done: leaves.filter((leaf) => leaf.status === "done").length, total: leaves.length - excluded, excluded } };
  };
  const detail = (entry: TicketSummary): TicketDetail => ({
    ...withProgress(entry),
    description: descriptions.get(entry.id) ?? "",
    createdByPersonId: "person-1",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });
  const conflict = (code: string) => failed("conflict", code);
  const underTicket = (parentId: string | null) => parentId !== null && find(parentId)?.kind !== "group";

  return {
    ...base,
    listTickets: vi.fn(async (projectId: string) => ok(all.filter((entry) => entry.projectId === projectId).map(withProgress))),
    getTicket: vi.fn(async (id: string) => {
      const entry = find(id);
      return entry ? ok(detail(entry)) : failed("not_found");
    }),
    createTicket: vi.fn(async (projectId, body) => {
      const parentId = body.parentId ?? null;
      if (underTicket(parentId)) return conflict("parent_not_group");
      const number = Math.max(0, ...all.filter((entry) => entry.projectId === projectId).map((entry) => entry.number)) + 1;
      const id = `new-${projectId}-${number}`;
      const entry = body.kind === "group"
        ? makeGroup(id, projectId, number, body.title, { parentId })
        : makeTicket(id, projectId, number, body.title, { parentId, status: body.status ?? "todo" });
      all.push(entry);
      if (body.description) descriptions.set(id, body.description);
      return ok(detail(entry));
    }),
    updateTicket: vi.fn(async (id, body) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (body.status !== undefined && (entry.kind === "group" || body.kind === "group")) return conflict("group_has_no_status");
      if (body.parentId !== undefined) {
        if (underTicket(body.parentId)) return conflict("parent_not_group");
        for (let at = body.parentId; at !== null; at = find(at)?.parentId ?? null) if (at === id) return conflict("ticket_cycle");
      }
      if (body.kind === "ticket" && entry.kind === "group" && childrenOf(id).length > 0) return conflict("ticket_has_children");
      if (body.title !== undefined) entry.title = body.title;
      if (body.description !== undefined) descriptions.set(id, body.description);
      if (body.parentId !== undefined) entry.parentId = body.parentId;
      if (body.status !== undefined) entry.status = body.status;
      if (body.kind === "group" && entry.kind === "ticket") {
        if (entry.status) stored.set(id, entry.status);
        entry.kind = "group";
        entry.status = null;
      } else if (body.kind === "ticket" && entry.kind === "group") {
        entry.kind = "ticket";
        entry.status = stored.get(id) ?? "todo";
        entry.progress = null;
      }
      return ok(detail(entry));
    }),
    removeTicket: vi.fn(async (id: string) => {
      if (!find(id)) return failed("not_found");
      if (childrenOf(id).length > 0) return conflict("ticket_has_children");
      all.splice(all.findIndex((entry) => entry.id === id), 1);
      return ok(undefined);
    }),
  };
}
