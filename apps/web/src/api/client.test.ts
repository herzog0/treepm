import { describe, expect, it, vi } from "vitest";
import { createApiClient, describeApiError } from "./client.js";
import type { ApiClient } from "./client.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const me = {
  person: { id: ID, displayName: "Ana", email: "ana@example.com", avatarUrl: null },
  organization: { orgId: "org", name: "Equipe", slug: "equipe" },
  roles: { clerk: "admin", teams: [], projects: [] },
};
const person = { id: ID, displayName: "Ana", email: "ana@example.com", avatarUrl: null, clerkRole: "member", active: true };
const team = { id: ID, name: "Time", members: [{ personId: OTHER, role: "admin" }] };
const area = { id: ID, name: "Área" };
const project = {
  id: ID,
  name: "Projeto",
  key: "PRJ",
  visibility: "organization",
  archivedAt: null,
  members: [{ personId: OTHER, role: "manager" }],
  teamIds: [ID],
};

function setup(respond: () => Response | Promise<Response> = () => Response.json({})) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => respond());
  const getToken = vi.fn<() => Promise<string | null>>().mockResolvedValue("tok");
  const client = createApiClient({ getToken, fetch: fetchImpl });
  return { client, fetchImpl, getToken };
}

interface Case {
  name: string;
  call: (client: ApiClient) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  status?: number;
  response?: unknown;
  expected?: unknown;
}

const cases: Case[] = [
  { name: "me", call: (c) => c.getMe(), method: "GET", path: "/api/me", response: me },
  { name: "people", call: (c) => c.listPeople(), method: "GET", path: "/api/people", response: [person] },
  { name: "listTeams", call: (c) => c.listTeams(), method: "GET", path: "/api/teams", response: [team] },
  { name: "createTeam", call: (c) => c.createTeam({ name: "Time" }), method: "POST", path: "/api/teams", body: { name: "Time" }, status: 201, response: team },
  { name: "renameTeam", call: (c) => c.renameTeam(ID, { name: "Novo" }), method: "PATCH", path: `/api/teams/${ID}`, body: { name: "Novo" }, response: team },
  { name: "removeTeam", call: (c) => c.removeTeam(ID), method: "DELETE", path: `/api/teams/${ID}`, status: 204 },
  { name: "putTeamMember", call: (c) => c.putTeamMember(ID, OTHER, { role: "admin" }), method: "PUT", path: `/api/teams/${ID}/members/${OTHER}`, body: { role: "admin" }, response: { personId: OTHER, role: "admin" } },
  { name: "removeTeamMember", call: (c) => c.removeTeamMember(ID, OTHER), method: "DELETE", path: `/api/teams/${ID}/members/${OTHER}`, status: 204 },
  { name: "listAreas", call: (c) => c.listAreas(), method: "GET", path: "/api/areas", response: [area] },
  { name: "createArea", call: (c) => c.createArea({ name: "Área" }), method: "POST", path: "/api/areas", body: { name: "Área" }, status: 201, response: area },
  { name: "renameArea", call: (c) => c.renameArea(ID, { name: "Nova" }), method: "PATCH", path: `/api/areas/${ID}`, body: { name: "Nova" }, response: area },
  { name: "removeArea", call: (c) => c.removeArea(ID), method: "DELETE", path: `/api/areas/${ID}`, status: 204 },
  { name: "listProjects", call: (c) => c.listProjects(), method: "GET", path: "/api/projects", response: [project] },
  { name: "getProject", call: (c) => c.getProject(ID), method: "GET", path: `/api/projects/${ID}`, response: project },
  { name: "createProject", call: (c) => c.createProject({ name: "Projeto", key: "PRJ", visibility: "private" }), method: "POST", path: "/api/projects", body: { name: "Projeto", key: "PRJ", visibility: "private" }, status: 201, response: project },
  { name: "updateProject", call: (c) => c.updateProject(ID, { archived: true }), method: "PATCH", path: `/api/projects/${ID}`, body: { archived: true }, response: project },
  { name: "putProjectMember", call: (c) => c.putProjectMember(ID, OTHER, { role: "reader" }), method: "PUT", path: `/api/projects/${ID}/members/${OTHER}`, body: { role: "reader" }, response: { personId: OTHER, role: "reader" } },
  { name: "removeProjectMember", call: (c) => c.removeProjectMember(ID, OTHER), method: "DELETE", path: `/api/projects/${ID}/members/${OTHER}`, status: 204 },
  { name: "putProjectTeam", call: (c) => c.putProjectTeam(ID, OTHER), method: "PUT", path: `/api/projects/${ID}/teams/${OTHER}`, response: { projectId: ID, teamId: OTHER } },
  { name: "removeProjectTeam", call: (c) => c.removeProjectTeam(ID, OTHER), method: "DELETE", path: `/api/projects/${ID}/teams/${OTHER}`, status: 204 },
];

describe("createApiClient", () => {
  it.each(cases)("$name sends $method $path and returns the validated body", async (c) => {
    const { client, fetchImpl } = setup(() =>
      c.status === 204 ? new Response(null, { status: 204 }) : Response.json(c.response, { status: c.status ?? 200 }),
    );
    const result = await c.call(client);
    expect(result).toEqual({ ok: true, data: c.status === 204 ? undefined : c.response });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(c.path);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    if (c.method === "GET") {
      expect(init?.method).toBeUndefined();
    } else {
      expect(init?.method).toBe(c.method);
    }
    if (c.body !== undefined) {
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual(c.body);
    } else {
      expect(init?.body).toBeUndefined();
    }
  });

  it("requests a fresh token per call", async () => {
    const { client, getToken } = setup(() => Response.json([]));
    await client.listTeams();
    await client.listAreas();
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, { error: { code: "unauthenticated", message: "x" } }, { kind: "unauthenticated", code: "unauthenticated" }],
    [403, { error: { code: "forbidden", message: "x" } }, { kind: "forbidden", code: "forbidden" }],
    [404, { error: { code: "not_found", message: "x" } }, { kind: "not_found", code: "not_found" }],
    [409, { error: { code: "team_name_taken", message: "x" } }, { kind: "conflict", code: "team_name_taken" }],
    [409, { error: { code: "person_inactive", message: "x" } }, { kind: "conflict", code: "person_inactive" }],
    [400, { error: { code: "validation_error", message: "x" } }, { kind: "invalid", code: "validation_error" }],
    [500, { error: { code: "internal_error", message: "x" } }, { kind: "unavailable", code: "internal_error" }],
    [502, null, { kind: "unavailable" }],
    [409, "<html>", { kind: "conflict" }],
  ])("maps HTTP %i with body %j to %j", async (status, body, error) => {
    const { client } = setup(() =>
      typeof body === "string" ? new Response(body, { status }) : body === null ? new Response(null, { status }) : Response.json(body, { status }),
    );
    expect(await client.listTeams()).toEqual({ ok: false, error });
  });

  it("never throws: network failures are unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("returns unauthenticated without a request when there is no token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createApiClient({ getToken: async () => null, fetch: fetchImpl });
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "unauthenticated" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports token failures as unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createApiClient({ getToken: async () => { throw new Error("clerk"); }, fetch: fetchImpl });
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["listTeams", (c: ApiClient) => c.listTeams(), [{ id: ID }]],
    ["listAreas", (c: ApiClient) => c.listAreas(), { id: ID, name: "x" }],
    ["listProjects", (c: ApiClient) => c.listProjects(), [{ ...project, visibility: "public" }]],
    ["listPeople", (c: ApiClient) => c.listPeople(), [{ ...person, active: "yes" }]],
    ["getMe", (c: ApiClient) => c.getMe(), { ...me, roles: { ...me.roles, clerk: "owner" } }],
    ["putTeamMember", (c: ApiClient) => c.putTeamMember(ID, OTHER, { role: "member" }), { personId: OTHER, role: "boss" }],
  ])("%s treats a malformed success body as unavailable", async (_name, call, body) => {
    const { client } = setup(() => Response.json(body));
    expect(await call(client)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("treats a non-JSON success body as unavailable", async () => {
    const { client } = setup(() => new Response("<html>"));
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
});

describe("describeApiError", () => {
  it.each([
    ["team_name_taken", "Já existe um time com esse nome."],
    ["area_name_taken", "Já existe uma área com esse nome."],
    ["project_key_taken", "Já existe um projeto com essa chave."],
    ["person_inactive", "A pessoa não está mais na organização."],
  ])("translates the %s code", (code, message) => {
    expect(describeApiError({ kind: "conflict", code })).toBe(message);
  });

  it.each([
    [{ kind: "forbidden" }, "Você não tem permissão para fazer isso."],
    [{ kind: "not_found" }, "Não encontramos esse item. Ele pode ter sido removido."],
    [{ kind: "unavailable" }, "A API está indisponível. Tente novamente em instantes."],
    [{ kind: "unauthenticated" }, "Sua sessão expirou. Entre novamente."],
    [{ kind: "invalid" }, "Os dados informados não são válidos."],
    [{ kind: "conflict" }, "Esta alteração conflita com o estado atual. Recarregue e tente novamente."],
    [{ kind: "conflict", code: "unknown_code" }, "Esta alteração conflita com o estado atual. Recarregue e tente novamente."],
  ] as const)("translates %j generically", (error, message) => {
    expect(describeApiError(error)).toBe(message);
  });
});
