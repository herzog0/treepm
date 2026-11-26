/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { LINEAR_CONFIG, sessionHeader } from "./helpers.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0062, fatia 2 (TREEPM-494): o terceiro alcance do MCP, "pessoas e conversas": chave da organização, alcance do token,
// `list_people`, os responsáveis nas leituras e `set_ticket_assignees`. Com a ligação do Linear configurada (fatia 4): as três
// ferramentas do Linear existem e entram na garantia central.
const h = useMcpHarness(LINEAR_CONFIG);
const priv = () => h.world().projects.priv;
const open = () => h.world().projects.org;
const P = () => h.world().people;

const PEOPLE_TOOLS = ["list_people", "set_ticket_assignees", "list_comments", "get_ticket_history", "list_conversations", "get_conversation"];
const LINEAR_TOOLS = ["get_linear_status", "start_linear_sync", "continue_linear_sync"];
/** Uma rodada aberta do Linear, iniciada por uma pessoa com nome (semeada em `populate`). */
const RUN_ID = "0190a1b2-0000-7000-8000-00000000abcd";
const NAMES: Record<string, string> = { admin: "Zelda Quimera", manager: "Orfeu Calcanhotto", contributor: "Brunilda Tamanduá", reader: "Xerxes Pimenteira", plain: "Ulisses Ventania", teamAdmin: "Hortência Bambolê", target: "Cássio Trovoada" };

async function keys(on: { write?: boolean; people?: boolean; mcp?: boolean } = {}): Promise<void> {
  await h.pool.query("update organizations set mcp_enabled = $2, mcp_write_enabled = $3, mcp_people_enabled = $4 where org_id = $1", [ORG, on.mcp ?? true, on.write ?? true, on.people ?? true]);
}
async function nameThePeople(): Promise<void> {
  for (const [who, name] of Object.entries(NAMES)) await h.pool.query("update people set display_name = $2 where org_id = $1 and clerk_user_id = $3", [ORG, name, `u_${who}`]);
}
/** Semeia o projeto, dá nomes inconfundíveis às pessoas, liga as chaves e cria um token. */
async function setup(opts: { who?: Who; scope?: "read" | "write"; people?: boolean; write?: boolean; orgPeople?: boolean; project?: string } = {}): Promise<{ token: string; id: string }> {
  await seedProject(h.pool, priv(), P().manager, P().contributor);
  await nameThePeople();
  await keys({ write: opts.write ?? true, people: true });
  const res = await h.create(opts.who ?? "contributor", opts.project ?? priv(), { scope: opts.scope ?? "write", people: opts.people ?? true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (opts.orgPeople === false) await keys({ write: opts.write ?? true, people: false });
  return { token: res.body.token as string, id: res.body.id as string };
}
const names = async (token: string) => ((await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
const assignees = async (number: number) => (await h.rows("select p.display_name n from ticket_assignees a join tickets t on t.id = a.ticket_id join people p on p.id = a.person_id where t.project_id = $1 and t.number = $2 order by 1", [priv(), number])).map((r) => r["n"] as string);
const events = async (kind: string) => h.rows("select payload from activity_events where kind = $1 order by created_at", [kind]);
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;

describe("a chave da organização", () => {
  const path = "/api/organization/mcp-people";
  it("só administrador liga; grava o evento uma vez; aparece em /api/me; só liga com a chave geral ligada", async () => {
    expect((await h.call("PATCH", path, as("manager"), { mcpPeopleEnabled: true })).status).toBe(403);
    expect((await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: true })).status, "geral desligada").toBe(409);
    await h.enableMcp();
    const on = await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ mcp: { enabled: true, writeEnabled: false, peopleEnabled: true } });
    expect((await h.call("GET", "/api/me", as("reader"))).body.mcp).toMatchObject({ peopleEnabled: true });
    await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: true });
    expect(await events("organization.mcp_people_changed")).toHaveLength(1);
    expect((await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: "sim" })).status).toBe(400);
  });
  it("desligar a chave geral não desliga esta, e as outras duas rotas devolvem o estado das três", async () => {
    await h.enableMcp();
    await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: true });
    const off = await h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: false });
    expect(off.body).toMatchObject({ mcp: { enabled: false, peopleEnabled: true } });
    expect((await h.rows("select mcp_people_enabled p from organizations where org_id = $1", [ORG]))[0]).toEqual({ p: true });
    const write = await h.call("PATCH", "/api/organization/mcp-write", as("admin"), { mcpWriteEnabled: true });
    expect(write.body).toMatchObject({ mcp: { enabled: false, writeEnabled: true, peopleEnabled: true } });
  });
  it("desligar grava o evento e volta a /api/me", async () => {
    await h.enableMcp();
    await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: true });
    await h.call("PATCH", path, as("admin"), { mcpPeopleEnabled: false });
    expect(await events("organization.mcp_people_changed")).toHaveLength(2);
    expect((await h.call("GET", "/api/me", as("reader"))).body.mcp.peopleEnabled).toBe(false);
  });
});

describe("o alcance no token", () => {
  it("nasce desligado; aceita ligar com a chave da organização ligada; a lista e o evento mostram; recusa o que não é boolean", async () => {
    await h.enableMcp();
    await keys({ people: true });
    const a = await h.create("contributor", priv());
    const b = await h.create("contributor", priv(), { people: true });
    const c = await h.create("contributor", priv(), { scope: "write", people: true });
    const d = await h.create("contributor", priv(), { people: "sim" });
    expect([a.status, b.status, c.status, d.status]).toEqual([201, 201, 201, 400]);
    expect([a.body.people, b.body.people, c.body.people]).toEqual([false, true, true]);
    expect([b.body.scope, c.body.scope]).toEqual(["read", "write"]);
    const list = (await h.call("GET", "/api/access-tokens", as("contributor"))).body as { people: boolean; scope: string }[];
    expect(list.map((t) => `${t.scope}:${t.people}`).sort()).toEqual(["read:false", "read:true", "write:true"]);
    const created = (await events("access_token.created")).map((e) => (e["payload"] as any).people);
    expect(created.sort()).toEqual([false, true, true]);
    const org = (await h.call("GET", "/api/access-tokens/organization", as("admin"))).body as { people: boolean }[];
    expect(org.map((t) => t.people).sort()).toEqual([false, true, true]);
  });
  it("criar com o alcance exige a chave da organização ligada naquele momento (e sem ela a criação sem o alcance continua)", async () => {
    await h.enableMcp();
    const refusedCreate = await h.create("contributor", priv(), { people: true });
    expect(refusedCreate.status).toBe(403);
    expect(refusedCreate.body.error?.code ?? refusedCreate.body.code).toBe("mcp_people_disabled");
    expect((await h.create("contributor", priv())).status).toBe(201);
    expect(await h.rows("select 1 from access_tokens where people")).toHaveLength(0);
  });
  it("tokens que já existiam (sem a coluna preenchida) continuam sem o alcance", async () => {
    await keys({ people: true });
    const { token } = await setup({ people: false });
    expect(await names(token)).not.toContain("list_people");
  });
});

describe("tools/list segue o alcance efetivo (matriz organização × token)", () => {
  const cases: { write: boolean; orgPeople: boolean; scope: "read" | "write"; people: boolean }[] = [];
  for (const write of [false, true]) for (const orgPeople of [false, true]) for (const scope of ["read", "write"] as const) for (const people of [false, true]) cases.push({ write, orgPeople, scope, people });
  it.each(cases)("chave de escrita=$write, chave de pessoas=$orgPeople, token $scope com pessoas=$people", async (c) => {
    const { token } = await setup({ scope: c.scope, people: c.people, write: c.write, orgPeople: c.orgPeople });
    const effectivePeople = c.people && c.orgPeople;
    const effectiveWrite = c.scope === "write" && c.write;
    const list = await names(token);
    expect(list.includes("list_people")).toBe(effectivePeople);
    expect(list.includes("set_ticket_assignees")).toBe(effectivePeople && effectiveWrite);
    expect(list.includes("update_ticket_status")).toBe(effectiveWrite);
    // Os campos: só com o alcance efetivo.
    const ticket = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(ticket.status).toBe(200);
    expect("assignees" in (ticket.json ?? {})).toBe(effectivePeople);
  });
  it("o token de escrita sem pessoas e o de pessoas sem escrita: a ferramenta de responsável não existe", async () => {
    const a = await setup({ scope: "write", people: false });
    expect(await names(a.token)).not.toContain("set_ticket_assignees");
    const b = (await h.create("contributor", priv(), { scope: "read", people: true })).body.token as string;
    expect(await names(b)).toContain("list_people");
    expect(await names(b)).not.toContain("set_ticket_assignees");
    const res = await h.tool(b, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
    expect(refused(res)).toBe(true);
    expect(await assignees(3)).toEqual([]);
  });
});

describe("garantia central: sem o alcance efetivo, nenhuma resposta tem nome, id ou e-mail de pessoa", () => {
  // Cada ferramenta que existir no servidor precisa de entradas aqui: uma ferramenta nova sem entrada derruba o teste.
  const CALLS: Record<string, Record<string, unknown>[]> = {
    search_tickets: [{ query: "Raiz" }, { query: "Solto" }],
    get_ticket: [{ key: "PRIV-1" }, { key: "PRIV-4" }, { key: "PRIV-99" }, { key: "OPEN-1" }],
    list_tickets: [{}, { status: ["todo"] }, { under: "PRIV-1" }],
    get_work_queue: [{}, { under: "PRIV-1" }],
    get_project_overview: [{}],
    update_ticket_status: [{ key: "PRIV-3", status: "in_progress" }, { key: "PRIV-99", status: "done" }],
    add_comment: [{ key: "PRIV-3", body: "um comentário" }],
    set_agent_work: [{ key: "PRIV-3", working: true }],
    set_ticket_priority: [{ key: "PRIV-3", priority: 5 }],
    create_ticket: [{ title: "Ticket novo" }],
    update_ticket: [{ key: "PRIV-3", title: "Filho B renomeado" }],
    move_ticket: [{ key: "PRIV-3", parent: "PRIV-4" }],
    add_dependency: [{ key: "PRIV-3", dependsOn: "PRIV-2" }],
    remove_dependency: [{ key: "PRIV-3", dependsOn: "PRIV-2" }],
    // Ferramentas do alcance: pedidas sem ele, a resposta é "não existe" e nada mais.
    list_people: [{}],
    set_ticket_assignees: [{ key: "PRIV-3", personIds: [] }],
    list_comments: [{ key: "PRIV-3" }, { key: "PRIV-99" }],
    get_ticket_history: [{ key: "PRIV-3" }, { key: "PRIV-1" }],
    list_conversations: [{}],
    get_conversation: [{ id: "00000000-0000-4000-8000-0000000000aa" }],
    // As do Linear (ADR 0062, seção 5): projeto ligado, rodada aberta por uma pessoa com nome; sem o alcance, quem iniciou não sai.
    get_linear_status: [{}],
    start_linear_sync: [{}],
    continue_linear_sync: [{ runId: RUN_ID }],
  };
  /** Nomes de autor e de responsável que só existem no histórico trazido do Linear (ADR 0061, fatia 4). */
  const LINEAR_NAMES = ["Ana Sentinela do Linear", "Bia Sentinela do Linear", "Dora Sentinela do Linear"];
  const forbidden = (): string[] => [...Object.values(P()), P().admin, ...Object.values(NAMES), ...Object.keys(NAMES).map((who) => `${who}@exemplo.test`), "@exemplo.test", ...LINEAR_NAMES];

  async function sweep(token: string, label: string): Promise<void> {
    // Dado de pessoa em todo canto que o MCP poderia ler: comentário, responsável, atividade.
    const surfaces: string[] = [];
    const every = new Set([...(await names(token)), ...PEOPLE_TOOLS, ...LINEAR_TOOLS]);
    for (const name of every) {
      const calls = CALLS[name];
      expect(calls, `a ferramenta ${name} precisa de chamadas neste teste`).toBeDefined();
      for (const args of calls ?? []) surfaces.push(JSON.stringify((await h.tool(token, "PRIV", name, args)).raw));
    }
    surfaces.push(JSON.stringify((await h.rpc(token, "PRIV", "tools/list")).body));
    surfaces.push(JSON.stringify((await h.rpc(token, "PRIV", "initialize")).body));
    for (const [i, text] of surfaces.entries()) {
      for (const needle of forbidden()) expect(text.includes(needle), `${label}: resposta ${i} contém ${needle}`).toBe(false);
      expect(text, `${label}: resposta ${i} tem a chave assignees`).not.toMatch(/assignees\\*"\s*:/);
    }
  }
  async function populate(): Promise<void> {
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) select $1, project_id, id, $2, 'comentário de Xerxes Pimenteira' from tickets where project_id = $3 and number = 3", [ORG, P().reader, priv()]);
    await h.pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload) select $1, $2, 'ticket.updated', 'ticket', id, '{}'::jsonb from tickets where project_id = $3 and number = 3", [ORG, P().manager, priv()]);
    await h.pool.query(
      "insert into project_external_sources (org_id, project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id) values ($1,$2,'linear','ws-1','Acme','team-eng','ENG','Engenharia',$3)",
      [ORG, priv(), P().manager],
    );
    await h.pool.query("insert into external_import_runs (org_id, id, project_id, provider, started_by_person_id, mode, phase) values ($1,$2,$3,'linear',$4,'reimport','issues')", [ORG, RUN_ID, priv(), P().manager]);
    // O histórico trazido do Linear (ADR 0061, fatia 4): origem com criador do Linear, entrada de pessoa casada e de autor do Linear, com
    // responsáveis dos dois tipos.
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["id"] as string;
    await h.pool.query("insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, source_snapshot, applied_snapshot, external_created_at, external_creator_name) values ($1,$2,$3,'linear','issue','issue-3','{}','{}','2025-05-01T00:00:00Z',$4)", [ORG, ticket, priv(), LINEAR_NAMES[2]]);
    const history = (external: string, minutes: number, actor: string | null, name: string | null) =>
      h.pool.query(
        "insert into external_history_entries (org_id, project_id, ticket_id, provider, external_id, occurred_at, actor_person_id, external_actor_name, changes) values ($1,$2,$3,'linear',$4,'2025-06-01T00:00:00Z'::timestamptz + make_interval(mins => $5),$6,$7,$8)",
        [ORG, priv(), ticket, external, minutes, actor, name, JSON.stringify([{ field: "assignee", from: { personId: P().contributor }, to: { name: LINEAR_NAMES[1] } }])],
      );
    await history("hist-1", 1, P().reader, null);
    await history("hist-2", 2, null, LINEAR_NAMES[0]!);
  }

  it("token sem o alcance (leitura e escrita), com a chave da organização ligada", async () => {
    const read = await setup({ scope: "read", people: false });
    await populate();
    await sweep(read.token, "leitura sem pessoas");
    const write = (await h.create("contributor", priv(), { scope: "write", people: false })).body.token as string;
    await sweep(write, "escrita sem pessoas");
  });
  it("token com o alcance, mas a chave da organização desligada depois: corta na chamada seguinte, leitura e escrita", async () => {
    const { token } = await setup({ scope: "write", people: true });
    await populate();
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" })).json?.assignees).toBeDefined();
    await keys({ write: true, people: false });
    await sweep(token, "chave de pessoas desligada");
  });
  it("token com o alcance e a chave geral do MCP desligada: nada responde", async () => {
    const { token } = await setup({ scope: "write", people: true });
    await keys({ mcp: false, write: true, people: true });
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(res.status).toBe(403);
    for (const needle of forbidden()) expect(JSON.stringify(res.raw)).not.toContain(needle);
  });
  it("com o alcance a varredura enxerga nomes (a garantia testa algo de verdade)", async () => {
    const { token } = await setup({ scope: "write", people: true });
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(JSON.stringify(res.raw)).toContain(NAMES["contributor"]);
    await populate();
    const status = await h.tool(token, "PRIV", "get_linear_status", {});
    expect(status.data?.run?.startedBy).toEqual({ id: P().manager, name: NAMES["manager"] });
    // O histórico trazido do Linear também: pessoa casada, responsável e os nomes de lá.
    const history = JSON.stringify((await h.tool(token, "PRIV", "get_ticket_history", { key: "PRIV-3" })).raw);
    for (const needle of [P().reader, NAMES["reader"]!, P().contributor, "Ana Sentinela do Linear (Linear)", "Bia Sentinela do Linear (Linear)", "Dora Sentinela do Linear (Linear)"]) expect(history, needle).toContain(needle);
  });
});

describe("responsáveis nas leituras", () => {
  it("get_ticket, list_tickets, search_tickets e get_work_queue trazem assignees [{ id, name }], sem e-mail", async () => {
    const { token } = await setup({ scope: "read" });
    const expected = [{ id: P().contributor, name: NAMES["contributor"] }];
    const ticket = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(ticket.json?.assignees).toEqual(expected);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).json?.assignees).toEqual([]);
    const listed = (await h.tool(token, "PRIV", "list_tickets")).json?.tickets as { key: string; assignees: unknown }[];
    expect(listed.find((t) => t.key === "PRIV-1")?.assignees).toEqual(expected);
    expect(listed.every((t) => Array.isArray(t.assignees))).toBe(true);
    const found = (await h.tool(token, "PRIV", "search_tickets", { query: "Raiz" })).json?.tickets as { key: string; assignees: unknown }[];
    expect(found.find((t) => t.key === "PRIV-1")?.assignees).toEqual(expected);
    const queue = await h.tool(token, "PRIV", "get_work_queue");
    expect(queue.isError).toBe(false);
    for (const t of queue.json?.tickets as { assignees: unknown }[]) expect(Array.isArray(t.assignees)).toBe(true);
    // Os resumos dentro do get_ticket (filhos, caminho, relações) também trazem.
    const child = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expect(child.json?.path[0].assignees).toEqual(expected);
    const text = JSON.stringify([ticket.raw, listed, found]);
    expect(text).not.toContain("@exemplo.test");
    expect(text).not.toMatch(/email|avatar|clerkRole|role"/);
  });
  it("mais de um responsável, em ordem estável por nome", async () => {
    const { token } = await setup({ scope: "read" });
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) select $1, id, $2 from tickets where project_id = $3 and number = 1", [ORG, P().admin, priv()]);
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect((res.json?.assignees as { name: string }[]).map((a) => a.name)).toEqual([NAMES["contributor"], NAMES["admin"]]);
  });
});

describe("list_people", () => {
  it("projeto de acesso restrito: só quem enxerga o projeto; a própria dona do token marcada com me", async () => {
    const { token } = await setup({ scope: "read" });
    const res = await h.tool(token, "PRIV", "list_people");
    expect(res.status).toBe(200);
    const people = res.json?.people as { id: string; name: string; me?: boolean }[];
    expect(people.map((p) => p.name).sort()).toEqual([NAMES["admin"], NAMES["contributor"], NAMES["manager"], NAMES["reader"], NAMES["target"]].sort());
    expect(people.find((p) => p.id === P().contributor)).toMatchObject({ name: NAMES["contributor"], me: true });
    expect(people.filter((p) => p.me === true)).toHaveLength(1);
    expect(people.filter((p) => p.me !== true).every((p) => p.me === false)).toBe(true);
    for (const p of people) expect(Object.keys(p).sort()).toEqual(["id", "me", "name"]);
    expect(JSON.stringify(res.raw)).not.toContain("@exemplo.test");
  });
  it("não lista quem saiu da organização, e pessoas sem acesso ao projeto privado continuam de fora", async () => {
    const { token } = await setup({ scope: "read" });
    await h.pool.query("update people set active = false where id = $1", [P().reader]);
    const people = (await h.tool(token, "PRIV", "list_people")).json?.people as { id: string }[];
    expect(people.map((p) => p.id)).not.toContain(P().reader);
    expect(people.map((p) => p.id)).not.toContain(P().plain);
    expect(people.map((p) => p.id)).not.toContain(P().teamAdmin);
  });
  it("projeto da organização: todas as pessoas ativas, inclusive pessoa de teste ativa", async () => {
    await seedProject(h.pool, priv(), P().manager, P().contributor);
    await nameThePeople();
    await keys();
    await h.pool.query("update people set is_test = true, clerk_user_id = 'treepm_test_' || id::text where id = $1", [P().plain]);
    const token = (await h.create("reader", open(), { scope: "read", people: true })).body.token as string;
    const people = (await h.tool(token, "OPEN", "list_people")).json?.people as { name: string }[];
    expect(people).toHaveLength(7);
    expect(people.map((p) => p.name)).toContain(NAMES["plain"]);
  });
  it("outra organização nunca aparece", async () => {
    const { token } = await setup({ scope: "read" });
    const people = (await h.tool(token, "PRIV", "list_people")).json?.people as { id: string }[];
    expect(people.map((p) => p.id)).not.toContain(h.world().other.person);
  });
  it("entrada com campo desconhecido é recusada", async () => {
    const { token } = await setup({ scope: "read" });
    expect(refused(await h.tool(token, "PRIV", "list_people", { email: "x" }))).toBe(true);
  });
});

describe("set_ticket_assignees", () => {
  it("define a lista completa: adiciona, remove, troca e esvazia, com os mesmos eventos da tela e a origem mcp", async () => {
    const { token, id } = await setup();
    const call = (personIds: string[], key = "PRIV-3") => h.tool(token, "PRIV", "set_ticket_assignees", { key, personIds });
    const a = await call([P().reader, P().manager]);
    expect(a.status, a.text).toBe(200);
    expect(a.isError).toBe(false);
    expect(a.json?.key).toBe("PRIV-3");
    expect((a.json?.assignees as { id: string }[]).map((x) => x.id).sort()).toEqual([P().reader, P().manager].sort());
    expect(await assignees(3)).toEqual([NAMES["manager"], NAMES["reader"]].sort());
    const added = await events("ticket.assignee_added");
    expect(added).toHaveLength(2);
    expect(added[0]?.["payload"]).toMatchObject({ key: "PRIV-3", via: "mcp", tokenId: id });
    // Troca: tira o leitor, põe o alvo.
    await call([P().manager, P().target]);
    expect(await assignees(3)).toEqual([NAMES["manager"], NAMES["target"]].sort());
    expect(await events("ticket.assignee_removed")).toHaveLength(1);
    // Esvazia.
    const empty = await call([]);
    expect(empty.json?.assignees).toEqual([]);
    expect(await assignees(3)).toEqual([]);
    expect(await events("ticket.assignee_removed")).toHaveLength(3);
  });
  it("paridade com a tela: o mesmo estado e o mesmo evento (menos a origem) que PUT/DELETE", async () => {
    const { token } = await setup();
    await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
    const viaMcp = (await events("ticket.assignee_added"))[0]?.["payload"] as Record<string, unknown>;
    await h.pool.query("delete from ticket_assignees");
    await h.pool.query("delete from activity_events where kind like 'ticket.assignee%'");
    const ticketId = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["id"];
    expect((await h.call("PUT", `/api/tickets/${ticketId}/assignees/${P().reader}`, as("contributor"))).status).toBe(200);
    const viaScreen = (await events("ticket.assignee_added"))[0]?.["payload"] as Record<string, unknown>;
    const { via, tokenId, ...rest } = viaMcp;
    expect(via).toBe("mcp");
    expect(tokenId).toBeDefined();
    expect(rest).toEqual(viaScreen);
  });
  it("idempotente: repetir a mesma lista não grava evento nem muda nada; ordem e repetição de ids não importam", async () => {
    const { token } = await setup();
    const call = (personIds: string[]) => h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds });
    await call([P().reader, P().manager]);
    const before = await h.rows("select count(*)::int n from activity_events where kind like 'ticket.assignee%'");
    const version = await h.rows("select tickets_version v from projects where id = $1", [priv()]);
    const again = await call([P().manager, P().reader, P().reader]);
    expect(again.isError).toBe(false);
    expect(await h.rows("select count(*)::int n from activity_events where kind like 'ticket.assignee%'")).toEqual(before);
    expect(await h.rows("select tickets_version v from projects where id = $1", [priv()])).toEqual(version);
  });
  it("id que não pode ser responsável: a mesma recusa curta para inexistente, de outra organização, inativo e sem acesso ao projeto; nada muda", async () => {
    const { token } = await setup();
    await h.pool.query("update people set active = false where id = $1", [P().target]);
    const bad = ["00000000-0000-4000-8000-000000000000", h.world().other.person, P().target, P().plain];
    const messages = new Set<string>();
    for (const id of bad) {
      const res = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader, id] });
      expect(res.isError, id).toBe(true);
      messages.add(res.text);
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/cannot be assigned/i);
    expect(await assignees(3)).toEqual([]);
    expect(await events("ticket.assignee_added")).toHaveLength(0);
  });
  it("recusas: token sem escrita, token sem pessoas, leitor, projeto arquivado, ticket de outro projeto, chave inválida, entrada fora do formato", async () => {
    const { token } = await setup();
    // Token de leitura+pessoas: a ferramenta nem existe.
    const readOnly = (await h.create("contributor", priv(), { scope: "read", people: true })).body.token as string;
    expect(refused(await h.tool(readOnly, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [] }))).toBe(true);
    // Leitor (papel sem permissão de atribuir): a mesma frase de falta de permissão da escrita.
    const reader = (await h.create("reader", priv(), { scope: "write", people: true })).body.token as string;
    const denied = await h.tool(reader, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [] });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/permission/i);
    expect(await assignees(3)).toEqual([]);
    // Entradas.
    for (const args of [{ key: "OPEN-1", personIds: [] }, { key: "PRIV-99", personIds: [] }, { key: "PRIV-3", personIds: ["não é uuid"] }, { key: "PRIV-3" }, { key: "PRIV-3", personIds: [], extra: 1 }, { key: "PRIV-3", personIds: Array(101).fill(P().reader) }]) {
      expect(refused(await h.tool(token, "PRIV", "set_ticket_assignees", args as Record<string, unknown>)), JSON.stringify(args).slice(0, 60)).toBe(true);
    }
    // Arquivado.
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const archived = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
    expect(archived.isError).toBe(true);
    expect(archived.text).toMatch(/archived/i);
    expect(await assignees(3)).toEqual([]);
  });
  it("token de outra organização não alcança o projeto", async () => {
    await setup();
    const other = await h.issueOther();
    expect(refused(await h.tool(other.token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [] }))).toBe(true);
    expect(await assignees(3)).toEqual([]);
  });
  it("conta no limite de escritas e confere a participação na hora (pessoa que saiu escreve zero vezes)", async () => {
    const { token } = await setup();
    await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    const res = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
    expect(res.status).toBe(401);
    expect(await assignees(3)).toEqual([]);
  });
  it("desligar a chave de pessoas no meio: a escrita seguinte já não existe", async () => {
    const { token } = await setup();
    expect(await names(token)).toContain("set_ticket_assignees");
    await keys({ write: true, people: false });
    const res = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
    expect(refused(res)).toBe(true);
    expect(await assignees(3)).toEqual([]);
  });
});

describe("registro", () => {
  it("nenhum nome de pessoa nos logs do MCP", async () => {
    const { Logger } = await import("@nestjs/common");
    const { vi } = await import("vitest");
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
    try {
      const { token } = await setup();
      await h.tool(token, "PRIV", "list_people");
      await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
      await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] });
      await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [h.world().other.person] });
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      for (const name of Object.values(NAMES)) expect(logged).not.toContain(name);
      expect(logged).not.toContain("@exemplo.test");
      expect(logged).not.toContain(P().reader);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
void OTHER_ORG;

describe("e-mail e id do Clerk nunca saem, nem com o alcance (revisão de segurança)", () => {
  // Pessoas provisionadas pelo caminho de PRODUÇÃO: GET /api/me -> ClerkDirectoryProvider, que cai no e-mail ou no id quando o
  // usuário não tem nome. Os testes antigos trocavam todos os nomes antes e por isso não viam isto.
  const CLERK_USERS: Record<string, { firstName: string | null; lastName: string | null; username: string | null; email: string | null }> = {
    user_semnome: { firstName: null, lastName: null, username: null, email: "sem.nome@exemplo.test" },
    user_semnada: { firstName: null, lastName: null, username: null, email: null },
    user_apelidomail: { firstName: null, lastName: null, username: "bia@outra.org", email: "apelido@exemplo.test" },
    user_comnome: { firstName: "Clarice", lastName: "Lispector", username: null, email: "clarice@exemplo.test" },
  };
  async function provision(): Promise<void> {
    for (const [id, user] of Object.entries(CLERK_USERS)) {
      h.directory().clerkUsers.set(id, {
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        imageUrl: "",
        primaryEmailAddressId: user.email ? "e1" : null,
        emailAddresses: user.email ? [{ id: "e1", emailAddress: user.email }] : [],
      });
      const res = await h.call("GET", "/api/me", sessionHeader({ userId: id, orgId: ORG, orgRole: "org:member" }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    // Todas enxergam o projeto privado e são responsáveis pelos tickets 3 e 4 (`list_people` e `assignees` as devolvem).
    await h.pool.query(
      "insert into project_memberships (org_id, project_id, person_id, role) select org_id, $2, id, 'contributor' from people where org_id = $1 and clerk_user_id like 'user\\_%'",
      [ORG, priv()],
    );
    for (const number of [3, 4]) {
      await h.pool.query(
        "insert into ticket_assignees (org_id, ticket_id, person_id) select $1, t.id, p.id from tickets t, people p where t.project_id = $2 and t.number = $3 and p.org_id = $1 and p.clerk_user_id like 'user\\_%'",
        [ORG, priv(), number],
      );
    }
  }
  const BANNED = ["sem.nome@exemplo.test", "apelido@exemplo.test", "bia@outra.org", "clarice@exemplo.test", "user_semnome", "user_semnada", "user_apelidomail", "user_comnome", "@exemplo.test", "@outra.org"];

  it("a base tem mesmo o e-mail e o id no lugar do nome (o caminho de produção é o que grava isso)", async () => {
    await setup({ scope: "read" });
    await provision();
    const rows = await h.rows("select clerk_user_id u, display_name n from people where clerk_user_id like 'user\\_%' order by 1");
    expect(rows).toEqual([
      { u: "user_apelidomail", n: "bia@outra.org" },
      { u: "user_comnome", n: "Clarice Lispector" },
      { u: "user_semnada", n: "user_semnada" },
      { u: "user_semnome", n: "sem.nome@exemplo.test" },
    ]);
  });
  it("list_people e assignees (todas as leituras) trazem o rótulo neutro no lugar, com o alcance ligado", async () => {
    const { token } = await setup({ scope: "write" });
    await provision();
    const listed = (await h.tool(token, "PRIV", "list_people")).json?.people as { id: string; name: string }[];
    const byName = listed.map((entry) => entry.name).sort();
    expect(byName.filter((name) => name === "Unnamed person")).toHaveLength(3);
    expect(byName).toContain("Clarice Lispector");
    const surfaces = [
      await h.tool(token, "PRIV", "list_people"),
      await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" }),
      await h.tool(token, "PRIV", "list_tickets"),
      await h.tool(token, "PRIV", "search_tickets", { query: "Filho" }),
      await h.tool(token, "PRIV", "get_work_queue"),
      await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [] }),
    ].map((res) => JSON.stringify(res.raw));
    for (const [i, text] of surfaces.entries()) for (const banned of BANNED) expect(text.includes(banned), `resposta ${i} contém ${banned}`).toBe(false);
    expect(surfaces[1]).toContain("Unnamed person");
    expect(surfaces[1]).toContain("Clarice Lispector");
  });
  it("o que a tela mostra não muda: o nome na base continua o do Clerk", async () => {
    await setup({ scope: "read" });
    await provision();
    const res = await h.call("GET", "/api/me", sessionHeader({ userId: "user_semnome", orgId: ORG, orgRole: "org:member" }));
    expect(res.body.person.displayName).toBe("sem.nome@exemplo.test");
  });
  it("com o alcance ligado a varredura de e-mail em TODA ferramenta não acha nada (nem o das pessoas do mundo de teste)", async () => {
    const { token } = await setup({ scope: "write" });
    await provision();
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) select $1, project_id, id, $2, 'oi' from tickets where project_id = $3 and number = 3", [ORG, P().reader, priv()]);
    // Projeto ligado ao Linear com rodada aberta por quem tem o e-mail no lugar do nome: `startedBy` também passa pelo rótulo neutro.
    await h.pool.query(
      "insert into project_external_sources (org_id, project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id) values ($1,$2,'linear','ws-1','Acme','team-eng','ENG','Engenharia',$3)",
      [ORG, priv(), P().manager],
    );
    await h.pool.query("insert into external_import_runs (org_id, id, project_id, provider, started_by_person_id, mode, phase) select $1, $2, $3, 'linear', id, 'reimport', 'issues' from people where org_id = $1 and clerk_user_id = 'user_semnome'", [ORG, RUN_ID, priv()]);
    const every = new Set([...(await names(token)), ...PEOPLE_TOOLS, ...LINEAR_TOOLS]);
    for (const name of [...PEOPLE_TOOLS, ...LINEAR_TOOLS]) expect(every.has(name)).toBe(true);
    const status = await h.tool(token, "PRIV", "get_linear_status", {});
    expect(status.data?.run?.startedBy?.name, status.text).toBe("Unnamed person");
    const emailish = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const idish = /user_[A-Za-z0-9]{4,}|\bu_[a-z]+\b/;
    for (const name of every) {
      const calls = ({ ...CALLS_FOR_SWEEP }[name] ?? [{}]);
      for (const args of calls) {
        const text = JSON.stringify((await h.tool(token, "PRIV", name, args)).raw);
        expect(text, `${name} deixou sair um e-mail`).not.toMatch(emailish);
        expect(text, `${name} deixou sair um id do Clerk`).not.toMatch(idish);
      }
    }
  });
});

const CALLS_FOR_SWEEP: Record<string, Record<string, unknown>[]> = {
  search_tickets: [{ query: "Raiz" }],
  get_ticket: [{ key: "PRIV-1" }, { key: "PRIV-3" }],
  list_tickets: [{}],
  get_work_queue: [{}],
  update_ticket_status: [{ key: "PRIV-3", status: "in_progress" }],
  add_comment: [{ key: "PRIV-3", body: "um comentário" }],
  set_agent_work: [{ key: "PRIV-3", working: true }],
  set_ticket_priority: [{ key: "PRIV-3", priority: 5 }],
  create_ticket: [{ title: "Ticket novo" }],
  update_ticket: [{ key: "PRIV-3", title: "Filho B renomeado" }],
  move_ticket: [{ key: "PRIV-3", parent: "PRIV-4" }],
  add_dependency: [{ key: "PRIV-3", dependsOn: "PRIV-2" }],
  remove_dependency: [{ key: "PRIV-3", dependsOn: "PRIV-2" }],
  set_ticket_assignees: [{ key: "PRIV-3", personIds: [] }],
  list_comments: [{ key: "PRIV-3" }],
  get_ticket_history: [{ key: "PRIV-3" }],
  continue_linear_sync: [{ runId: RUN_ID }],
};

describe("uuid em maiúsculas (revisão de segurança)", () => {
  it("set_ticket_assignees com id em maiúsculas é idempotente e grava minúsculas no evento", async () => {
    const { token } = await setup({ scope: "write" });
    const upper = P().reader.toUpperCase();
    const first = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [upper] });
    expect(refused(first), first.text).toBe(false);
    const again = await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [upper] });
    expect(refused(again), again.text).toBe(false);
    expect(await assignees(3)).toEqual([NAMES["reader"]]);
    const added = await events("ticket.assignee_added");
    expect(added).toHaveLength(1);
    expect((added[0]?.["payload"] as { personId: string }).personId).toBe(P().reader);
    // Tirar: lista vazia remove uma vez, com o id em minúsculas no evento.
    await h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [] });
    expect((await events("ticket.assignee_removed")).map((e) => (e["payload"] as { personId: string }).personId)).toEqual([P().reader]);
  });
  it("PUT e DELETE da tela com id em maiúsculas: idempotente, evento em minúsculas, sem 500", async () => {
    await seedProject(h.pool, priv(), P().manager, P().contributor);
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["id"] as string;
    const url = `/api/tickets/${ticket}/assignees/${P().reader.toUpperCase()}`;
    expect((await h.call("PUT", url, as("manager"))).status).toBe(200);
    expect((await h.call("PUT", url, as("manager"))).status).toBe(200);
    const added = await events("ticket.assignee_added");
    expect(added).toHaveLength(1);
    expect((added[0]?.["payload"] as { personId: string }).personId).toBe(P().reader);
    expect((await h.rows("select person_id::text p from ticket_assignees where ticket_id = $1", [ticket]))).toEqual([{ p: P().reader }]);
    expect((await h.call("DELETE", url, as("manager"))).status).toBe(204);
    expect((await events("ticket.assignee_removed")).map((e) => (e["payload"] as { personId: string }).personId)).toEqual([P().reader]);
  });
});

describe("a criação do token relê a chave da organização dentro da transação (corrida real)", () => {
  /** Uma transação do administrador desliga a chave e fica aberta; a criação do token chega no meio; só então o desligar é confirmado. */
  async function raceCreate(column: "mcp_people_enabled" | "mcp_enabled", body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    await h.enableMcp();
    await keys({ people: true });
    const admin = await h.pool.connect();
    try {
      await admin.query("begin");
      await admin.query(`update organizations set ${column} = false where org_id = $1`, [ORG]);
      const creating = h.create("contributor", priv(), body).then((res) => res); // `.then` dispara a requisição (supertest é preguiçoso)
      // Espera a criação ficar parada na trava da linha da organização (com a correção); sem ela a criação termina sem esperar.
      const deadline = Date.now() + 3000;
      let waiting = 0;
      while (Date.now() < deadline && waiting === 0) {
        waiting = Number((await h.rows("select count(*)::int c from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()"))[0]?.["c"]);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query("commit");
      const res = await creating;
      return { status: res.status, body: res.body };
    } finally {
      admin.release();
    }
  }
  it("people: true não nasce se a chave de pessoas foi desligada no meio", async () => {
    const res = await raceCreate("mcp_people_enabled", { people: true });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe("mcp_people_disabled");
    expect(await h.rows("select id from access_tokens")).toEqual([]);
  });
  it("o token não nasce se a chave geral do MCP foi desligada no meio", async () => {
    const res = await raceCreate("mcp_enabled", {});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe("mcp_disabled");
    expect(await h.rows("select id from access_tokens")).toEqual([]);
  });
  it("a chave de ESCRITA não é conferida na criação (vale a cada chamada); token de escrita nasce e fica sem efeito", async () => {
    await h.enableMcp();
    await h.pool.query("update organizations set mcp_write_enabled = false where org_id = $1", [ORG]);
    const res = await h.create("contributor", priv(), { scope: "write" });
    expect(res.status).toBe(201);
    const names = ((await h.rpc(res.body.token, "PRIV", "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("update_ticket_status");
  });
});

describe("concorrência nos responsáveis (revisão de segurança; várias rodadas, requisições reais)", () => {
  const ROUNDS = 8;
  const state = async () => (await h.rows("select a.person_id::text p from ticket_assignees a join tickets t on t.id = a.ticket_id where t.project_id = $1 and t.number = 3 order by 1", [priv()])).map((r) => r["p"] as string);
  /** Reproduz os eventos: o que foi adicionado menos o que foi removido, por pessoa; e confere que nenhum evento repete. */
  const replay = async (): Promise<string[]> => {
    const rows = await h.rows("select kind, payload->>'personId' p from activity_events where kind in ('ticket.assignee_added','ticket.assignee_removed') order by created_at, id");
    const live = new Set<string>();
    for (const row of rows) {
      const person = row["p"] as string;
      if (row["kind"] === "ticket.assignee_added") {
        expect(live.has(person), `evento duplicado: ${person} adicionado duas vezes`).toBe(false);
        live.add(person);
      } else {
        expect(live.has(person), `evento sem estado: ${person} removido sem estar`).toBe(true);
        live.delete(person);
      }
    }
    return [...live].sort();
  };
  const reset = async () => {
    await h.pool.query("delete from ticket_assignees where ticket_id in (select id from tickets where project_id = $1 and number = 3)", [priv()]);
    await h.pool.query("delete from activity_events where kind in ('ticket.assignee_added','ticket.assignee_removed')");
  };

  it("duas definições simultâneas a partir de vazio terminam com exatamente UMA das duas listas, e os eventos batem com o estado", async () => {
    const { token } = await setup({ scope: "write" });
    const a = P().reader;
    const b = P().manager;
    const finals = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      await reset();
      const [one, two] = await Promise.all([
        h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [a] }),
        h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [b] }),
      ]);
      expect(refused(one), `rodada ${round}: ${one.text}`).toBe(false);
      expect(refused(two), `rodada ${round}: ${two.text}`).toBe(false);
      const final = await state();
      expect([[a], [b]], `rodada ${round}: estado final ${final.join(",")}`).toContainEqual(final);
      expect(await replay(), `rodada ${round}: eventos não batem com o estado`).toEqual(final);
      finals.add(final.join(","));
    }
    expect(finals.size).toBeGreaterThan(0);
  });

  it("duas definições com listas que se sobrepõem ([A,B] e [B,C]) também terminam numa das duas", async () => {
    const { token } = await setup({ scope: "write" });
    const [a, b, c] = [P().reader, P().manager, P().contributor];
    for (let round = 0; round < ROUNDS; round++) {
      await reset();
      await Promise.all([
        h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [a, b] }),
        h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [b, c] }),
      ]);
      const final = await state();
      expect([[a, b].sort(), [b, c].sort()], `rodada ${round}`).toContainEqual(final);
      expect(await replay()).toEqual(final);
    }
  });

  it("MCP × PUT da tela para a MESMA pessoa: os dois dão sucesso, sem 500, um só evento", async () => {
    const { token } = await setup({ scope: "write" });
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["id"] as string;
    for (let round = 0; round < ROUNDS; round++) {
      await reset();
      const [viaMcp, viaScreen] = await Promise.all([
        h.tool(token, "PRIV", "set_ticket_assignees", { key: "PRIV-3", personIds: [P().reader] }),
        h.call("PUT", `/api/tickets/${ticket}/assignees/${P().reader}`, as("manager")).then((res) => res),
      ]);
      expect(refused(viaMcp), `rodada ${round}: MCP ${viaMcp.text}`).toBe(false);
      expect(viaScreen.status, `rodada ${round}: tela ${JSON.stringify(viaScreen.body)}`).toBe(200);
      expect(await state()).toEqual([P().reader]);
      expect((await events("ticket.assignee_added")).length, `rodada ${round}`).toBe(1);
    }
  });

  it("dois PUT simultâneos da mesma pessoa: os dois 200, um só evento", async () => {
    await seedProject(h.pool, priv(), P().manager, P().contributor);
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["id"] as string;
    for (let round = 0; round < ROUNDS; round++) {
      await reset();
      const url = `/api/tickets/${ticket}/assignees/${P().reader}`;
      const statuses = (await Promise.all([h.call("PUT", url, as("manager")).then((r) => r), h.call("PUT", url, as("manager")).then((r) => r)])).map((r) => r.status);
      expect(statuses, `rodada ${round}`).toEqual([200, 200]);
      expect((await events("ticket.assignee_added")).length).toBe(1);
    }
  });
});
