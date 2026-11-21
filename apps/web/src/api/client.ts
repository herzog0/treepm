import { z } from "zod";

const teamRole = z.enum(["admin", "member"]);
const projectRole = z.enum(["manager", "contributor", "reader"]);
const visibility = z.enum(["organization", "private"]);

const meSchema = z.object({
  person: z.object({
    id: z.string(),
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  organization: z.object({ orgId: z.string(), name: z.string(), slug: z.string() }),
  roles: z.object({
    clerk: z.enum(["admin", "member"]),
    teams: z.array(z.object({ teamId: z.string(), role: teamRole })),
    projects: z.array(z.object({ projectId: z.string(), role: projectRole })),
  }),
  /** Ausente em uma API antiga: a IA conta como desligada (ADR 0029). */
  assistant: z.object({ enabled: z.boolean() }).optional(),
  /** Ausente em uma API antiga: o GitHub conta como desligado (ADR 0032). */
  github: z.object({ enabled: z.boolean() }).optional(),
});
const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  clerkRole: z.enum(["admin", "member"]),
  active: z.boolean(),
});
const teamMemberSchema = z.object({ personId: z.string(), role: teamRole });
const teamSchema = z.object({ id: z.string(), name: z.string(), members: z.array(teamMemberSchema) });
const areaSchema = z.object({ id: z.string(), name: z.string() });
const projectMemberSchema = z.object({ personId: z.string(), role: projectRole });
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  visibility,
  archivedAt: z.string().nullable(),
  members: z.array(projectMemberSchema),
  teamIds: z.array(z.string()),
});
const projectTeamSchema = z.object({ projectId: z.string(), teamId: z.string() });
const ticketStatus = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
const ticketSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  key: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  /** Situação própria, sempre presente (ADR 0034): todo ticket pode ter filhos e continua sendo trabalho. */
  status: ticketStatus,
  /** Sobre todos os descendentes; `null` quando o ticket não tem filhos. */
  progress: z.object({ done: z.number(), total: z.number(), excluded: z.number() }).nullable(),
  assigneeIds: z.array(z.string()),
  /** Primeiros caracteres da descrição, para o card em "detalhe" do mapa (ADR 0027). */
  descriptionExcerpt: z.string(),
});
const ticketDetailSchema = ticketSummarySchema.extend({
  description: z.string(),
  createdByPersonId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const draftSchema = z.object({ title: z.string(), description: z.string() }).nullable();
const conversationSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(["open", "ticket_created", "discarded"]),
  draft: draftSchema,
  /** Opinião da IA no último turno; a pessoa pode procurar o lugar a qualquer momento. */
  ready: z.boolean(),
  createdTicketId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(
    z.object({ id: z.string(), author: z.enum(["person", "assistant"]), body: z.string(), model: z.string().nullable(), createdAt: z.string() }),
  ),
});
const placementTargetSchema = z.object({ parentId: z.string().nullable(), path: z.array(z.object({ id: z.string(), title: z.string() })) });
const placementOutcomeSchema = z.object({
  destination: placementTargetSchema,
  alternatives: z.array(placementTargetSchema).max(2),
  discarded: z.array(z.object({ level: z.number(), parentId: z.string().nullable(), ticketId: z.string(), title: z.string() })),
  uncertain: z.boolean(),
  stoppedEarly: z
    .object({ reason: z.enum(["candidates_too_large", "max_levels"]), level: z.number(), parentId: z.string().nullable() })
    .nullable(),
  /** `null` sem escopo (e numa API que ainda não manda o campo). */
  scope: z.object({ id: z.string(), title: z.string(), outOfScope: z.boolean() }).nullable().default(null),
  /** Ticket pai novo que a IA propõe no destino (ADR 0031, ADR 0034); `null` sem proposta (e numa API que ainda não manda o campo). */
  groupProposal: z
    .object({
      title: z.string(),
      description: z.string(),
      tickets: z.array(z.object({ id: z.string(), number: z.number(), title: z.string() })).min(1),
    })
    .nullable()
    .default(null),
  /** Por que não houve proposta, quando há um motivo; `null` quando há proposta ou ninguém passou do limiar. */
  groupProposalSkipped: z
    .enum(["not_settled", "no_loose_tickets", "too_large", "same_as_destination", "invalid_name", "unavailable"])
    .nullable()
    .default(null),
});
const createdFromConversationSchema = z.object({ conversation: conversationDetailSchema, ticket: ticketDetailSchema });
const githubInstallationSchema = z.object({
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.enum(["all", "selected"]),
  connectedAt: z.string(),
});
const githubRepositorySchema = z.object({
  repoId: z.number(),
  fullName: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
});
const projectRepositorySchema = githubRepositorySchema.extend({ id: z.string(), linkedAt: z.string() });
const codeRefreshSchema = z.object({
  refreshed: z.boolean(),
  syncedAt: z.string().nullable(),
  repositories: z.array(z.object({ id: z.string(), fullName: z.string(), status: z.enum(["ok", "truncated", "unavailable"]) })),
});
const codeLinkSchema = z.object({
  id: z.string(),
  kind: z.enum(["branch", "pull_request"]),
  ticket: z.object({ id: z.string(), key: z.string(), title: z.string() }),
  repository: z.object({ fullName: z.string(), htmlUrl: z.string() }),
  ref: z.string(),
  number: z.number().nullable(),
  title: z.string().nullable(),
  state: z.enum(["active", "open", "merged", "closed"]),
  url: z.string(),
  updatedAt: z.string().nullable(),
});
const ticketCodeSchema = z.object({ repositories: z.number(), syncedAt: z.string().nullable(), links: z.array(codeLinkSchema) });
const ticketSummaryTextSchema = z.object({
  summary: z.object({ text: z.string(), source: z.enum(["assistant", "person"]), updatedAt: z.string() }).nullable(),
});
const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

export type Me = z.output<typeof meSchema>;
export type Person = z.output<typeof personSchema>;
export type TeamRole = z.output<typeof teamRole>;
export type TeamMember = z.output<typeof teamMemberSchema>;
export type Team = z.output<typeof teamSchema>;
export type Area = z.output<typeof areaSchema>;
export type ProjectRole = z.output<typeof projectRole>;
export type ProjectVisibility = z.output<typeof visibility>;
export type ProjectMember = z.output<typeof projectMemberSchema>;
export type Project = z.output<typeof projectSchema>;
export type ProjectTeam = z.output<typeof projectTeamSchema>;
export type TicketStatus = z.output<typeof ticketStatus>;
export type TicketSummary = z.output<typeof ticketSummarySchema>;
export type TicketDetail = z.output<typeof ticketDetailSchema>;
export type ConversationDraft = NonNullable<z.output<typeof draftSchema>>;
export type ConversationSummary = z.output<typeof conversationSummarySchema>;
export type ConversationDetail = z.output<typeof conversationDetailSchema>;
export type PlacementTarget = z.output<typeof placementTargetSchema>;
export type PlacementOutcome = z.output<typeof placementOutcomeSchema>;
export type GroupProposal = NonNullable<PlacementOutcome["groupProposal"]>;
/** O ticket pai novo que a pessoa confirmou: criado no destino escolhido, com estes tickets movidos para ele. */
export interface NewGroup {
  title: string;
  description: string;
  ticketIds: string[];
}
export type GithubInstallation = z.output<typeof githubInstallationSchema>;
export type GithubRepository = z.output<typeof githubRepositorySchema>;
export type ProjectRepository = z.output<typeof projectRepositorySchema>;
export type CodeRefresh = z.output<typeof codeRefreshSchema>;
export type CodeLink = z.output<typeof codeLinkSchema>;
export type TicketCode = z.output<typeof ticketCodeSchema>;
/** "O que entra aqui" de um ticket com filhos (ADR 0033, ADR 0034): o texto guardado, quem o escreveu por último e quando. */
export type GroupSummary = z.output<typeof ticketSummaryTextSchema>;
/** Corpo do retorno do GitHub: `code` e `state` da URL e, quando veio um inteiro positivo, o `installation_id`. */
export interface CompleteGithubBody {
  code: string;
  state: string;
  installationId?: number;
}
export type CreatedFromConversation = z.output<typeof createdFromConversationSchema>;

export interface ImportItem {
  title: string;
  description?: string;
  status?: TicketStatus;
  children?: ImportItem[];
}
export interface ImportTicketsBody {
  parentId?: string | null;
  items: ImportItem[];
}
export interface CreateTicketBody {
  title: string;
  description?: string;
  parentId?: string | null;
  status?: TicketStatus;
  assigneeIds?: string[];
}
export interface UpdateTicketBody {
  title?: string;
  description?: string;
  status?: TicketStatus;
  parentId?: string | null;
}

export type ApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "server_error"
  | "unavailable";
export interface ApiError {
  kind: ApiErrorKind;
  /** Código do corpo `{ error: { code, message } }` da API, quando presente. */
  code?: string;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface CreateProjectBody {
  name: string;
  key: string;
  visibility?: ProjectVisibility;
}
export interface UpdateProjectBody {
  name?: string;
  visibility?: ProjectVisibility;
  archived?: boolean;
}

export interface ApiClientOptions {
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  500: "server_error",
};

const fail = (kind: ApiErrorKind, code?: string): { ok: false; error: ApiError } => ({
  ok: false,
  error: code === undefined ? { kind } : { kind, code },
});

export function createApiClient({ getToken, fetch: fetchImpl }: ApiClientOptions) {
  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | null,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    try {
      const token = await getToken();
      if (!token) return fail("unauthenticated");

      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const init: RequestInit = { headers };
      if (method !== "GET") init.method = method;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      const response = await (fetchImpl ?? globalThis.fetch)(path, init);
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
        return fail(KIND_BY_STATUS[response.status] ?? "unavailable", parsed.success ? parsed.data.error.code : undefined);
      }
      if (schema === null) return { ok: true, data: undefined as T };

      const parsed = schema.safeParse(await response.json());
      return parsed.success ? { ok: true, data: parsed.data } : fail("unavailable");
    } catch {
      return fail("unavailable");
    }
  }

  const team = (id: string) => `/api/teams/${id}`;
  const project = (id: string) => `/api/projects/${id}`;
  const ticket = (id: string) => `/api/tickets/${id}`;
  const conversation = (id: string) => `/api/ticket-conversations/${id}`;

  return {
    getMe: () => request("GET", "/api/me", meSchema),
    listPeople: () => request("GET", "/api/people", z.array(personSchema)),

    listTeams: () => request("GET", "/api/teams", z.array(teamSchema)),
    createTeam: (body: { name: string }) => request("POST", "/api/teams", teamSchema, body),
    renameTeam: (id: string, body: { name: string }) => request("PATCH", team(id), teamSchema, body),
    removeTeam: (id: string) => request("DELETE", team(id), null),
    putTeamMember: (teamId: string, personId: string, body: { role: TeamRole }) =>
      request("PUT", `${team(teamId)}/members/${personId}`, teamMemberSchema, body),
    removeTeamMember: (teamId: string, personId: string) =>
      request("DELETE", `${team(teamId)}/members/${personId}`, null),

    listAreas: () => request("GET", "/api/areas", z.array(areaSchema)),
    createArea: (body: { name: string }) => request("POST", "/api/areas", areaSchema, body),
    renameArea: (id: string, body: { name: string }) => request("PATCH", `/api/areas/${id}`, areaSchema, body),
    removeArea: (id: string) => request("DELETE", `/api/areas/${id}`, null),

    listProjects: () => request("GET", "/api/projects", z.array(projectSchema)),
    getProject: (id: string) => request("GET", project(id), projectSchema),
    createProject: (body: CreateProjectBody) => request("POST", "/api/projects", projectSchema, body),
    updateProject: (id: string, body: UpdateProjectBody) => request("PATCH", project(id), projectSchema, body),
    putProjectMember: (projectId: string, personId: string, body: { role: ProjectRole }) =>
      request("PUT", `${project(projectId)}/members/${personId}`, projectMemberSchema, body),
    removeProjectMember: (projectId: string, personId: string) =>
      request("DELETE", `${project(projectId)}/members/${personId}`, null),
    putProjectTeam: (projectId: string, teamId: string) =>
      request("PUT", `${project(projectId)}/teams/${teamId}`, projectTeamSchema),
    removeProjectTeam: (projectId: string, teamId: string) =>
      request("DELETE", `${project(projectId)}/teams/${teamId}`, null),

    listTickets: (projectId: string) => request("GET", `${project(projectId)}/tickets`, z.array(ticketSummarySchema)),
    getTicket: (id: string) => request("GET", ticket(id), ticketDetailSchema),
    createTicket: (projectId: string, body: CreateTicketBody) =>
      request("POST", `${project(projectId)}/tickets`, ticketDetailSchema, body),
    updateTicket: (id: string, body: UpdateTicketBody) => request("PATCH", ticket(id), ticketDetailSchema, body),
    removeTicket: (id: string) => request("DELETE", ticket(id), null),
    putTicketAssignee: (id: string, personId: string) =>
      request("PUT", `${ticket(id)}/assignees/${personId}`, ticketDetailSchema),
    removeTicketAssignee: (id: string, personId: string) =>
      request("DELETE", `${ticket(id)}/assignees/${personId}`, null),
    /** `scopeId`: o ticket em que a procura vai começar (ADR 0033, ADR 0034), ou `null` para o projeto inteiro; a IA recebe os títulos dos tickets com filhos dali. */
    openConversation: (projectId: string, body: { message: string; scopeId?: string | null }) =>
      request("POST", `${project(projectId)}/ticket-conversations`, conversationDetailSchema, body),
    sendConversationMessage: (id: string, body: { message: string; scopeId?: string | null }) =>
      request("POST", `${conversation(id)}/messages`, conversationDetailSchema, body),
    updateConversationDraft: (id: string, body: ConversationDraft) =>
      request("PATCH", `${conversation(id)}/draft`, conversationDetailSchema, body),
    /** `scopeId`: procura só dentro desse ticket (ADR 0031, ADR 0034); sem ele, no projeto inteiro. */
    findPlacement: (id: string, scopeId?: string) =>
      request("POST", `${conversation(id)}/placement`, placementOutcomeSchema, scopeId === undefined ? undefined : { scopeId }),
    createTicketFromConversation: (id: string, body: { parentId: string | null; group?: NewGroup }) =>
      request("POST", `${conversation(id)}/ticket`, createdFromConversationSchema, body),
    listConversations: (projectId: string) =>
      request("GET", `/api/ticket-conversations?projectId=${encodeURIComponent(projectId)}`, z.array(conversationSummarySchema)),
    getConversation: (id: string) => request("GET", conversation(id), conversationDetailSchema),
    removeConversation: (id: string) => request("DELETE", conversation(id), null),
    importTickets: (projectId: string, body: ImportTicketsBody) =>
      request("POST", `${project(projectId)}/tickets/import`, z.array(ticketSummarySchema), body),

    getGithubInstallation: () =>
      request("GET", "/api/github/installation", z.object({ installation: githubInstallationSchema.nullable() })),
    connectGithub: () => request("POST", "/api/github/connect", z.object({ url: z.string() })),
    completeGithubConnection: (body: CompleteGithubBody) =>
      request("POST", "/api/github/connect/complete", z.object({ installation: githubInstallationSchema }), body),
    disconnectGithub: () => request("DELETE", "/api/github/installation", null),
    listGithubRepositories: () => request("GET", "/api/github/repositories", z.array(githubRepositorySchema)),
    listProjectRepositories: (projectId: string) =>
      request("GET", `${project(projectId)}/repositories`, z.array(projectRepositorySchema)),
    linkProjectRepository: (projectId: string, body: { repoId: number }) =>
      request("POST", `${project(projectId)}/repositories`, projectRepositorySchema, body),
    unlinkProjectRepository: (projectId: string, repositoryId: string) =>
      request("DELETE", `${project(projectId)}/repositories/${repositoryId}`, null),
    refreshProjectCode: (projectId: string) => request("POST", `${project(projectId)}/code/refresh`, codeRefreshSchema),
    getTicketCode: (id: string) => request("GET", `${ticket(id)}/code`, ticketCodeSchema),

    getTicketSummary: (id: string) => request("GET", `${ticket(id)}/summary`, ticketSummaryTextSchema),
    putTicketSummary: (id: string, body: { text: string }) => request("PUT", `${ticket(id)}/summary`, ticketSummaryTextSchema, body),
    regenerateTicketSummary: (id: string) => request("POST", `${ticket(id)}/summary/regenerate`, ticketSummaryTextSchema),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** O GitHub está ligado nesta API? Uma API antiga não manda o campo: conta como desligado. */
export const githubEnabled = (me: Me): boolean => me.github?.enabled === true;

/** A IA está ligada nesta API? Uma API antiga não manda o campo: conta como desligada. */
export const assistantEnabled = (me: Me): boolean => me.assistant?.enabled === true;
