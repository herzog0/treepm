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

export type ApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

const MESSAGE_BY_CODE: Record<string, string> = {
  team_name_taken: "Já existe um time com esse nome.",
  area_name_taken: "Já existe uma área com esse nome.",
  project_key_taken: "Já existe um projeto com essa chave.",
  person_inactive: "A pessoa não está mais na organização.",
};

const MESSAGE_BY_KIND: Record<ApiErrorKind, string> = {
  unauthenticated: "Sua sessão expirou. Entre novamente.",
  forbidden: "Você não tem permissão para fazer isso.",
  not_found: "Não encontramos esse item. Ele pode ter sido removido.",
  conflict: "Esta alteração conflita com o estado atual. Recarregue e tente novamente.",
  invalid: "Os dados informados não são válidos.",
  unavailable: "A API está indisponível. Tente novamente em instantes.",
};

export function describeApiError(error: ApiError): string {
  return (error.code !== undefined ? MESSAGE_BY_CODE[error.code] : undefined) ?? MESSAGE_BY_KIND[error.kind];
}
