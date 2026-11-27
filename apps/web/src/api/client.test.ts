import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { describeApiError } from "./errorText.js";
import { createApiClient } from "./client.js";
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

const ticketSummary = {
  id: ID,
  projectId: OTHER,
  number: 12,
  key: "TREE-12",
  parentId: null,
  title: "Ticket",
  status: "todo",
  progress: null,
  assigneeIds: [OTHER],
  descriptionExcerpt: "Trecho da descrição",
};
const ticketDetail = {
  ...ticketSummary,
  description: "Texto",
  mentionedBy: [{ id: "m1", key: "ALFA-2", title: "Cita", status: "todo" }],
  dependsOn: [{ id: "d1", key: "ALFA-3", title: "Antes", status: "done", fromLinear: true }],
  blocks: [{ id: "b1", key: "ALFA-4", title: "Depois", status: "todo", fromLinear: false }],
  related: [{ id: "r1", key: "ALFA-5", title: "Ao lado", status: "todo", fromLinear: true }],
  createdByPersonId: OTHER,
  createdAt: "2026-11-19T10:00:00.000Z",
  updatedAt: "2026-11-19T10:00:00.000Z",
};
const parentSummary = { ...ticketSummary, status: "in_review", progress: { done: 3, total: 8, excluded: 2 } };

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
  { name: "setMcpPeopleEnabled", call: (c) => c.setMcpPeopleEnabled(true), method: "PATCH", path: "/api/organization/mcp-people", body: { mcpPeopleEnabled: true }, response: { mcp: { enabled: true, writeEnabled: false, peopleEnabled: true } } },
  { name: "setMcpWriteEnabled", call: (c) => c.setMcpWriteEnabled(true), method: "PATCH", path: "/api/organization/mcp-write", body: { mcpWriteEnabled: true }, response: { mcp: { enabled: true, writeEnabled: true } } },
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
  { name: "listTickets", call: (c) => c.listTickets(ID), method: "GET", path: `/api/projects/${ID}/tickets`, response: [ticketSummary, parentSummary] },
  { name: "getTicket", call: (c) => c.getTicket(ID), method: "GET", path: `/api/tickets/${ID}`, response: ticketDetail },
  { name: "createTicket", call: (c) => c.createTicket(ID, { title: "Ticket", parentId: null }), method: "POST", path: `/api/projects/${ID}/tickets`, body: { title: "Ticket", parentId: null }, status: 201, response: ticketDetail },
  { name: "updateTicket", call: (c) => c.updateTicket(ID, { status: "done" }), method: "PATCH", path: `/api/tickets/${ID}`, body: { status: "done" }, response: ticketDetail },
  { name: "removeTicket", call: (c) => c.removeTicket(ID), method: "DELETE", path: `/api/tickets/${ID}`, status: 204 },
  { name: "putTicketAssignee", call: (c) => c.putTicketAssignee(ID, OTHER), method: "PUT", path: `/api/tickets/${ID}/assignees/${OTHER}`, response: ticketDetail },
  { name: "removeTicketAssignee", call: (c) => c.removeTicketAssignee(ID, OTHER), method: "DELETE", path: `/api/tickets/${ID}/assignees/${OTHER}`, status: 204 },
  { name: "addTicketDependency", call: (c) => c.addTicketDependency(ID, OTHER), method: "POST", path: `/api/tickets/${ID}/dependencies`, body: { ticketId: OTHER }, response: ticketDetail },
  { name: "removeTicketDependency", call: (c) => c.removeTicketDependency(ID, OTHER), method: "DELETE", path: `/api/tickets/${ID}/dependencies/${OTHER}`, status: 204 },
  { name: "removeTicketRelated", call: (c) => c.removeTicketRelated(ID, OTHER), method: "DELETE", path: `/api/tickets/${ID}/related/${OTHER}`, status: 204 },
  { name: "importTickets", call: (c) => c.importTickets(ID, { items: [{ title: "A", children: [{ title: "B", status: "done" }] }] }), method: "POST", path: `/api/projects/${ID}/tickets/import`, body: { items: [{ title: "A", children: [{ title: "B", status: "done" }] }] }, status: 201, response: [ticketSummary] },
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
    [500, { error: { code: "internal_error", message: "x" } }, { kind: "server_error", code: "internal_error" }],
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

describe("5xx responses", () => {
  it.each([502, 503, 504])("maps %i to unavailable", async (status) => {
    const { client } = setup(() => new Response("bad gateway", { status }));
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("maps 500 to server_error, keeping the API code", async () => {
    const { client } = setup(() => Response.json({ error: { code: "internal" } }, { status: 500 }));
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "server_error", code: "internal" } });
  });

  it("maps 500 without a JSON body to server_error", async () => {
    const { client } = setup(() => new Response("boom", { status: 500 }));
    expect(await client.listTeams()).toEqual({ ok: false, error: { kind: "server_error" } });
  });

  it("describes server_error apart from unavailable", () => {
    expect(describeApiError(i18n.t, { kind: "server_error" })).toBe(
      "O servidor encontrou um erro. Tente de novo; se continuar, avise quem administra.",
    );
  });
});

describe("describeApiError", () => {
  it.each([
    ["team_name_taken", "Já existe um time com esse nome."],
    ["area_name_taken", "Já existe uma área com esse nome."],
    ["project_key_taken", "Já existe um projeto com essa chave."],
    ["person_inactive", "A pessoa não está mais na organização."],
  ])("translates the %s code", (code, message) => {
    expect(describeApiError(i18n.t, { kind: "conflict", code })).toBe(message);
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
    expect(describeApiError(i18n.t, error)).toBe(message);
  });
});

describe("listTickets › chaves do Linear (ADR 0061)", () => {
  it("keeps externalKeys of the tickets that have an origin, and nothing for the others", async () => {
    const { client } = setup(() => Response.json([{ ...ticketSummary, externalKeys: ["ENG-123", "OPS-45"] }, { ...ticketSummary, id: "other" }]));
    const result = await client.listTickets(ID);
    expect(result.ok && result.data.map((ticket) => ticket.externalKeys)).toEqual([["ENG-123", "OPS-45"], undefined]);
  });
});

describe("listTicketsIfChanged (ADR 0046)", () => {
  const withTag = (tag: string | null) => () => {
    const headers = new Headers(tag === null ? {} : { ETag: tag });
    return Response.json([ticketSummary], { headers });
  };

  it("without a version it asks for the whole list and returns the version the server sent", async () => {
    const { client, fetchImpl } = setup(withTag('W/"v1.100"'));
    expect(await client.listTicketsIfChanged(ID, null)).toEqual({ ok: true, data: { changed: true, tickets: [expect.objectContaining({ id: ID })], version: 'W/"v1.100"' } });
    expect(new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers).has("If-None-Match")).toBe(false);
  });

  it("with a version it sends If-None-Match, and a 304 means nothing changed (not an error, not an empty list)", async () => {
    const { client, fetchImpl } = setup(() => new Response(null, { status: 304 }));
    const result = await client.listTicketsIfChanged(ID, 'W/"v1.100"');
    expect(result).toEqual({ ok: true, data: { changed: false } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/projects/${ID}/tickets`);
    expect(new Headers((init as RequestInit).headers).get("If-None-Match")).toBe('W/"v1.100"');
  });

  it("a 200 after a stale version brings the new list and the new version; a response without ETag has no version", async () => {
    expect(await setup(withTag('W/"v1.200"')).client.listTicketsIfChanged(ID, 'W/"v1.100"')).toMatchObject({ ok: true, data: { changed: true, version: 'W/"v1.200"' } });
    expect(await setup(withTag(null)).client.listTicketsIfChanged(ID, 'W/"v1.100"')).toMatchObject({ ok: true, data: { changed: true, version: null } });
  });

  it("errors stay errors: 404, an invalid list and a network failure", async () => {
    expect(await setup(() => Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 })).client.listTicketsIfChanged(ID, 'W/"v1.1"')).toEqual({ ok: false, error: { kind: "not_found", code: "not_found" } });
    expect(await setup(() => Response.json([{ ...ticketSummary, descriptionExcerpt: undefined }])).client.listTicketsIfChanged(ID, null)).toEqual({ ok: false, error: { kind: "unavailable" } });
    const offline = createApiClient({ getToken: async () => "tok", fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")) });
    expect(await offline.listTicketsIfChanged(ID, null)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("listTickets itself is unchanged: no conditional header, a plain list", async () => {
    const { client, fetchImpl } = setup(withTag('W/"v1.5"'));
    expect(await client.listTickets(ID)).toEqual({ ok: true, data: [expect.objectContaining({ id: ID })] });
    expect(new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers).has("If-None-Match")).toBe(false);
  });
});

describe("ticket responses", () => {
  it("keeps descriptionExcerpt from the ticket listing", async () => {
    const { client } = setup(() => Response.json([ticketSummary]));
    expect(await client.listTickets(ID)).toEqual({ ok: true, data: [expect.objectContaining({ descriptionExcerpt: "Trecho da descrição" })] });
  });

  it("rejects a listing entry without descriptionExcerpt", async () => {
    const { client } = setup(() => Response.json([{ ...ticketSummary, descriptionExcerpt: undefined }]));
    expect(await client.listTickets(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("rejects a ticket with an unknown status", async () => {
    const { client } = setup(() => Response.json([{ ...ticketSummary, status: "blocked" }]));
    expect(await client.listTickets(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
});

describe("ticket without a type (ADR 0034)", () => {
  it("keeps the own status and the progress of a ticket with children", async () => {
    const { client } = setup(() => Response.json([parentSummary]));
    expect(await client.listTickets(ID)).toEqual({ ok: true, data: [expect.objectContaining({ status: "in_review", progress: { done: 3, total: 8, excluded: 2 } })] });
  });

  it("reads a listing entry that has no kind, and does not keep a `kind` from an old API", async () => {
    const { client } = setup(() => Response.json([{ ...ticketSummary, kind: "group" }]));
    const result = await client.listTickets(ID);
    expect(result.ok && result.data[0] && "kind" in result.data[0]).toBe(false);
  });

  it("rejects a ticket without status: a null status no longer exists", async () => {
    const { client } = setup(() => Response.json([{ ...ticketSummary, status: null }]));
    expect(await client.listTickets(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("a server without Linear relations (ADR 0061, slice 3): no related list and no fromLinear still parse", async () => {
    const plain = { ...ticketDetail, related: undefined, dependsOn: [{ id: "d1", key: "ALFA-3", title: "Antes", status: "done" }], blocks: [] };
    const { client } = setup(() => Response.json(plain));
    const result = await client.getTicket(ID);
    expect(result.ok && result.data.related).toEqual([]);
    expect(result.ok && result.data.dependsOn[0]?.fromLinear).toBeUndefined();
  });

  it("sends no kind when creating and when updating", async () => {
    const created = setup(() => Response.json(ticketDetail, { status: 201 }));
    await created.client.createTicket(ID, { title: "Fase 1" });
    expect(JSON.parse(String(created.fetchImpl.mock.calls[0]![1]!.body))).toEqual({ title: "Fase 1" });
    const updated = setup(() => Response.json(ticketDetail));
    await updated.client.updateTicket(ID, { status: "done" });
    expect(JSON.parse(String(updated.fetchImpl.mock.calls[0]![1]!.body))).toEqual({ status: "done" });
  });
});

describe("describeApiError for tickets", () => {
  it.each(["ticket_has_children", "parent_not_group", "group_has_no_status", "group_empty", "not_a_group"])("no longer has a special message for %s (only the generic conflict one)", (code) => {
    expect(describeApiError(i18n.t, { kind: "conflict", code })).toMatch(/conflita com o estado atual/);
    expect(describeApiError(i18n.t, { kind: "conflict", code })).not.toMatch(/agrupador/i);
  });

  it("words ticket_has_children for a removal as a removal", () => {
    expect(describeApiError(i18n.t, { kind: "conflict", code: "ticket_has_children" }, "remove")).toBe("Este ticket tem itens. Mova ou remova os itens antes de removê-lo.");
  });

  it.each([
    ["status_is_derived", "vem dos itens dele"],
    ["ticket_has_no_items", "Este ticket ainda não tem itens."],
    ["ticket_cycle", "ancestral"],
    ["project_archived", "arquivado"],
    ["person_without_project_access", "acesso ao projeto"],
  ])("explains %s in Portuguese", (code, fragment) => {
    const message = describeApiError(i18n.t, { kind: "conflict", code });
    expect(message).toContain(fragment);
    expect(message).not.toMatch(/Recarregue e tente/);
  });
});

describe("ticket activity: work ended by the project being archived (TREEPM-233)", () => {
  it("keeps the agent_work_ended entry with reason archived instead of dropping it", async () => {
    const entry = { id: "e1", type: "agent_work_ended", occurredAt: "2026-11-22T10:00:00.000Z", actor: null, reason: "archived" };
    const { client } = setup(() => Response.json({ entries: [entry], before: null, canComment: false }));
    const result = await client.ticketActivity(ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.entries).toEqual([entry]);
  });
});

describe("ticket activity: labels (ADR 0065)", () => {
  it("keeps labels_changed with the names of the time and drops the project event label_deleted", async () => {
    const changed = { id: "e1", type: "labels_changed", occurredAt: "2026-11-22T10:00:00.000Z", actor: null, automatic: true, added: [{ id: "l1", name: "Bug" }], removed: [] };
    const deleted = { id: "e2", type: "label_deleted", occurredAt: "2026-11-22T10:00:00.000Z", actor: null, name: "Bug", tickets: 3 };
    const { client } = setup(() => Response.json({ entries: [changed, deleted], before: null, canComment: false }));
    const result = await client.ticketActivity(ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.entries).toEqual([changed]);
  });
});
