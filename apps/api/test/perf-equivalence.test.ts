import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpGateway } from "../src/mcp/mcp-gateway.js";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { createTestApp, ownerPoolWithCleanup } from "./helpers.js";
import { rpcBody, rpcHeaders } from "./mcp-support.js";
import { expectGolden, loadPerfWorld, perfClock, perfSession } from "./perf-support.js";
import type { PerfWorld } from "./perf-support.js";

// Rede de segurança das otimizações do projeto grande (TREEPM-251): as respostas da API e do MCP, num projeto gerado com
// semente (ideias de todos os estágios, descartadas, marcadores, descrições vazias, com emoji, compostos e quebras), têm de
// ser idênticas, campo a campo e na mesma ordem, às que o código ANTES das otimizações devolvia. As referências em
// `fixtures/perf-equivalence` foram geradas com o código antigo (`UPDATE_GOLDEN=1`); não as regrave para fazer um teste passar.
const pool = ownerPoolWithCleanup();
let app: INestApplication;
let world: PerfWorld;
let token = "";
const get = (path: string) => request(app.getHttpServer()).get(path).set("x-test-session", perfSession);
const patch = (path: string, body: unknown) => request(app.getHttpServer()).patch(path).set("x-test-session", perfSession).send(body as object);
const pid = (): string => world.plan.projectId;
const T = (i: number) => world.plan.tickets[i]!;

/** Chamada de ferramenta do MCP; devolve o conteúdo estruturado. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  app.get(McpGateway).resetMemory();
  app.get(AccessTokenService).resetMemory();
  const params = { name, arguments: args };
  const res = await request(app.getHttpServer()).post("/api/mcp/BG").set(rpcHeaders("tools/call", params)).set("authorization", `Bearer ${token}`).send(rpcBody("tools/call", params) as object);
  expect(res.status).toBe(200);
  expect(res.body.result.isError, JSON.stringify(res.body)).not.toBe(true);
  return { structured: res.body.result.structuredContent, text: res.body.result.content?.[0]?.text };
}

/** Uma segunda organização com um projeto e dois tickets (pai e filho), semeada pelo papel dono, que a sessão do teste não enxerga. */
async function foreignTicket(): Promise<{ project: string; parent: string; child: string }> {
  await pool.query("insert into organizations (org_id, name, slug) values ('org_outra', 'Outra', 'org-outra') on conflict do nothing");
  const person = (await pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_outra', 'u_outra', 'Outra pessoa', 'outra@x.test', 'admin') returning id")).rows[0]!.id;
  const project = (await pool.query<{ id: string }>("insert into projects (org_id, name, key, visibility) values ('org_outra', 'Outro', 'OUT', 'organization') returning id")).rows[0]!.id;
  const parent = (await pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, description, status, idea_stage, created_by_person_id) values ('org_outra', $1, 1, 'Pai de fora', '', 'todo', 'new', $2) returning id", [project, person])).rows[0]!.id;
  const child = (await pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, description, status, parent_id, created_by_person_id) values ('org_outra', $1, 2, 'Filho de fora', '', 'todo', $2, $3) returning id", [project, parent, person])).rows[0]!.id;
  return { project, parent, child };
}

const withoutVolatile = (page: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...page };
  delete rest["updatedAt"];
  return rest;
};

beforeAll(async () => {
  ({ app } = await createTestApp([], undefined, { clock: perfClock }));
  world = await loadPerfWorld(pool);
  const created = await request(app.getHttpServer()).post("/api/access-tokens").set("x-test-session", perfSession).send({ projectId: pid(), name: "Equivalência", expiresInDays: 30 });
  expect(created.status).toBe(201);
  token = created.body.token as string;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("o projeto de teste cobre os casos que as otimizações podem estragar", () => {
  it("tem ideias de todos os estágios, descendentes de ideia, marcadores, descrições vazias e longas e responsáveis", async () => {
    const tickets = world.plan.tickets;
    expect(new Set(tickets.map((t) => t.ideaStage).filter(Boolean))).toEqual(new Set(["new", "refining", "ready", "discarded"]));
    expect(tickets.some((t) => t.agentWork)).toBe(true);
    expect(tickets.some((t) => t.description === "")).toBe(true);
    expect(tickets.some((t) => t.assignees.length > 0)).toBe(true);
    const list = (await get(`/api/projects/${pid()}/tickets`)).body as { idea: { root: boolean } | null; progress: unknown; agentWork: unknown }[];
    expect(list.some((t) => t.idea?.root === false)).toBe(true);
    expect(list.some((t) => t.progress !== null)).toBe(true);
  });
});

/** O progresso e a situação de ideia do detalhe (por consulta recursiva do ramo) são os da lista (cálculo em memória do projeto inteiro). */
async function detailAgreesWithList(): Promise<number> {
  const list = (await get(`/api/projects/${pid()}/tickets`)).body as { id: string; progress: unknown; idea: unknown; status: string }[];
  const hasChildren = new Set(world.plan.tickets.map((t) => (t.parent === null ? null : T(t.parent).id)));
  let checked = 0;
  for (const [i, entry] of list.entries()) {
    if (!hasChildren.has(entry.id) && entry.idea === null && i % 5 !== 0) continue;
    const detail = (await get(`/api/tickets/${entry.id}`)).body as { progress: unknown; idea: unknown; status: string };
    expect(detail.progress, entry.id).toEqual(entry.progress);
    expect(detail.idea, entry.id).toEqual(entry.idea);
    checked += 1;
  }
  return checked;
}

describe("HTTP: respostas idênticas às de antes", () => {
  it("o detalhe concorda com a lista (progresso e ideia) em todo ticket com filhos, em ideia ou amostrado", async () => {
    expect(await detailAgreesWithList()).toBeGreaterThan(150);
  });

  it("lista de tickets do projeto", async () => {
    const res = await get(`/api/projects/${pid()}/tickets`);
    expect(res.status).toBe(200);
    expectGolden("list", res.body);
  });

  it("trecho da descrição nos casos de borda (600 pontos, pares substitutos, compostos, quebras de linha)", async () => {
    const list = (await get(`/api/projects/${pid()}/tickets`)).body as { id: string; descriptionExcerpt: string }[];
    const byId = new Map(list.map((t) => [t.id, t.descriptionExcerpt]));
    expectGolden("excerpts", Object.fromEntries(Object.entries(world.edgeIds).map(([name, id]) => [name, byId.get(id)])));
  });

  it("detalhe de tickets: raiz, fundo, ideias de todos os estágios, dentro de ideia, com marcador, com histórico, casos de borda", async () => {
    const f = world.plan.fixtures;
    const roots = world.plan.tickets.filter((t) => t.ideaStage);
    const inside = world.plan.tickets.filter((t) => t.parent !== null && !t.ideaStage && roots.some((r) => r.index === t.parent)).slice(0, 4);
    const withChildren = world.plan.tickets.filter((t) => world.plan.tickets.some((c) => c.parent === t.index && !c.ideaStage)).filter((_, i) => i % 9 === 0).slice(0, 10);
    const marked = world.plan.tickets.filter((t) => t.agentWork).slice(0, 3);
    const picks = new Map<number, string>();
    const add = (label: string, index: number): void => void picks.set(index, label);
    for (const [label, index] of Object.entries({ deep: f.deep, shallow: f.shallow, history: f.history, idea: f.idea, doneLeaf: f.doneLeaf, move: f.move, moveFrom: f.moveFrom, moveTo: f.moveTo })) add(label, index);
    for (const index of f.doneChain) add(`doneChain-${index}`, index);
    roots.forEach((t) => add(`root-${t.ideaStage}-${t.index}`, t.index));
    inside.forEach((t) => add(`inside-${t.index}`, t.index));
    withChildren.forEach((t) => add(`parent-${t.index}`, t.index));
    marked.forEach((t) => add(`marked-${t.index}`, t.index));
    const out: Record<string, unknown> = {};
    for (const [index, label] of picks) {
      const res = await get(`/api/tickets/${T(index).id}`);
      expect(res.status, label).toBe(200);
      out[label] = res.body;
    }
    for (const [name, id] of Object.entries(world.edgeIds)) out[`edge-${name}`] = (await get(`/api/tickets/${id}`)).body;
    expect(Object.keys(out).length).toBeGreaterThan(25);
    expectGolden("details", out);
  });

  it("tela Ideias", async () => {
    const res = await get(`/api/projects/${pid()}/ideas`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    expectGolden("ideas", res.body);
  });

  it("ticket inexistente e de outra organização continuam 404", async () => {
    const res = await get("/api/tickets/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expectGolden("detail-404", res.body);
    // De outra organização DE VERDADE: o ticket existe (e tem filhos, dentro de uma ideia), mas pertence a quem a sessão não enxerga.
    const other = await foreignTicket();
    const foreign = await get(`/api/tickets/${other.parent}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(res.body);
    expect((await get(`/api/tickets/${other.child}`)).status).toBe(404);
    expect((await patch(`/api/tickets/${other.child}`, { status: "in_progress" })).status).toBe(404);
    expect((await get(`/api/projects/${other.project}/tickets`)).status).toBe(404);
    expect((await get(`/api/projects/${other.project}/ideas`)).status).toBe(404);
    // E ele segue intacto no banco: a organização de fora não foi tocada.
    expect((await pool.query("select count(*)::int as n from tickets where org_id = $1", ["org_outra"])).rows[0]).toEqual({ n: 2 });
  });
});

describe("MCP: respostas idênticas às de antes", () => {
  it("list_tickets: páginas de 50, de 120, de 200, com situação e com ramo", async () => {
    const f = world.plan.fixtures;
    const out: Record<string, unknown> = {};
    out["first50"] = await tool("list_tickets");
    out["first120"] = await tool("list_tickets", { limit: 120 });
    const pages: unknown[] = [];
    for (let after: string | null = null, guard = 0; guard < 20; guard += 1) {
      const page = (await tool("list_tickets", { limit: 200, ...(after ? { after } : {}) })) as { structured: { after: string | null } };
      pages.push(page);
      after = page.structured.after;
      if (after === null) break;
    }
    out["enumerate200"] = pages;
    out["done"] = await tool("list_tickets", { status: ["done"], limit: 25 });
    out["todoAndReview"] = await tool("list_tickets", { status: ["todo", "in_review"], limit: 20 });
    out["underRoot"] = await tool("list_tickets", { under: `BG-${T(f.shallow).number}`, limit: 40 });
    out["underDeep"] = await tool("list_tickets", { under: `BG-${T(f.moveTo).number}` });
    out["underIdea"] = await tool("list_tickets", { under: `BG-${T(f.idea).number}` });
    expectGolden("mcp-list", out);
  });

  it("get_ticket: fundo, raso, ideia, dentro de ideia, com marcador", async () => {
    const f = world.plan.fixtures;
    const roots = world.plan.tickets.filter((t) => t.ideaStage);
    const inside = world.plan.tickets.find((t) => t.parent !== null && roots.some((r) => r.index === t.parent) && !t.ideaStage);
    const marked = world.plan.tickets.find((t) => t.agentWork);
    const out: Record<string, unknown> = {};
    for (const [label, index] of Object.entries({ deep: f.deep, shallow: f.shallow, idea: f.idea, history: f.history, inside: inside!.index, marked: marked!.index })) {
      out[label] = await tool("get_ticket", { key: `BG-${T(index).number}` });
    }
    for (const r of roots) out[`root-${r.ideaStage}-${r.index}`] = await tool("get_ticket", { key: `BG-${r.number}` });
    expectGolden("mcp-get", out);
  });

  it("get_project_overview e search_tickets", async () => {
    const out: Record<string, unknown> = { overview: await tool("get_project_overview") };
    for (const query of ["relatórios", "ação", "BG-3", "estoque", "zzzz inexistente", "😀", "pagamentos importação", "e"]) out[`search:${query}`] = await tool("search_tickets", { query });
    out["search:limit50"] = await tool("search_tickets", { query: "o", limit: 50 });
    out["search:limit3"] = await tool("search_tickets", { query: "tela", limit: 3 });
    expectGolden("mcp-search", out);
  });
});

describe("HTTP: escritas devolvem o mesmo, e a árvore resultante é a mesma", () => {
  it("mudar situação (com e sem propagação) e mover de pai", async () => {
    const f = world.plan.fixtures;
    const out: Record<string, unknown> = {};
    const leaf = world.plan.tickets.filter((t) => t.status === "todo" && t.depth >= 6 && !t.ideaStage && !t.agentWork && !world.plan.tickets.some((c) => c.parent === t.index)).at(0)!;
    const write = async (label: string, id: string, body: unknown, status = 200): Promise<void> => {
      const res = await patch(`/api/tickets/${id}`, body);
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(status);
      out[label] = status === 200 ? withoutVolatile(res.body) : res.body;
    };
    await write("reopen-chain", T(f.doneLeaf).id, { status: "todo" });
    await write("leaf-in-progress", leaf.id, { status: "in_progress" });
    await write("leaf-back", leaf.id, { status: "todo" });
    await write("move-to", T(f.move).id, { parentId: T(f.moveTo).id });
    await write("move-back", T(f.move).id, { parentId: T(f.moveFrom).id });
    await write("move-to-root", T(f.move).id, { parentId: null });
    await write("move-to-self", T(f.move).id, { parentId: T(f.move).id }, 409);
    // Ciclo: o pai de um ticket não pode ser um descendente dele.
    const child = world.plan.tickets.find((t) => t.parent === f.shallow)!;
    await write("cycle", T(f.shallow).id, { parentId: child.id }, 409);
    await write("title", leaf.id, { title: "Outro título" });
    await write("done-with-open-children", T(f.shallow).id, { status: "done" }, 409);
    await write("parent-not-found", leaf.id, { parentId: "00000000-0000-4000-8000-000000000001" }, 404);
    // Mover para dentro de uma ideia: recusado enquanto andamento, aceito quando é só "a fazer".
    const idea = world.plan.tickets.find((t) => t.ideaStage === "refining")!;
    await write("move-into-idea", leaf.id, { parentId: idea.id });
    await write("move-out-of-idea", leaf.id, { parentId: T(f.moveFrom).id });
    expectGolden("writes", out);
    // A árvore depois das escritas, vista pela lista, pelos detalhes dos pais alterados e pela tela Ideias.
    expectGolden("after-writes-list", (await get(`/api/projects/${pid()}/tickets`)).body);
    const after: Record<string, unknown> = {};
    for (const index of [...f.doneChain, f.moveFrom, f.moveTo, f.shallow, idea.index]) after[String(index)] = withoutVolatile((await get(`/api/tickets/${T(index).id}`)).body);
    expectGolden("after-writes-details", after);
    expectGolden("after-writes-ideas", (await get(`/api/projects/${pid()}/ideas`)).body);
    expectGolden("after-writes-mcp-overview", await tool("get_project_overview"));
    expect(await detailAgreesWithList()).toBeGreaterThan(150);
  });
});
