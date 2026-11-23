import { afterEach, describe, expect, it } from "vitest";
import { tenantTransaction } from "@treepm/db";
import { isConnectionWaitTimeout } from "../src/common/connection-wait.js";
import { structureLock } from "../src/tickets/structure-lock.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/**
 * ADR 0045, adendo 1 (TREEPM-259): a espera por uma conexão do pool tem prazo definido (`tenantTransaction.maxWaitMs`, 5 s) e
 * estourá-la vira 503 `server_busy` com `Retry-After: 1`, em qualquer rota, em vez de 500. É um erro diferente do estouro do prazo
 * de uma transação JÁ aberta (que, depois de pegar a trava de estrutura, continua 409 `structure_busy`).
 * As formas dos dois erros abaixo foram capturadas do Prisma 7 de verdade (pool de 1, `maxWait: 200` e `timeout: 300`).
 */
const ACQUISITION = { name: "PrismaClientKnownRequestError", code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time.", meta: {} };
const EXPIRED = {
  name: "PrismaClientKnownRequestError",
  code: "P2028",
  message: "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nTransaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 300 ms, however 703 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.",
  meta: { operation: "query", timeout: 300, timeTaken: 703 },
};

describe("distinguir os dois P2028", () => {
  it("só a espera por conexão conta; o prazo estourado de transação aberta e outros erros não", () => {
    expect(isConnectionWaitTimeout(ACQUISITION)).toBe(true);
    expect(isConnectionWaitTimeout(EXPIRED)).toBe(false);
    expect(isConnectionWaitTimeout({ code: "P2028", message: "Transaction already closed: A commit cannot be executed on an expired transaction." })).toBe(false);
    expect(isConnectionWaitTimeout({ code: "P2002", message: "Unable to start a transaction in the given time." })).toBe(false);
    expect(isConnectionWaitTimeout(new Error("boom"))).toBe(false);
    expect(isConnectionWaitTimeout(undefined)).toBe(false);
  });
});

const h = useHarness();
const P = () => h.world().projects.priv;
const make = async (body: Record<string, unknown> = {}): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Esperado, e não aconteceu: ${what}`);
}

describe("pool esgotado vira 503 server_busy", () => {
  const saved = { maxWait: tenantTransaction.maxWaitMs, timeout: tenantTransaction.timeoutMs, lock: structureLock.timeoutMs };
  afterEach(() => {
    tenantTransaction.maxWaitMs = saved.maxWait;
    tenantTransaction.timeoutMs = saved.timeout;
    structureLock.timeoutMs = saved.lock;
  });

  it("o padrão de produção é de 5 s e fica ao lado do prazo da transação", () => {
    expect(saved.maxWait).toBe(5000);
  });

  it("com as 10 conexões ocupadas por edições presas numa linha, a que espera mais que o maxWait recebe 503 server_busy com Retry-After: 1", async () => {
    const id = await make();
    tenantTransaction.maxWaitMs = 250;
    const row = await h.pool.connect();
    await row.query("begin");
    await row.query("select 1 from tickets where id = $1 for update", [id]);
    const edits = Array.from({ length: 14 }, (_, i) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), { title: `Edição ${i}` }).then((r) => r));
    await until(async () => Number((await h.pool.query("select count(*)::int n from pg_locks where not granted")).rows[0].n) >= 5, "edições presas na linha");
    await new Promise((resolve) => setTimeout(resolve, 600)); // passa do maxWait das que não conseguiram conexão
    await row.query("commit");
    row.release();
    const results = await Promise.all(edits);
    const busy = results.filter((r) => r.status === 503);
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r.body.error.code).toBe("server_busy");
      expect(r.body.error.message).toBe("O servidor está ocupado. Tente de novo em instantes.");
      expect(r.headers["retry-after"]).toBe("1");
      expect(JSON.stringify(r.body)).not.toMatch(/prisma|transaction/i);
    }
    expect(results.filter((r) => r.status !== 503 && r.status !== 200)).toEqual([]); // nenhum 500
  });

  it("o estouro do prazo de uma transação que já pegou a trava continua 409 structure_busy, mesmo com maxWait curto", async () => {
    const parent = await make();
    const leaf = await make();
    tenantTransaction.maxWaitMs = 200;
    structureLock.timeoutMs = 3000;
    tenantTransaction.timeoutMs = 500;
    const client = await h.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${P()}`]);
    const pending = h.call("PATCH", `/api/tickets/${leaf}`, as("admin"), { parentId: parent }).then((r) => r);
    await until(async () => Number((await h.pool.query("select count(*)::int n from pg_locks where locktype = 'advisory' and not granted")).rows[0].n) >= 1, "a requisição esperando a trava");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await client.query("commit");
    client.release();
    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("structure_busy");
  });
});
