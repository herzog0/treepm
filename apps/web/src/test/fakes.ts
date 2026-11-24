import { vi } from "vitest";
import { createFakeChat } from "./chatFakes.js";
import type { FakeChat } from "./chatFakes.js";
import type { AccessToken, ActivityPage, AiConsent, AiConsentKind, ApiClient, ApiResult, Area, OrganizationAccessToken, CodeLink, CodeRefresh, ConversationDetail, ConversationDraftChild, GithubInstallation, GroupSummary, GithubRepository, Me, Person, PlacementOutcome, Project, ProjectRepository, Team, TicketCode, TicketDetail, IdeaStage, TicketListUpdate, TicketSummary } from "../api/client.js";

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export { createFakeChat };
export type { FakeChat };
export const failed = (kind: "unavailable" | "forbidden" | "unauthenticated" | "not_found" | "conflict" | "invalid" | "server_error", code?: string, keys?: string[]): ApiResult<never> => ({
  ok: false,
  error: { kind, ...(code === undefined ? {} : { code }), ...(keys === undefined ? {} : { keys }) },
});

/** `assistant`: o servidor tem a IA configurada; `consent` (padrão: aceito): a organização aceitou o uso (ADR 0039). */
export function makeMe(overrides: { clerk?: "admin" | "member"; orgId?: string; orgName?: string; assistant?: boolean; consent?: boolean; github?: boolean; mcp?: boolean; mcpWrite?: boolean; personId?: string; displayName?: string; actingAs?: string } = {}): Me {
  const consent = overrides.consent ?? true;
  return {
    ...(overrides.mcp === undefined ? {} : { mcp: { enabled: overrides.mcp, ...(overrides.mcpWrite === undefined ? {} : { writeEnabled: overrides.mcpWrite }) } }),
    ...(overrides.assistant === undefined ? {} : { assistant: { enabled: overrides.assistant && consent, configured: overrides.assistant, consent } }),
    ...(overrides.actingAs === undefined ? {} : { actingAs: { realDisplayName: overrides.actingAs } }),
    ...(overrides.github === undefined ? {} : { github: { enabled: overrides.github } }),
    person: { id: overrides.personId ?? "person-1", displayName: overrides.displayName ?? "Ana", email: "ana@example.com", avatarUrl: null },
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
  return { id, projectId, number, key, parentId: null, title, status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", priority: 0, blocked: false, ...extra };
}

/** Conversa de criação com a IA (ADR 0029): uma troca de mensagens e, por padrão, um rascunho. */
type DraftExtra = { title: string; description: string; children?: ConversationDraftChild[]; idea?: boolean };
export function makeConversation(id: string, projectId: string, extra: Omit<Partial<ConversationDetail>, "draft"> & { draft?: DraftExtra | null } = {}): ConversationDetail {
  const { draft = { title: "Corrigir o login", description: "O login falha no Safari." }, ...rest } = extra;
  return {
    id,
    projectId,
    status: "open",
    draft: draft === null ? null : { ...draft, children: draft.children ?? [], idea: draft.idea ?? false },
    ready: true,
    createdTicketId: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    messages: [
      { id: `${id}-m1`, author: "person", body: "O login quebra no Safari", model: null, createdAt: "2026-11-20T10:00:00.000Z" },
      { id: `${id}-m2`, author: "assistant", body: "Entendi. Isso acontece em todas as versões?", model: "claude-opus-5-5", createdAt: "2026-11-20T10:00:05.000Z" },
    ],
    ...rest,
  };
}

export function makePlacement(extra: Partial<PlacementOutcome> = {}): PlacementOutcome {
  return { question: null, destinationConfirmed: true, destination: { parentId: null, path: [] }, alternatives: [], discarded: [], uncertain: false, stoppedEarly: null, scope: null, groupProposal: null, groupProposalSkipped: null, related: [], duplicate: null, ...extra };
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
  /** Liga as rotas de tokens de acesso por MCP (ADR 0038) com as regras do contrato; sem isso elas lançam, como o resto. */
  mcp?: FakeMcp;
  /** Liga as rotas do aceite da organização para a IA (ADR 0039) com as regras do contrato; sem isso elas lançam, como o resto. */
  aiConsent?: FakeAiConsent;
  /** Quem lê pode encerrar o marcador de trabalho pela IA (`canEndAgentWork` do detalhe; padrão: sim). Só o cliente em árvore usa. */
  canEndAgentWork?: boolean;
  /** A pessoa do token que ligou o marcador, no detalhe; padrão: Ana. */
  agentWorkBy?: { id: string; displayName: string; avatarUrl: string | null };
  /** Quem lê pode aceitar e descartar ideias (`canTriageIdea` do detalhe; padrão: sim). Só o cliente em árvore usa. */
  canTriageIdea?: boolean;
  /** Quando cada ideia foi registrada (`createdAt` da lista de ideias), por ID do ticket; padrão: 2026-11-20. Só o cliente em árvore usa. */
  ideaCreatedAt?: Record<string, string>;
  /** Conversas de criação com a IA, por ID, para `createTicketFromConversation` do cliente em árvore; sem entrada, o rascunho é o padrão. */
  conversations?: Record<string, ConversationDetail>;
  /** Liga as conversas em níveis (ADR 0055) com as regras do contrato; sem isso, `listConversationTree` devolve a árvore vazia e as outras rotas lançam. */
  chat?: FakeChat;
  /** Quem lê o chat (padrão: a pessoa de `me` do chat falso). */
  chatAs?: string;
}

export interface FakeAiConsent {
  /** Estado inicial; padrão: nada aceito, versão atual `rascunho-2`, GitHub desligado. */
  state?: Partial<AiConsent>;
  /** Faz aceitar/retirar falharem com este tipo e código de erro. */
  changeError?: [Parameters<typeof failed>[0], string?];
}

const NO_CONSENT = { inForce: false, version: null, acceptedBy: null, acceptedAt: null, outdated: false } as const;

/** As rotas do aceite (ADR 0039), em memória: só administrador muda; `code_reading` exige o assistente e o GitHub; retirar o assistente leva a leitura de código. */
function aiConsentMethods(data: FakeData): Partial<ApiClient> {
  const config = data.aiConsent!;
  const me = data.me ?? makeMe();
  const isAdmin = me.roles.clerk === "admin";
  let state: AiConsent = {
    currentVersion: "rascunho-2",
    assistant: { ...NO_CONSENT },
    codeReading: { ...NO_CONSENT, githubConnected: false, offerable: false },
    ...config.state,
  };
  const refresh = () => {
    state = { ...state, codeReading: { ...state.codeReading, offerable: state.codeReading.githubConnected && state.assistant.inForce } };
  };
  refresh();
  const given = () => ({ inForce: true, version: state.currentVersion, acceptedBy: me.person.displayName, acceptedAt: "2026-11-22T12:00:00.000Z", outdated: false });
  return {
    getAiConsent: vi.fn(async () => ok(structuredClone(state))),
    acceptAiConsent: vi.fn(async (kind: AiConsentKind, version: string) => {
      if (!isAdmin) return failed("forbidden");
      if (config.changeError) return failed(...config.changeError);
      if (version !== state.currentVersion) return failed("conflict", "consent_version_changed");
      if (kind === "code_reading") {
        if (!state.assistant.inForce) return failed("conflict", "assistant_consent_required_first");
        if (!state.codeReading.githubConnected) return failed("conflict", "github_not_connected");
        state = { ...state, codeReading: { ...state.codeReading, ...given() } };
      } else {
        state = { ...state, assistant: given() };
      }
      refresh();
      return ok(structuredClone(state));
    }),
    withdrawAiConsent: vi.fn(async (kind: AiConsentKind) => {
      if (!isAdmin) return failed("forbidden");
      if (config.changeError) return failed(...config.changeError);
      state = kind === "assistant"
        ? { ...state, assistant: { ...NO_CONSENT }, codeReading: { ...state.codeReading, ...NO_CONSENT } }
        : { ...state, codeReading: { ...state.codeReading, ...NO_CONSENT } };
      refresh();
      return ok(structuredClone(state));
    }),
  };
}

export interface FakeSummaries {
  /** Texto guardado por ID de ticket; sem entrada, o ticket está sem texto. */
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
  /** Vínculos de código por ID de ticket (o ticket com filhos já traz os dos filhos). */
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

const MCP_NAMES = ["setMcpEnabled", "setMcpWriteEnabled", "createAccessToken", "listAccessTokens", "listOrganizationAccessTokens", "revokeAccessToken"] as const;

export interface FakeMcp {
  /** A chave da organização; padrão: o que `me.mcp` diz. */
  enabled?: boolean;
  /** A chave de escrita da organização (ADR 0043); padrão: o que `me.mcp` diz, ou desligada. */
  writeEnabled?: boolean;
  /** Faz `setMcpWriteEnabled` falhar com este tipo de erro. */
  writeSwitchError?: Parameters<typeof failed>[0];
  /** Tokens da organização, de qualquer pessoa; os da pessoa de `me` saem em `listAccessTokens`. */
  tokens?: OrganizationAccessToken[];
  /** Token inteiro que a criação devolve. */
  secret?: string;
  /** Erro de `createAccessToken` no formato `[tipo, código]`. */
  createError?: [Parameters<typeof failed>[0], string?];
  /** Faz `setMcpEnabled` falhar com este tipo de erro. */
  switchError?: Parameters<typeof failed>[0];
}

/** Referência da organização falsa, em base64url, como no token real (`tpm_<referência>_<segredo>`). */
const FAKE_ORG_REF = btoa("org_EXEMPLO_ficticia").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Segredo falso no formato real: 43 caracteres de base64url; começa pela semente. */
export const fakeSecret = (seed: string): string =>
  (seed.replace(/[^A-Za-z0-9_-]/g, "") + "Q9vXw2Lm8Rt5Yp0aUe7NzHc4BsGfKd3JhTy6WqEr1Ci").slice(0, 43);
/** Token inteiro falso: `tpm_<referência>_<segredo de 43 caracteres>`. */
export const fakeToken = (seed: string): string => `tpm_${FAKE_ORG_REF}_${fakeSecret(seed)}`;
/** O que a API guarda e mostra: os 8 primeiros caracteres do segredo. */
export const prefixOf = (token: string): string => token.slice(-43).slice(0, 8);

export const makeToken = (id: string, name: string, extra: Partial<OrganizationAccessToken> = {}): OrganizationAccessToken => ({
  id,
  name,
  project: { id: "p1", key: "ALFA" },
  tokenPrefix: prefixOf(fakeToken(id)),
  createdAt: "2026-11-10T12:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
  revokedAt: null,
  person: { id: "person-1", displayName: "Ana" },
  ...extra,
});

/** As rotas de MCP do contrato da ADR 0038, em memória: papéis, a chave, o limite de 10 ativos e o token que só a criação devolve. */
function mcpMethods(data: FakeData): Partial<ApiClient> {
  const config = data.mcp!;
  const me = data.me ?? makeMe();
  const isAdmin = me.roles.clerk === "admin";
  let enabled = config.enabled ?? me.mcp?.enabled ?? false;
  let writeEnabled = config.writeEnabled ?? me.mcp?.writeEnabled ?? false;
  const tokens = (config.tokens ?? []).map((entry) => ({ ...entry }));
  const strip = (entry: OrganizationAccessToken): AccessToken => {
    const copy: Partial<OrganizationAccessToken> = { ...entry };
    delete copy.person;
    return copy as AccessToken;
  };
  const active = (entry: OrganizationAccessToken) => entry.revokedAt === null && Date.parse(entry.expiresAt) > Date.now();
  let sequence = 0;

  return {
    setMcpEnabled: vi.fn(async (value: boolean) => {
      if (!isAdmin) return failed("forbidden");
      if (config.switchError) return failed(config.switchError);
      enabled = value;
      return ok({ mcp: { enabled, writeEnabled } });
    }),
    setMcpWriteEnabled: vi.fn(async (value: boolean) => {
      if (!isAdmin) return failed("forbidden");
      if (config.writeSwitchError) return failed(config.writeSwitchError);
      writeEnabled = value;
      return ok({ mcp: { enabled, writeEnabled } });
    }),
    createAccessToken: vi.fn(async (body: { projectId: string; name: string; expiresInDays: 30 | 90 | 365; scope?: "read" | "write" }) => {
      if (!enabled) return failed("forbidden", "mcp_disabled");
      if (config.createError) return failed(...config.createError);
      const project = data.projects?.find((entry) => entry.id === body.projectId);
      if (!project) return failed("not_found");
      if (tokens.filter((entry) => entry.person.id === me.person.id && active(entry)).length >= 10) return failed("conflict", "access_token_limit");
      sequence += 1;
      const entry = makeToken(`new${sequence}`, body.name.trim(), {
        project: { id: project.id, key: project.key },
        scope: body.scope ?? "read",
        person: { id: me.person.id, displayName: me.person.displayName },
        createdAt: "2026-11-21T12:00:00.000Z",
        expiresAt: new Date(Date.parse("2026-11-21T12:00:00.000Z") + body.expiresInDays * 86_400_000).toISOString(),
      });
      const token = config.secret ?? fakeToken(entry.id);
      entry.tokenPrefix = prefixOf(token);
      tokens.push(entry);
      return ok({ ...strip(entry), token });
    }),
    listAccessTokens: vi.fn(async () => {
      if (!enabled) return failed("forbidden", "mcp_disabled");
      return ok(tokens.filter((entry) => entry.person.id === me.person.id).map(strip));
    }),
    listOrganizationAccessTokens: vi.fn(async () => {
      if (!isAdmin) return failed("forbidden");
      if (!enabled) return failed("forbidden", "mcp_disabled");
      return ok(tokens.map((entry) => ({ ...entry })));
    }),
    revokeAccessToken: vi.fn(async (id: string) => {
      const entry = tokens.find((candidate) => candidate.id === id);
      if (!entry || (entry.person.id !== me.person.id && !isAdmin)) return failed("not_found");
      if (entry.revokedAt === null) entry.revokedAt = "2026-11-21T12:30:00.000Z";
      return ok(undefined);
    }),
  };
}

const SUMMARY_NAMES = ["getTicketSummary", "putTicketSummary", "regenerateTicketSummary"] as const;
export const SUMMARY_MAX = 1000;

/**
 * As rotas de "O que entra aqui" do contrato da ADR 0033 como a ADR 0034 as mudou, em memória: leitura para qualquer
 * ticket de quem vê o projeto; gravar e pedir à IA só para quem edita (administrador, gestor ou colaborador), fora de
 * projeto arquivado e em ticket com filhos (409 `ticket_has_no_items`); 400 `validation_error` (de 1 a 1.000 caracteres) e a origem (`person` ao gravar, `assistant`
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
    if (!all.some((child) => child.parentId === id)) return failed("conflict", "ticket_has_no_items");
    return null;
  };

  return {
    getTicketSummary: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
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
      if (config.providerUp === false) return failed("unavailable", "assistant_unavailable");
      texts.set(id, { text: config.regenerated ?? "Reúne os trabalhos de agora deste ticket.", source: "assistant", updatedAt: now() });
      return answer(id);
    }),
  };
}

/** A resposta condicional do cliente falso: sempre a lista inteira, sem versão (o servidor falso não guarda versões). */
function changedList(list: ApiResult<TicketSummary[]>): ApiResult<TicketListUpdate> {
  return list.ok ? { ok: true, data: { changed: true, tickets: list.data, version: null } } : list;
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
    "getTicket", "endAgentWork", "createTicket", "updateTicket", "removeTicket", "listIdeas", "putIdeaStage", "acceptIdea", "discardIdea", "makeIdea", "putTicketAssignee", "removeTicketAssignee", "addTicketDependency", "removeTicketDependency",
    "importTickets", "openConversation", "sendConversationMessage", "updateConversationDraft", "findPlacement", "getElaboration",
    "createTicketFromConversation", "listConversations", "getConversation", "removeConversation", "getConversationPreview",
    ...GITHUB_NAMES,
    ...MCP_NAMES,
    "getAiConsent", "acceptAiConsent", "withdrawAiConsent",
    "createTestPerson", "deactivateTestPerson", "reactivateTestPerson",
    ...SUMMARY_NAMES,
    "draftTicketDescription",
    "createTicketComment", "updateComment", "removeComment",
    "createContribution", "updateContribution", "removeContribution", "putContributionPerson", "removeContributionPerson",
    "getConversationView", "getTicketConversationView", "openTicketConversation", "openGeneralConversation", "sendChatMessage", "addConversationParticipants", "markConversationRead", "clearConversationMessages",
  ] as const;
  const base = Object.fromEntries(names.map((name) => [name, unexpected(name)])) as unknown as ApiClient;
  let client!: ApiClient;
  const self = () => client;
  return (client = {
    ...base,
    getMe: vi.fn(async () => ok(data.me ?? makeMe())),
    listProjects: vi.fn(async () => ok(data.projects ?? [])),
    listAreas: vi.fn(async () => ok(data.areas ?? [])),
    listTeams: vi.fn(async () => ok(data.teams ?? [])),
    listPeople: vi.fn(async () => ok(data.people ?? [])),
    listTickets: vi.fn(async (projectId: string) => ok(data.tickets?.[projectId] ?? [])),
    // Sem versão: cada pergunta baixa a lista pelo `listTickets` falso (o servidor falso não faz resposta condicional).
    listTicketsIfChanged: vi.fn(async (projectId: string) => changedList(await self().listTickets(projectId))),
    // Atividade vazia por padrão: os testes que não falam dela não mudam (ADR 0040).
    ticketActivity: vi.fn(async (): Promise<ApiResult<ActivityPage>> => ok({ entries: [], before: null, canComment: false })),
    // Sem chat configurado, a árvore de conversas é vazia: o mapa e a barra que a pedem não quebram os testes que não falam dela.
    listConversationTree: vi.fn(async () => ok({ items: [] })),
    ...(data.chat ? data.chat.methods(data.chatAs) : {}),
    ...(data.github ? githubMethods(data) : {}),
    ...(data.mcp ? mcpMethods(data) : {}),
    ...(data.aiConsent ? aiConsentMethods(data) : {}),
    ...(data.summaries ? summaryMethods(data) : {}),
  });
}

/**
 * Cliente falso com a árvore de tickets em memória, que respeita o contrato da ADR 0034: sem tipo; qualquer ticket é pai
 * possível (só o próprio e os descendentes dele não: 409 `ticket_cycle`); todo ticket tem situação; o progresso conta todos
 * os descendentes e é nulo sem filhos; concluir com filho direto aberto é 409 `ticket_has_open_children`; remover ticket
 * com filhos é 409 `ticket_has_children`. As chamadas continuam espiáveis (`vi.fn`).
 */
export function makeTreeClient(data: FakeData = {}): ApiClient {
  const base = makeClient(data);
  const all: TicketSummary[] = Object.values(data.tickets ?? {}).flat().map((entry) => ({ ...entry }));
  const descriptions = new Map<string, string>();
  const find = (id: string) => all.find((entry) => entry.id === id);
  const childrenOf = (id: string) => all.filter((entry) => entry.parentId === id);
  const descendantsOf = (id: string): TicketSummary[] => childrenOf(id).flatMap((child) => [child, ...descendantsOf(child.id)]);
  const open = (entry: TicketSummary) => entry.status !== "done" && entry.status !== "cancelled";
  /** A raiz de ideia em que o ticket está (ele próprio ou um ancestral), se houver (ADR 0042). */
  const ideaRootOf = (entry: TicketSummary): TicketSummary | undefined => {
    for (let at: TicketSummary | undefined = entry; at; at = at.parentId === null ? undefined : find(at.parentId)) if (at.idea?.root === true) return at;
    return undefined;
  };
  const withProgress = (entry: TicketSummary): TicketSummary => {
    const root = ideaRootOf(entry);
    const idea = root === undefined ? null : root.id === entry.id ? entry.idea : { root: false as const, rootId: root.id, rootKey: root.key };
    // Ideias não entram na conta (ADR 0042): `ideas` conta as raízes abaixo.
    const below = descendantsOf(entry.id).filter((item) => ideaRootOf(item) === undefined);
    const ideas = descendantsOf(entry.id).filter((item) => item.idea?.root === true).length;
    if (below.length === 0 && ideas === 0) return { ...entry, idea, progress: null };
    const excluded = below.filter((item) => item.status === "cancelled").length;
    return { ...entry, idea, progress: { done: below.filter((item) => item.status === "done").length, total: below.length - excluded, excluded, ...(ideas > 0 ? { ideas } : {}) } };
  };
  const detail = (entry: TicketSummary): TicketDetail => ({
    ...withProgress(entry),
    canTriageIdea: data.canTriageIdea ?? true,
    ...(entry.agentWork ? { agentWork: { by: data.agentWorkBy ?? { id: "person-1", displayName: "Ana", avatarUrl: null }, ...entry.agentWork }, canEndAgentWork: data.canEndAgentWork ?? true } : {}),
    description: descriptions.get(entry.id) ?? "",
    effectivePriority: effectiveOf(entry),
    mentionedBy: [], dependsOn: [], blocks: [],
    contributions: [], canEditContributions: true,
    createdByPersonId: "person-1",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });
  /** A prioridade que vale (ADR 0047): a própria, ou a do ancestral mais próximo diferente de 0. */
  const effectiveOf = (entry: TicketSummary): NonNullable<TicketDetail["effectivePriority"]> => {
    for (let at: TicketSummary | undefined = entry; at; at = at.parentId === null ? undefined : find(at.parentId)) {
      if ((at.priority ?? 0) !== 0) return { value: at.priority ?? 0, from: { id: at.id, key: at.key } };
    }
    return { value: 0, from: null };
  };
  const conflict = (code: string) => failed("conflict", code);
  /**
   * Reabertura (ADR 0034): quem recebe um filho direto aberto e está concluído volta para "a fazer", e a subida segue até
   * o primeiro ancestral que não esteja concluído. Cancelado não é reaberto e interrompe a subida.
   */
  const reopenFrom = (parentId: string | null) => {
    for (let at = parentId === null ? undefined : find(parentId); at && at.status === "done"; at = at.parentId === null ? undefined : find(at.parentId)) at.status = "todo";
  };

  let client!: ApiClient;
  const self = () => client;
  return (client = {
    ...base,
    listTickets: vi.fn(async (projectId: string) => ok(all.filter((entry) => entry.projectId === projectId).map(withProgress))),
    listTicketsIfChanged: vi.fn(async (projectId: string) => changedList(await self().listTickets(projectId))),
    getTicket: vi.fn(async (id: string) => {
      const entry = find(id);
      return entry ? ok(detail(entry)) : failed("not_found");
    }),
    endAgentWork: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      delete entry.agentWork;
      return ok(detail(entry));
    }),
    createTicket: vi.fn(async (projectId, body) => {
      const number = Math.max(0, ...all.filter((entry) => entry.projectId === projectId).map((entry) => entry.number)) + 1;
      const entry = makeTicket(`new-${projectId}-${number}`, projectId, number, body.title, { parentId: body.parentId ?? null, status: body.status ?? "todo", ...(body.idea ? { idea: { root: true as const, stage: "new" as const } } : {}) });
      all.push(entry);
      if (body.description) descriptions.set(entry.id, body.description);
      if (open(entry) && ideaRootOf(entry) === undefined) reopenFrom(entry.parentId);
      return ok(detail(entry));
    }),
    createTicketFromConversation: vi.fn(async (id: string, body) => {
      const parent = body.parentId === null ? null : find(body.parentId);
      if (body.parentId !== null && !parent) return failed("not_found");
      const projectId = data.conversations?.[id]?.projectId ?? parent?.projectId ?? data.projects?.[0]?.id ?? "";
      const conversation = data.conversations?.[id] ?? makeConversation(id, projectId);
      const nextNumber = () => Math.max(0, ...all.filter((entry) => entry.projectId === projectId).map((entry) => entry.number)) + 1;
      let parentId = body.parentId;
      if (body.group) {
        const group = makeTicket(`group-${projectId}-${nextNumber()}`, projectId, nextNumber(), body.group.title, { parentId: body.parentId });
        all.push(group);
        if (body.group.description) descriptions.set(group.id, body.group.description);
        for (const ticketId of body.group.ticketIds) {
          const moved = find(ticketId);
          if (moved) moved.parentId = group.id;
        }
        parentId = group.id;
      }
      const number = nextNumber();
      const entry = makeTicket(`new-${projectId}-${number}`, projectId, number, conversation.draft?.title ?? "Novo ticket", { parentId });
      all.push(entry);
      if (conversation.draft?.description) descriptions.set(entry.id, conversation.draft.description);
      reopenFrom(body.parentId);
      return ok({ conversation: { ...conversation, status: "ticket_created" as const, createdTicketId: entry.id }, ticket: detail(entry), children: [], warnings: [] });
    }),
    updateTicket: vi.fn(async (id, body) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (body.parentId !== undefined) {
        for (let at = body.parentId; at !== null; at = find(at)?.parentId ?? null) if (at === id) return conflict("ticket_cycle");
      }
      if (body.status !== undefined && ideaRootOf(entry)) return conflict("ticket_in_idea");
      if (body.status === "done" && childrenOf(id).some((child) => open(child) && ideaRootOf(child) === undefined)) return conflict("ticket_has_open_children");
      if (body.title !== undefined) entry.title = body.title;
      if (body.description !== undefined) descriptions.set(id, body.description);
      if (body.parentId !== undefined) entry.parentId = body.parentId;
      if (body.status !== undefined) entry.status = body.status;
      if (body.priority !== undefined) entry.priority = body.priority;
      if ((body.status !== undefined || body.parentId !== undefined) && open(entry)) reopenFrom(entry.parentId);
      return ok(detail(entry));
    }),
    /** A lista de ideias do projeto, calculada da árvore de agora: estágio, depois o mais antigo, como a API. */
    listIdeas: vi.fn(async (projectId: string) => {
      const order = { ready: 0, refining: 1, new: 2, discarded: 3 } as const;
      const pathOf = (entry: TicketSummary): string[] => {
        const path: string[] = [];
        for (let at = entry.parentId === null ? undefined : find(entry.parentId); at; at = at.parentId === null ? undefined : find(at.parentId)) path.unshift(at.title);
        return path;
      };
      const createdAt = (entry: TicketSummary) => data.ideaCreatedAt?.[entry.id] ?? "2026-11-20T10:00:00.000Z";
      const roots = all.filter((entry) => entry.projectId === projectId && entry.idea?.root === true);
      roots.sort((a, b) => order[(a.idea as { stage: keyof typeof order }).stage] - order[(b.idea as { stage: keyof typeof order }).stage] || createdAt(a).localeCompare(createdAt(b)) || a.number - b.number);
      return ok(roots.map((entry) => ({ id: entry.id, number: entry.number, key: entry.key, title: entry.title, stage: (entry.idea as { stage: IdeaStage }).stage, path: pathOf(entry), createdAt: createdAt(entry) })));
    }),
    putIdeaStage: vi.fn(async (id: string, body) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (entry.idea?.root !== true) return conflict("ticket_not_idea");
      entry.idea = { root: true, stage: body.stage };
      return ok(detail(entry));
    }),
    acceptIdea: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (data.canTriageIdea === false) return failed("forbidden");
      if (entry.idea?.root !== true) return conflict("ticket_not_idea");
      entry.idea = null;
      reopenFrom(entry.parentId);
      return ok(detail(entry));
    }),
    discardIdea: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (data.canTriageIdea === false) return failed("forbidden");
      if (entry.idea?.root !== true) return conflict("ticket_not_idea");
      entry.idea = { root: true, stage: "discarded" };
      return ok(detail(entry));
    }),
    makeIdea: vi.fn(async (id: string) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if ([entry, ...descendantsOf(id)].some((item) => item.status === "in_progress" || item.status === "in_review" || item.status === "done")) return conflict("ticket_has_work");
      entry.idea = { root: true, stage: "new" };
      return ok(detail(entry));
    }),
    removeTicket: vi.fn(async (id: string) => {
      if (!find(id)) return failed("not_found");
      if (childrenOf(id).length > 0) return conflict("ticket_has_children");
      all.splice(all.findIndex((entry) => entry.id === id), 1);
      return ok(undefined);
    }),
  });
}
