import { afterEach, describe, expect, it } from "vitest";
import { tenantTransaction } from "@treepm/db";
import { guarded } from "../src/mcp/mcp-server.js";
import { ToolInputError } from "../src/mcp/mcp-tools.js";
import { WriteTools } from "../src/mcp/mcp-write-tools.js";
import { structureLock } from "../src/tickets/structure-lock.js";
import { structureKey, structureQueue, structureQueueKeys, withStructureSlot } from "../src/tickets/structure-queue.js";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

/**
 * ADR 0045, adendo 1, pelo MCP: `create_ticket` com pai espera na fila em memória antes de abrir a transação (chave: o projeto do
 * token); sem pai não passa por ela. A fila cheia e a espera por conexão viram erro de ferramenta curto, em ASCII, sem texto do Prisma.
 */
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
async function setup(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
  const res = await h.create("contributor", priv(), { scope: "write" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Esperado, e não aconteceu: ${what}`);
}
const advisoryWaiting = async (): Promise<number> => Number((await h.rows("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted"))[0]?.n);

describe("create_ticket e a fila de estrutura", () => {
  const saved = { queue: { ...structureQueue }, lock: structureLock.timeoutMs, maxWait: tenantTransaction.maxWaitMs };
  afterEach(() => {
    Object.assign(structureQueue, saved.queue);
    structureLock.timeoutMs = saved.lock;
    tenantTransaction.maxWaitMs = saved.maxWait;
  });

  it("com pai: só 2 chamadas abrem transação com a trava ocupada; a 3ª passa de 300 ms na fila e vira erro de ferramenta, sem texto interno", async () => {
    const token = await setup();
    structureQueue.waitMs = 300;
    structureLock.timeoutMs = 10_000;
    const client = await h.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${priv()}`]);
    const call = (i: number) => h.tool(token, "PRIV", "create_ticket", { title: `Filho ${i}`, parent: "PRIV-1" });
    const inside = [0, 1].map((i) => call(i));
    await until(async () => (await advisoryWaiting()) >= 2, "duas criações esperando a trava");
    const late = await call(2);
    expect(late.isError).toBe(true);
    expect(late.text).toBe("The project structure is busy; try again in a moment.");
    expect(late.text).not.toMatch(/prisma|P2028/i);
    // sem pai não muda estrutura: não passa pela fila nem espera a trava
    const root = await h.tool(token, "PRIV", "create_ticket", { title: "Raiz sem pai" });
    expect(root.isError, root.text).toBe(false);
    await client.query("commit");
    client.release();
    for (const r of await Promise.all(inside)) expect(r.isError, r.text).toBe(false);
    expect(structureQueueKeys()).toBe(0);
  });
});

describe("MCP e HTTP dividem a mesma fila do projeto", () => {
  const saved = { queue: { ...structureQueue }, lock: structureLock.timeoutMs };
  afterEach(() => {
    Object.assign(structureQueue, saved.queue);
    structureLock.timeoutMs = saved.lock;
  });
  it("uma criação com pai pelo MCP e uma pela tela ocupam as 2 vagas; a 3ª da tela espera na fila e vira structure_busy", async () => {
    const token = await setup();
    structureQueue.waitMs = 300;
    structureLock.timeoutMs = 10_000;
    const client = await h.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${priv()}`]);
    const parent = (await h.rows("select id from tickets where project_id = $1 and number = 1", [priv()]))[0]?.id as string;
    const viaMcp = h.tool(token, "PRIV", "create_ticket", { title: "Pelo MCP", parent: "PRIV-1" });
    const viaScreen = h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Pela tela", parentId: parent }).then((r) => r);
    await until(async () => (await advisoryWaiting()) >= 2, "uma de cada esperando a trava");
    const late = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Terceira", parentId: parent });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("structure_busy");
    await client.query("commit");
    client.release();
    expect((await viaMcp).isError).toBe(false);
    expect((await viaScreen).status).toBe(201);
  });

  it("a chave do MCP é a mesma do HTTP: organização + projeto em minúsculas", () => {
    expect(structureKey(ORG, priv().toUpperCase())).toBe(structureKey(ORG, priv()));
  });
});

describe("recusa barata antes da fila", () => {
  it("token sem a verificação fresca não entra na fila, mesmo com ela cheia", async () => {
    const saved = { ...structureQueue };
    structureQueue.waitMs = 5000;
    const project = { id: "0195a3b2-7c4d-7e21-8f00-1234567890ab", key: "PRIV" };
    const key = structureKey("org_x", project.id) as string;
    const g = new Promise<void>((resolve) => setTimeout(resolve, 400));
    const held = [1, 2].map(() => withStructureSlot(key, () => g));
    try {
      const tools = new WriteTools(
        (() => Promise.reject(new Error("não devia abrir transação"))) as never,
        {} as never,
        { ticketNumber: (k: string) => Number(k.split("-")[1]) } as never,
        { project, principal: { session: { orgId: "org_x", userId: "u" } }, fresh: false, tokenId: "t" } as never,
      );
      const started = Date.now();
      await expect(tools.createTicket({ title: "x", parent: "PRIV-1" })).rejects.toBeInstanceOf(ToolInputError);
      expect(Date.now() - started).toBeLessThan(300); // não esperou a fila
    } finally {
      Object.assign(structureQueue, saved);
      await Promise.all(held);
    }
  });
});

describe("espera por conexão no MCP", () => {
  it("uma ferramenta que estoura a espera por conexão devolve erro curto em ASCII, sem vazar o Prisma", async () => {
    const acquisition = Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028", meta: {} });
    const res = await guarded("create_ticket", async () => Promise.reject(acquisition));
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toBe("The server is busy. Try again in a moment.");
    expect(text).not.toMatch(/prisma|transaction|P2028/i);
    // impasse do banco (40P01): também é "tente de novo"
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const retry = await guarded("create_ticket", async () => Promise.reject(deadlock));
    expect((retry.content[0] as { text: string }).text).toBe("Another change happened at the same time. Try again in a moment.");
    // o estouro do prazo de uma transação aberta continua sendo a falha genérica
    const expired = Object.assign(new Error("Transaction API error: A query cannot be executed on an expired transaction."), { code: "P2028" });
    const other = await guarded("create_ticket", async () => Promise.reject(expired));
    expect((other.content[0] as { text: string }).text).not.toBe("The server is busy. Try again in a moment.");
  });

  it("com o pool esgotado, resolver o token do agente responde 503 server_busy com Retry-After: 1, não 500", async () => {
    const token = await setup();
    const saved = tenantTransaction.maxWaitMs;
    const row = await h.pool.connect();
    try {
      const ticket = (await h.rows("select id from tickets where project_id = $1 limit 1", [priv()]))[0]?.id as string;
      await row.query("begin");
      await row.query("select 1 from tickets where id = $1 for update", [ticket]);
      const blockers = Array.from({ length: 12 }, (_, i) => h.call("PATCH", `/api/tickets/${ticket}`, as("admin"), { title: `Preso ${i}` }).then((r) => r));
      await until(async () => Number((await h.rows("select count(*)::int n from pg_locks where not granted"))[0]?.n) >= 5, "edições presas na linha");
      tenantTransaction.maxWaitMs = 250;
      const res = await h.rpc(token, "PRIV", "tools/list");
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error.code).toBe("server_busy");
      expect(res.headers["retry-after"]).toBe("1");
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|P2028/i);
      await row.query("commit");
      await Promise.all(blockers);
    } finally {
      tenantTransaction.maxWaitMs = saved;
      await row.query("rollback").catch(() => undefined);
      row.release();
    }
  });
});
