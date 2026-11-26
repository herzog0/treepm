/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { rpcBody, rpcHeaders, seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG } from "./world.js";

const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const MAX_JSON = 80_000;

async function setup(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  return (await h.issue("contributor")).token;
}

/** Os dois formatos do resultado dizem o mesmo, e o texto cabe no teto. */
function expectConsistent(res: ToolResponse): void {
  expect(res.status).toBe(200);
  expect(res.json).toBeDefined();
  expect(res.data).toEqual(res.json);
  expect(res.text.length).toBeLessThanOrEqual(MAX_JSON);
}

describe("search_tickets", () => {
  it("devolve resumos com chave real, título, trecho, situação e a chave do pai", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "filho" });
    expectConsistent(res);
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({
      tickets: [
        { key: "PRIV-2", title: "Filho A", excerpt: "Primeiro filho", status: "done", parent: "PRIV-1", idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [] },
        { key: "PRIV-3", title: "Filho B", excerpt: "Segundo filho sobre relatórios", status: "todo", parent: "PRIV-1", idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [] },
      ],
      truncated: false,
    });
  });

  it("acha pela chave e respeita limit", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "search_tickets", { query: "PRIV-4" })).json?.["tickets"][0].key).toBe("PRIV-4");
    const one = await h.tool(token, "PRIV", "search_tickets", { query: "filho", limit: 1 });
    expect(one.json?.["tickets"]).toHaveLength(1);
    expect(one.json?.["truncated"]).toBe(true);
  });

  it("sem resultado: lista vazia, não erro", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "nada-disso-existe" });
    expectConsistent(res);
    expect(res.json).toEqual({ tickets: [], truncated: false });
  });

  it("projeto sem tickets: vazio", async () => {
    await h.enableMcp();
    const created = await h.create("admin", h.world().projects.org);
    const res = await h.tool(created.body.token, "OPEN", "search_tickets", { query: "qualquer" });
    expect(res.json).toEqual({ tickets: [], truncated: false });
  });

  it("entrada inválida vira erro da ferramenta, em inglês, sem derrubar a requisição", async () => {
    const token = await setup();
    for (const args of [{}, { query: "" }, { query: 5 }, { query: "a", limit: 0 }, { query: "a", limit: 1000 }, { query: "a", extra: 1 }]) {
      const res = await h.tool(token, "PRIV", "search_tickets", args);
      expect(res.status).toBe(200);
      expect(res.isError).toBe(true);
      expect(res.text.length).toBeGreaterThan(0);
      expect(res.text.length).toBeLessThan(300);
      expect(res.text).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("get_ticket", () => {
  it("não devolve comentário, nem a busca acha texto de comentário (ADR 0040)", async () => {
    const token = await setup();
    const word = "COMENTARIO-RECONHECIVEL-9Z4";
    const [ticket] = (await h.pool.query("select id from tickets where project_id = $1 and number = 2", [priv()])).rows;
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ('org_A', $1, $2, $3, $4)", [priv(), ticket.id, h.world().people.manager, `${word} texto só da conversa`]);
    // ADR 0041: uma contribuição de área, com texto, nome de área e pessoa reconhecíveis, no mesmo ticket.
    const area = (await h.pool.query("insert into areas (org_id, name) values ('org_A', $1) returning id", [`${word}-AREA`])).rows[0];
    await h.pool.query("update people set display_name = $1 where id = $2", [`${word}-PESSOA`, h.world().people.target]);
    const contribution = (await h.pool.query(
      "insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id, text, status) values ('org_A', $1, $2, $3, $4, $5, 'done') returning id",
      [priv(), ticket.id, area.id, h.world().people.manager, `${word}-CONTRIBUICAO entrega da área`],
    )).rows[0];
    await h.pool.query("insert into ticket_contribution_people (org_id, contribution_id, person_id) values ('org_A', $1, $2)", [contribution.id, h.world().people.target]);
    // ADR 0041, fatia 2: um comentário da área e outro de uma área já removida (nome guardado), com texto reconhecível.
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, contribution_id) values ('org_A', $1, $2, $3, $4, $5)", [priv(), ticket.id, h.world().people.manager, `${word}-COMENTARIO-DE-AREA conversa da área`, contribution.id]);
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, area_name) values ('org_A', $1, $2, $3, $4, $5)", [priv(), ticket.id, h.world().people.manager, `${word}-COMENTARIO-DE-AREA-REMOVIDA conversa antiga`, `${word}-AREA-REMOVIDA`]);
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expectConsistent(res);
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(word);
    expect(res.text).not.toContain("só da conversa");
    expect(res.text).not.toContain("entrega da área");
    expect(res.text).not.toContain("conversa da área");
    expect(res.text).not.toContain("conversa antiga");
    expect(Object.keys(res.json ?? {})).not.toContain("comments");
    expect(Object.keys(res.json ?? {})).not.toContain("contributions");
    for (const [name, args] of [["search_tickets", { query: word }], ["search_tickets", { query: "conversa" }], ["get_project_overview", {}], ["list_tickets", {}], ["get_ticket", { key: "PRIV-1" }]] as const) {
      const out = await h.tool(token, "PRIV", name, args);
      expect(out.text, name).not.toContain(word);
      expect(out.text, name).not.toContain("só da conversa");
      expect(out.text, name).not.toContain("entrega da área");
      expect(out.text, name).not.toContain("conversa da área");
      expect(out.text, name).not.toContain("conversa antiga");
    }
    expect((await h.tool(token, "PRIV", "search_tickets", { query: word })).json).toEqual({ tickets: [], truncated: false });
  });

  it("devolve o ticket com descrição inteira, pai, caminho, filhos e ligações nos dois sentidos", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expectConsistent(res);
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({
      key: "PRIV-2",
      title: "Filho A",
      description: "Primeiro filho",
      status: "done",
      idea: null,
      agentWork: null,
      priority: 0,
      effective_priority: 0,
      dueDate: null,
      overdue: false,
      labels: [],
      parent: "PRIV-1",
      path: [{ key: "PRIV-1", title: "Raiz do projeto", excerpt: "Descrição inteira da raiz. Ver PRIV-4.", status: "in_progress", parent: null, idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [] }],
      children: { tickets: [], truncated: false },
      relations: {
        mentions: { outgoing: { tickets: [], truncated: false }, incoming: { tickets: [], truncated: false } },
        depends_on: {
          outgoing: { tickets: [], truncated: false },
          incoming: { tickets: [{ key: "PRIV-4", title: "Solto", excerpt: "Depende de PRIV-2", status: "todo", parent: null, idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [] }], truncated: false },
        },
        related: { tickets: [], truncated: false },
      },
      // Ticket criado no TreePM: sem origem no Linear (ADR 0062, seção 5).
      linear: null,
    });
    const root = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(root.json?.["parent"]).toBeNull();
    expect(root.json?.["path"]).toEqual([]);
    expect(root.json?.["children"].tickets.map((t: any) => t.key)).toEqual(["PRIV-2", "PRIV-3"]);
    expect(root.json?.["relations"].mentions.outgoing.tickets.map((t: any) => t.key)).toEqual(["PRIV-4"]);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" })).json?.["relations"].mentions.incoming.tickets.map((t: any) => t.key)).toEqual(["PRIV-1"]);
  });

  it("aceita a chave em minúsculas", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "get_ticket", { key: " priv-3 " })).json?.["key"]).toBe("PRIV-3");
  });

  it.each([["PRIV-999"], ["PRIV-0"], ["lixo"], ["PRIV"], ["PRIV-1x"], ["OPEN-1"], ["OUTRO-1"], ["PRIV--1"], ["PRIV-99999999999999999999"]])(
    "chave %s: erro da ferramenta com uma frase curta em inglês",
    async (key) => {
      const token = await setup();
      const res = await h.tool(token, "PRIV", "get_ticket", { key });
      expect(res.status).toBe(200);
      expect(res.isError).toBe(true);
      expect(res.text.length).toBeLessThan(300);
      expect(res.text).toMatch(/^[\x20-\x7e]+$/);
    },
  );

  it("sem a chave: erro da ferramenta", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "get_ticket", {})).isError).toBe(true);
  });
});

describe("list_tickets", () => {
  it("lista tudo em ordem de número, com truncated e after", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "list_tickets");
    expectConsistent(res);
    expect(res.json?.["tickets"].map((t: any) => t.key)).toEqual(["PRIV-1", "PRIV-2", "PRIV-3", "PRIV-4"]);
    expect(res.json?.["truncated"]).toBe(false);
    expect(res.json?.["after"]).toBeNull();
  });

  it("filtra por situação (lista) e por ramo (under)", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "list_tickets", { status: ["done", "in_progress"] })).json?.["tickets"].map((t: any) => t.key)).toEqual(["PRIV-1", "PRIV-2"]);
    expect((await h.tool(token, "PRIV", "list_tickets", { under: "PRIV-1" })).json?.["tickets"].map((t: any) => t.key)).toEqual(["PRIV-2", "PRIV-3"]);
  });

  it("pagina com limit e after (chave)", async () => {
    const token = await setup();
    const first = await h.tool(token, "PRIV", "list_tickets", { limit: 3 });
    expect(first.json?.["truncated"]).toBe(true);
    expect(first.json?.["after"]).toBe("PRIV-3");
    const next = await h.tool(token, "PRIV", "list_tickets", { limit: 3, after: first.json?.["after"] });
    expect(next.json?.["tickets"].map((t: any) => t.key)).toEqual(["PRIV-4"]);
    expect(next.json?.["truncated"]).toBe(false);
    expect(next.json?.["after"]).toBeNull();
  });

  it("entradas inválidas: situação desconhecida, chave malformada, ticket que não existe, chave de outro projeto", async () => {
    const token = await setup();
    for (const args of [{ status: ["feito"] }, { status: "done" }, { under: "lixo" }, { under: "PRIV-99" }, { under: "OPEN-1" }, { after: "OPEN-1" }, { after: "x" }, { limit: 0 }]) {
      const res = await h.tool(token, "PRIV", "list_tickets", args);
      expect(res.status).toBe(200);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.text).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("get_project_overview", () => {
  it("conta por situação e traz o topo com progresso", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "get_project_overview");
    expectConsistent(res);
    expect(res.json).toEqual({
      project: "PRIV",
      total: 4,
      ideas: { new: 0, refining: 0, ready: 0, discarded: 0 },
      by_status: { todo: 2, in_progress: 1, in_review: 0, done: 1, cancelled: 0 },
      top: {
        tickets: [
          { key: "PRIV-1", title: "Raiz do projeto", excerpt: "Descrição inteira da raiz. Ver PRIV-4.", status: "in_progress", parent: null, idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [], progress: { done: 1, total: 2, excluded: 0, ideas: 0 } },
          { key: "PRIV-4", title: "Solto", excerpt: "Depende de PRIV-2", status: "todo", parent: null, idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false, labels: [], progress: null },
        ],
        truncated: false,
      },
    });
  });

  it("com uma ideia no projeto: o progresso do pai não a conta e ideas vale 1 (ADR 0042)", async () => {
    const token = await setup();
    const parent = (await h.pool.query("select id from tickets where project_id = $1 and number = 1", [priv()])).rows[0].id as string;
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, parent_id, idea_stage, created_by_person_id) values ('org_A', $1, 90, 'Ideia', $2, 'new', $3)",
      [priv(), parent, h.world().people.admin],
    );
    const res = await h.tool(token, "PRIV", "get_project_overview");
    expectConsistent(res);
    const root = (res.json as { top: { tickets: { key: string; progress: unknown }[] } }).top.tickets.find((t) => t.key === "PRIV-1");
    expect(root?.progress).toEqual({ done: 1, total: 2, excluded: 0, ideas: 1 });
  });

  it("projeto vazio", async () => {
    await h.enableMcp();
    const created = await h.create("admin", h.world().projects.org);
    const res = await h.tool(created.body.token, "OPEN", "get_project_overview");
    expect(res.json).toEqual({ project: "OPEN", total: 0, ideas: { new: 0, refining: 0, ready: 0, discarded: 0 }, by_status: { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 }, top: { tickets: [], truncated: false } });
  });
});

describe("teto de 80.000 caracteres", () => {
  async function seedMany(count: number, parentNumber: number | null = null): Promise<void> {
    const title = "T".repeat(150);
    const description = "d".repeat(900);
    await h.pool.query(
      `insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id)
       select $1, $2, n, case when $5::int is null then null else (select id from tickets where project_id = $2 and number = $5) end, $3 || n, $4, $6
       from generate_series(100, 100 + $7::int - 1) as n`,
      [ORG, priv(), title, description, parentNumber, h.world().people.manager, count],
    );
  }

  it("list_tickets no teto da página (200) é cortada e diz truncated; after aponta o último que coube", async () => {
    const token = await setup();
    await seedMany(260);
    const res = await h.tool(token, "PRIV", "list_tickets", { limit: 200 });
    expectConsistent(res);
    expect(res.json?.["truncated"]).toBe(true);
    const keys = res.json?.["tickets"].map((t: any) => t.key) as string[];
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.length).toBeLessThan(200);
    expect(res.json?.["after"]).toBe(keys.at(-1));
    // A página seguinte continua de onde parou, sem buraco.
    const next = await h.tool(token, "PRIV", "list_tickets", { limit: 200, after: res.json?.["after"] });
    expect(next.json?.["tickets"][0].key).toBe(`PRIV-${Number((res.json?.["after"] as string).slice(5)) + 1}`);
  });

  it("get_ticket corta filhos e ligações, nunca a descrição", async () => {
    const token = await setup();
    await seedMany(260, 1);
    const long = "descrição longa ".repeat(1200);
    await h.pool.query("update tickets set description = $2 where project_id = $1 and number = 1", [priv(), long]);
    const res = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expectConsistent(res);
    expect(res.json?.["description"]).toBe(long);
    expect(res.json?.["children"].truncated).toBe(true);
    expect(res.json?.["children"].tickets.length).toBeLessThan(200);
  });

  it("search_tickets no teto de 50 resultados cabe no limite", async () => {
    const token = await setup();
    await seedMany(80);
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "TTTT", limit: 50 });
    expectConsistent(res);
  });

  it("get_project_overview com muitos tickets no topo cabe no limite", async () => {
    const token = await setup();
    await seedMany(260);
    const res = await h.tool(token, "PRIV", "get_project_overview");
    expectConsistent(res);
    expect(res.json?.["top"].truncated).toBe(true);
    expect(res.json?.["total"]).toBe(264);
  });
});

describe("nada de pessoa nem de id em nenhuma resposta", () => {
  it("varre tudo o que volta, com responsáveis, autor e e-mails semeados", async () => {
    const token = await setup();
    const w = h.world();
    await h.pool.query("update people set display_name = 'Fulana Reconhecível Silva', email = 'fulana.reconhecivel@exemplo.test' where id = $1", [w.people.contributor]);
    await h.pool.query("update people set display_name = 'Beltrano Autor Souza', email = 'beltrano.autor@exemplo.test' where id = $1", [w.people.manager]);
    const responses: string[] = [];
    const calls: [string, Record<string, unknown>][] = [
      ["search_tickets", { query: "filho" }],
      ["search_tickets", { query: "PRIV-1" }],
      ["get_ticket", { key: "PRIV-1" }],
      ["get_ticket", { key: "PRIV-4" }],
      ["get_ticket", { key: "PRIV-2" }],
      ["list_tickets", {}],
      ["list_tickets", { under: "PRIV-1" }],
      ["get_project_overview", {}],
      ["get_ticket", { key: "PRIV-777" }],
      ["list_tickets", { status: ["nope"] }],
    ];
    for (const [name, args] of calls) responses.push(JSON.stringify((await h.tool(token, "PRIV", name, args)).raw));
    for (const method of ["tools/list", "server/discover"]) responses.push(JSON.stringify((await h.rpc(token, "PRIV", method)).body));
    const all = responses.join("\n");
    const ids = (await h.rows("select id from tickets union select id from people union select id from projects union select id from access_tokens union select id from ticket_relations")).map((r) => String(r["id"]));
    for (const id of ids) expect(all).not.toContain(id);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const banned of ["Fulana", "Reconhec", "Beltrano", "Souza", "@exemplo.test", "u_contributor", "u_manager", "org_A", "assignee", "createdBy", "created_by", "clerk"]) {
      expect(all, banned).not.toContain(banned);
    }
    for (const field of ["parentId", "number", "createdAt", "updatedAt", "assignees", "descriptionExcerpt"]) expect(all).not.toContain(`"${field}"`);
    // Nenhum objeto do resultado tem a chave `id`.
    const keysOf = (value: unknown): string[] => (value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : []);
    for (const response of responses) expect(keysOf(JSON.parse(response).result?.structuredContent)).not.toContain("id");
    // Sem datas.
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it("o erro de ferramenta também não vaza", async () => {
    const token = await setup();
    const res = await h.post(token, "PRIV", rpcBody("tools/call", { name: "get_ticket", arguments: { key: "PRIV-1; drop table" } }), rpcHeaders("tools/call", { name: "get_ticket" }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|select|postgres|stack|at .*\(/i);
  });
});
