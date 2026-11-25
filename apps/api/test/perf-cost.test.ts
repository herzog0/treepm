import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpGateway } from "../src/mcp/mcp-gateway.js";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { createTestApp, ownerPoolWithCleanup } from "./helpers.js";
import { rpcBody, rpcHeaders } from "./mcp-support.js";
import { loadPerfWorld, perfClock, perfSession } from "./perf-support.js";
import type { PerfWorld } from "./perf-support.js";
import { recordQueries } from "./query-recorder.js";

// Custo das leituras e escritas do projeto grande (TREEPM-251), contado em consultas e em LINHAS e caracteres lidos do banco,
// nunca em tempo de relógio. O projeto tem 400 tickets; 150 descrições de 20 000 caracteres fazem quem lê descrição inteira aparecer.
const pool = ownerPoolWithCleanup();
let app: INestApplication;
let world: PerfWorld;
let token = "";
const GIANT_EACH = 20_000; // o máximo da descrição
const GIANT_COUNT = 150;
const GIANT = GIANT_EACH * GIANT_COUNT / 2; // metade do que quem lê descrições inteiras traria
const N = 400;
const get = (path: string) => request(app.getHttpServer()).get(path).set("x-test-session", perfSession);
const patch = (path: string, body: unknown) => request(app.getHttpServer()).patch(path).set("x-test-session", perfSession).send(body as object);
const T = (i: number) => world.plan.tickets[i]!;
const descendants = (index: number): number => world.plan.tickets.reduce((sum, t) => sum + (isBelow(t.index, index) ? 1 : 0), 0);
const isBelow = (index: number, ancestor: number): boolean => {
  for (let cursor = world.plan.tickets[index]!.parent; cursor !== null; cursor = world.plan.tickets[cursor]!.parent) if (cursor === ancestor) return true;
  return false;
};
const depthOf = (index: number): number => T(index).depth;

async function mcp(name: string, args: Record<string, unknown> = {}) {
  app.get(McpGateway).resetMemory();
  app.get(AccessTokenService).resetMemory();
  const params = { name, arguments: args };
  return recordQueries(async () => {
    const res = await request(app.getHttpServer()).post("/api/mcp/BG").set(rpcHeaders("tools/call", params)).set("authorization", `Bearer ${token}`).send(rpcBody("tools/call", params) as object);
    expect(res.status).toBe(200);
    expect(res.body.result.isError, JSON.stringify(res.body)).not.toBe(true);
    return res.body.result.structuredContent as Record<string, unknown>;
  });
}

beforeAll(async () => {
  ({ app } = await createTestApp([], undefined, { clock: perfClock }));
  world = await loadPerfWorld(pool, N);
  const edge = new Set(Object.values(world.edgeIds));
  const giants = world.plan.tickets.filter((t) => t.index > 60 && !edge.has(t.id)).slice(0, GIANT_COUNT).map((t) => t.id);
  await pool.query("update tickets set description = $1 where id = any($2::uuid[])", ["x".repeat(GIANT_EACH), giants]);
  const created = await request(app.getHttpServer()).post("/api/access-tokens").set("x-test-session", perfSession).send({ projectId: world.plan.projectId, name: "Custo", expiresInDays: 30 });
  token = created.body.token as string;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("lista do mapa", () => {
  it("lê o trecho da descrição (não a descrição inteira) e não monta `IN` com um parâmetro por ticket", async () => {
    const { result, queries, chars } = await recordQueries(() => get(`/api/projects/${world.plan.projectId}/tickets`));
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(N);
    expect(Math.max(...queries.map((q) => q.params))).toBeLessThanOrEqual(5);
    // As leituras de ticket e de pessoa da lista: uma de tickets, uma de responsáveis e uma das chaves do Linear (ADR 0061), todas por projeto.
    expect(queries.filter((q) => /tickets/.test(q.text)).length, JSON.stringify(queries.map((q) => [q.text.slice(0, 90), q.rows, q.params]))).toBeLessThanOrEqual(4);
    // 601 pontos de código por ticket, no pior caso 4 bytes cada em JSON escapado; o resto das colunas cabe em ~700 caracteres.
    expect(chars).toBeLessThan(N * 700 + N * 601 + 20_000);
    expect(chars).toBeLessThan(GIANT);
  });

  it("cada pessoa aparece uma vez por ticket (a consulta antiga, fatiada pelo Prisma acima de ~16 000 tickets, repetia as pessoas)", async () => {
    const res = await get(`/api/projects/${world.plan.projectId}/tickets`);
    const withPeople = (res.body as { assigneeIds: string[] }[]).filter((t) => t.assigneeIds.length > 0);
    expect(withPeople.length).toBeGreaterThan(20);
    for (const t of withPeople) expect(new Set(t.assigneeIds).size).toBe(t.assigneeIds.length);
  });
});

describe("detalhe e escritas: leem o ramo, não o projeto", () => {
  const rowsBudget = (index: number): number => descendants(index) + depthOf(index) + 45;

  it("detalhe de ticket fundo", async () => {
    const index = world.plan.fixtures.deep;
    const { result, rows, queries } = await recordQueries(() => get(`/api/tickets/${T(index).id}`));
    expect(result.status).toBe(200);
    expect(rows, JSON.stringify(queries.map((q) => [q.text.slice(0, 60), q.rows]))).toBeLessThanOrEqual(rowsBudget(index));
    expect(rows).toBeLessThan(N / 2);
  });

  it("detalhe de ticket raso e de ideia", async () => {
    for (const index of [world.plan.fixtures.shallow, world.plan.fixtures.idea]) {
      const { result, rows } = await recordQueries(() => get(`/api/tickets/${T(index).id}`));
      expect(result.status).toBe(200);
      expect(rows).toBeLessThanOrEqual(rowsBudget(index));
    }
  });

  it("mudar a situação de uma folha funda, com propagação para os pais", async () => {
    const index = world.plan.fixtures.doneLeaf;
    const { result, rows } = await recordQueries(() => patch(`/api/tickets/${T(index).id}`, { status: "todo" }));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(rows).toBeLessThan(N / 2);
    expect(rows).toBeLessThanOrEqual(rowsBudget(index) + 3 * depthOf(index));
  });

  it("mover um ticket de pai (conferência de ciclo por subida de pai em pai)", async () => {
    const f = world.plan.fixtures;
    const { result, rows } = await recordQueries(() => patch(`/api/tickets/${T(f.move).id}`, { parentId: T(f.moveTo).id }));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(rows).toBeLessThan(N / 2);
    expect(rows).toBeLessThanOrEqual(rowsBudget(f.move) + 3 * depthOf(f.move) + depthOf(f.moveTo));
  });
});

describe("tela Ideias", () => {
  it("lê as ideias e o caminho de cada uma, não os títulos do projeto todo", async () => {
    const ideas = world.plan.tickets.filter((t) => t.ideaStage);
    const pathRows = ideas.reduce((sum, t) => sum + t.depth, 0);
    const { result, rows } = await recordQueries(() => get(`/api/projects/${world.plan.projectId}/ideas`));
    expect(result.status).toBe(200);
    expect(rows).toBeLessThanOrEqual(ideas.length + pathRows + 5);
    expect(rows).toBeLessThan(N / 2);
  });
});

describe("MCP", () => {
  it("list_tickets lê só a página e a situação de ideia dos tickets dela", async () => {
    const { rows, chars, queries } = await mcp("list_tickets");
    expect(rows, JSON.stringify(queries.map((q) => [q.text.slice(0, 50), q.rows]))).toBeLessThanOrEqual(2 * 51 + 20);
    expect(chars).toBeLessThan(GIANT);
  });

  it("list_tickets com `under` e `after` não traz a árvore inteira", async () => {
    const f = world.plan.fixtures;
    const under = await mcp("list_tickets", { under: `BG-${T(f.shallow).number}`, limit: 20 });
    expect(under.rows).toBeLessThanOrEqual(2 * 21 + 20);
    const after = await mcp("list_tickets", { after: `BG-${N - 60}`, limit: 20 });
    expect(after.rows).toBeLessThanOrEqual(2 * 21 + 20);
  });

  it("get_project_overview conta por situação e traz só os tickets do topo", async () => {
    const tops = world.plan.tickets.filter((t) => t.parent === null).length;
    const { rows, chars } = await mcp("get_project_overview");
    expect(rows).toBeLessThanOrEqual(tops + 40);
    expect(rows).toBeLessThan(N);
    expect(chars).toBeLessThan(GIANT);
  });

  it("get_ticket não lê o projeto inteiro para saber a situação de ideia", async () => {
    const { rows } = await mcp("get_ticket", { key: `BG-${T(world.plan.fixtures.deep).number}` });
    expect(rows).toBeLessThan(N / 2);
  });

  it("search_tickets lê só o necessário para buscar (sem descrição inteira) e não monta uma segunda leitura do projeto", async () => {
    const { rows, chars } = await mcp("search_tickets", { query: "relatórios" });
    expect(rows).toBeLessThanOrEqual(N + 20);
    expect(chars).toBeLessThan(GIANT);
  });
});
