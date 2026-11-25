import { afterEach, describe, expect, it } from "vitest";
import { tenantTransaction } from "@treepm/db";
import { WRITE_TOOL_NAMES } from "../src/mcp/mcp-write-tools.js";
import { structureLock } from "../src/tickets/structure-lock.js";
import { structureQueue } from "../src/tickets/structure-queue.js";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// ADR 0062, fatia 1, revisão de segurança (TREEPM-493): três correções do MCP.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const BUSY = "The project structure is busy; try again in a moment.";

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
const count = async (sql: string, params: unknown[] = []) => Number((await h.rows(sql, params))[0]?.n);
const idOf = async (n: number) => (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), n]))[0]?.id as string;
const parentOf3 = async () => Number((await h.rows("select p.number from tickets t join tickets p on p.id = t.parent_id where t.project_id = $1 and t.number = 3", [priv()]))[0]?.number);
/** Uma transação à parte que segura a trava de estrutura REAL do projeto. */
async function holdStructure() {
  const client = await h.pool.connect();
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${priv()}`]);
  return {
    release: async () => {
      await client.query("commit");
      client.release();
    },
  };
}

describe("1. remove_dependency sem ligação existente", () => {
  it("o MCP diz que não há essa dependência (e não que o ticket sumiu); a tela continua com 404 'Dependência não encontrada.'", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "remove_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("There is no such dependency between these tickets.");
    const http = await h.call("DELETE", `/api/tickets/${await idOf(3)}/dependencies/${await idOf(4)}`, as("contributor"));
    expect(http.status).toBe(404);
    expect(http.body.error.message).toBe("Dependência não encontrada.");
  });

  it("ticket que não existe na ligação continua dizendo 'Ticket or project not found.'", async () => {
    const token = await setup();
    const http = await h.call("DELETE", `/api/tickets/${await idOf(3)}/dependencies/00000000-0000-4000-8000-000000000000`, as("contributor"));
    expect(http.status).toBe(404);
    expect(http.body.error.message).toBe("Ticket não encontrado.");
    expect(token).toBeTruthy();
  });
});

describe("2. trava de estrutura ocupada no caminho MCP (trava real, prazo curto)", () => {
  const saved = { queue: { ...structureQueue }, lock: structureLock.timeoutMs, tx: tenantTransaction.timeoutMs };
  afterEach(() => {
    Object.assign(structureQueue, saved.queue);
    structureLock.timeoutMs = saved.lock;
    tenantTransaction.timeoutMs = saved.tx;
  });

  it("move_ticket: a espera pela trava estoura (lock_timeout) e a frase é a da estrutura ocupada; nada é movido", async () => {
    const token = await setup();
    structureLock.timeoutMs = 300;
    const lock = await holdStructure();
    const res = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-3", parent: "PRIV-2" });
    await lock.release();
    expect(res.isError).toBe(true);
    expect(res.text).toBe(BUSY);
    expect(await parentOf3()).toBe(1);
  });

  it("move_ticket: a transação estoura o prazo depois de esperar a trava (P2028) e a frase é a mesma, sem texto do Prisma", async () => {
    const token = await setup();
    structureLock.timeoutMs = 3000; // configuração incoerente de propósito: a espera passa do prazo da transação
    tenantTransaction.timeoutMs = 500;
    const lock = await holdStructure();
    const pending = h.tool(token, "PRIV", "move_ticket", { key: "PRIV-3", parent: "PRIV-2" });
    await until(async () => (await advisoryWaiting()) >= 1, "a movimentação esperando a trava");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await lock.release();
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(res.text).toBe(BUSY);
    expect(res.text).not.toMatch(/prisma|P2028|transaction/i);
    expect(await parentOf3()).toBe(1);
  });

  it("move_ticket: a espera na fila em memória estoura (a 3ª chamada) e a frase é a mesma", async () => {
    const token = await setup();
    structureQueue.waitMs = 300;
    structureLock.timeoutMs = 10_000;
    const lock = await holdStructure();
    const call = (n: number) => h.tool(token, "PRIV", "move_ticket", { key: `PRIV-${n}`, parent: "PRIV-2" });
    const inside = [3, 4].map(call);
    await until(async () => (await advisoryWaiting()) >= 2, "duas movimentações esperando a trava");
    const late = await call(5);
    expect(late.isError).toBe(true);
    expect(late.text).toBe(BUSY);
    await lock.release();
    await Promise.all(inside);
  });

  it("create_ticket com pai: as duas formas de estouro dão a mesma frase", async () => {
    const token = await setup();
    structureLock.timeoutMs = 300;
    const lock = await holdStructure();
    const res = await h.tool(token, "PRIV", "create_ticket", { title: "Filho", parent: "PRIV-2" });
    await lock.release();
    expect(res.isError).toBe(true);
    expect(res.text).toBe(BUSY);

    structureLock.timeoutMs = 3000;
    tenantTransaction.timeoutMs = 500;
    const lock2 = await holdStructure();
    const pending = h.tool(token, "PRIV", "create_ticket", { title: "Filho 2", parent: "PRIV-2" });
    await until(async () => (await advisoryWaiting()) >= 1, "a criação esperando a trava");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await lock2.release();
    const late = await pending;
    expect(late.isError).toBe(true);
    expect(late.text).toBe(BUSY);
    expect(await count("select count(*)::int as n from tickets where title in ('Filho', 'Filho 2')")).toBe(0);
  });
});

describe("3. frase genérica de erro em escrita e entrada com caractere nulo", () => {
  it("o caractere nulo no título ou na descrição é entrada inválida nas DUAS portas, e nada é gravado", async () => {
    const token = await setup();
    const before = await count("select count(*)::int as n from tickets");
    const created = await h.tool(token, "PRIV", "create_ticket", { title: "a\u0000b" });
    expect(created.isError).toBe(true);
    expect(created.text).not.toMatch(/Something went wrong/);
    const updated = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "x\u0000y" });
    expect(updated.isError).toBe(true);
    expect(updated.text).not.toMatch(/Something went wrong/);
    const described = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", description: "x\u0000y" });
    expect(described.isError).toBe(true);
    expect(described.text).not.toMatch(/Something went wrong/);
    const comment = await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "x\u0000y" });
    expect(comment.isError).toBe(true);
    expect(comment.text).not.toMatch(/Something went wrong/);

    const http = await h.call("POST", `/api/projects/${priv()}/tickets`, as("contributor"), { title: "a\u0000b" });
    expect(http.status).toBe(400);
    const patch = await h.call("PATCH", `/api/tickets/${await idOf(3)}`, as("contributor"), { description: "x\u0000y" });
    expect(patch.status).toBe(400);
    expect(await count("select count(*)::int as n from tickets")).toBe(before);
    expect(await count("select count(*)::int as n from tickets where title like '%' || chr(1) || '%'")).toBe(0);
  });

  it("erro sem frase própria numa ferramenta de ESCRITA diz que nada foi alterado; numa de leitura continua falando de leitura", async () => {
    const { guarded } = await import("../src/mcp/mcp-server.js");
    const boom = () => Promise.reject(new Error("boom"));
    for (const name of WRITE_TOOL_NAMES) {
      const res = await guarded(name, boom);
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text, name).toBe("Something went wrong and nothing was changed.");
    }
    const read = await guarded("get_ticket", boom);
    expect((read.content[0] as { text: string }).text).toBe("Something went wrong while reading the project. Try again.");
  });

  it("no caso reproduzível (falha de banco no meio da escrita) nada fica gravado", async () => {
    const token = await setup();
    // Um gatilho que falha na gravação do título reproduz um erro sem frase própria no meio da escrita.
    await h.pool.query(`create function m2_fail() returns trigger language plpgsql as $$ begin if new.title = 'explode' then raise exception 'boom'; end if; return new; end $$`);
    await h.pool.query("create trigger m2_fail before update on tickets for each row execute function m2_fail()");
    try {
      const before = (await h.rows("select title, status, priority, updated_at from tickets where id = $1", [await idOf(3)]))[0];
      const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "explode" });
      expect(res.isError).toBe(true);
      expect(res.text).toBe("Something went wrong and nothing was changed.");
      expect((await h.rows("select title, status, priority, updated_at from tickets where id = $1", [await idOf(3)]))[0]).toEqual(before);
      expect(await count("select count(*)::int as n from activity_events where kind = 'ticket.updated' and payload->>'key' = 'PRIV-3'")).toBe(0);
    } finally {
      await h.pool.query("drop trigger m2_fail on tickets");
      await h.pool.query("drop function m2_fail()");
    }
  });
});
