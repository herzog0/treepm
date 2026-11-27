import { tenantTransaction } from "@treepm/db";
import { afterEach, describe, expect, it } from "vitest";
import { retryableConflict } from "../src/common/error.filter.js";
import { structureLock } from "../src/tickets/structure-lock.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/** Revisão 1 da ADR 0045: o ticket movido e o pai relidos depois da trava, prazos coerentes e impasse entre travas de linha. */
const h = useHarness();
const P = () => h.world().projects.priv;
const make = async (body: Record<string, unknown>): Promise<string> => {
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
const waiting = async (): Promise<number> => Number((await h.pool.query("select count(*)::int as n from pg_locks where not granted")).rows[0].n);
const row = async (id: string) => (await h.pool.query("select parent_id, status from tickets where id = $1", [id])).rows[0] as { parent_id: string | null; status: string };

describe("itens 1 e 2: a decisão usa o ticket de agora, não o da leitura sem trava", () => {
  it("mover para dentro de uma ideia um ticket cuja situação mudou sem confirmar: o próprio ticket em andamento não entra", async () => {
    const idea = await make({ idea: true });
    const x = await make({});
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query("update tickets set status = 'in_progress' where id = $1", [x]);
      const move = h.call("PATCH", `/api/tickets/${x}`, as("admin"), { parentId: idea }).then((r) => r);
      let done = false;
      void move.then(() => (done = true));
      await until(async () => done || (await waiting()) >= 1, "a requisição terminou ou parou na trava");
      await owner.query("commit");
      const res = await move;
      const after = await row(x);
      expect(after.parent_id === idea && after.status === "in_progress", `X em andamento dentro da ideia (resposta ${res.status})`).toBe(false);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("move_into_idea_blocked");
    } finally {
      owner.release();
    }
  });

  it("mudar a situação de um ticket que acabou de entrar numa ideia: o pai de agora vale, a situação não muda", async () => {
    const idea = await make({ idea: true });
    const x = await make({});
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query("update tickets set parent_id = $1 where id = $2", [idea, x]); // o movimento da outra requisição, ainda não confirmado
      const change = h.call("PATCH", `/api/tickets/${x}`, as("admin"), { status: "in_progress" }).then((r) => r);
      let done = false;
      void change.then(() => (done = true));
      await until(async () => done || (await waiting()) >= 1, "a requisição terminou ou parou na linha");
      await owner.query("commit");
      const res = await change;
      const after = await row(x);
      expect(after.parent_id === idea && after.status === "in_progress", `X em andamento dentro da ideia (resposta ${res.status})`).toBe(false);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ticket_in_idea");
    } finally {
      owner.release();
    }
  });
});

describe("item 3: a espera pela trava cabe no prazo da transação", () => {
  const savedWait = structureLock.timeoutMs;
  const savedTx = tenantTransaction.timeoutMs;
  afterEach(() => {
    structureLock.timeoutMs = savedWait;
    tenantTransaction.timeoutMs = savedTx;
  });
  const hold = async (projectId: string) => {
    const client = await h.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${projectId}`]);
    return {
      release: async () => {
        await client.query("commit");
        client.release();
      },
    };
  };

  it("os valores de produção: a espera é no máximo um terço do prazo da transação", () => {
    expect(tenantTransaction.timeoutMs).toBeGreaterThanOrEqual(3 * structureLock.timeoutMs);
  });

  it("(a) com a proporção de produção, quem consegue a trava quase no fim da espera ainda conclui: 200, não 500", async () => {
    const parent = await make({});
    const leaf = await make({});
    structureLock.timeoutMs = 400;
    tenantTransaction.timeoutMs = 1600;
    const lock = await hold(P());
    const pending = h.call("PATCH", `/api/tickets/${leaf}`, as("admin"), { parentId: parent }).then((r) => r);
    await until(async () => (await waiting()) >= 1, "a requisição esperando a trava");
    await new Promise((resolve) => setTimeout(resolve, 300)); // quase todo o prazo da espera
    await lock.release();
    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("(b) se a transação estourar o prazo num caminho de estrutura, a resposta é 409 structure_busy, não 500", async () => {
    const parent = await make({});
    const leaf = await make({});
    structureLock.timeoutMs = 3000; // configuração incoerente de propósito: a espera passa do prazo da transação
    tenantTransaction.timeoutMs = 500;
    const lock = await hold(P());
    const pending = h.call("PATCH", `/api/tickets/${leaf}`, as("admin"), { parentId: parent }).then((r) => r);
    await until(async () => (await waiting()) >= 1, "a requisição esperando a trava");
    await new Promise((resolve) => setTimeout(resolve, 900)); // o prazo da transação (500 ms) já passou
    await lock.release();
    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("structure_busy");
  });
});

describe("item 4: a ordem única das travas de tickets (ADR 0068, revisão 1): pai com id menor que o filho, sem impasse", () => {
  /** Sessões esperando o fim de outra transação (linha travada). */
  const rowWaiters = async () => Number((await h.pool.query("select count(*)::int as n from pg_locks where not granted and locktype in ('transactionid', 'tuple')")).rows[0].n);

  /**
   * O arranjo perigoso: o pai X (id menor) preso por outra transação; quem chega primeiro na fila de X é `first`. Antes da ordem
   * única, a situação do filho travava o filho D e esperava X, e a ida de X para a ideia travava X e esperava D: impasse.
   */
  async function stage(first: "child-status" | "move-parent") {
    const idea = await make({ idea: true });
    const x = await make({}); // o pai, criado antes: id menor (UUID v7)
    const d = await make({ parentId: x }); // o filho: id maior
    expect(x < d).toBe(true);
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query("select id from tickets where id = $1 for update", [x]);
      const child = () => h.call("PATCH", `/api/tickets/${d}`, as("admin"), { status: "in_progress" }).then((r) => r);
      const move = () => h.call("PATCH", `/api/tickets/${x}`, as("admin"), { parentId: idea }).then((r) => r);
      const a = first === "child-status" ? child() : move();
      await until(async () => (await rowWaiters()) >= 1, "a primeira na fila de X");
      const b = first === "child-status" ? move() : child();
      await until(async () => (await rowWaiters()) >= 2, "a segunda na fila de X");
      await owner.query("commit");
      const [ra, rb] = await Promise.all([a, b]);
      return { x, d, first: ra, second: rb };
    } finally {
      owner.release();
    }
  }
  const noFailure = (first: { status: number; body: { error?: { code: string } } }, second: { status: number; body: { error?: { code: string } } }) => {
    expect([first.status, second.status].filter((s) => s >= 500), JSON.stringify([first.body, second.body])).toEqual([]);
    expect([first, second].filter((r) => r.body?.error?.code === "concurrent_update"), JSON.stringify([first.body, second.body])).toHaveLength(0);
  };

  it("a ida do pai para a ideia na frente da fila: ela passa, e a situação do filho, agora dentro da ideia, é recusada (antes: impasse)", async () => {
    const { d, first, second } = await stage("move-parent");
    noFailure(first, second);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect([second.status, second.body?.error?.code]).toEqual([409, "ticket_in_idea"]);
    expect((await h.pool.query("select status from tickets where id = $1", [d])).rows[0].status).toBe("todo");
  });

  it("a situação do filho na frente da fila: ela passa (o pai segue o filho), e a ida do pai para a ideia é recusada por haver trabalho", async () => {
    const { x, first, second } = await stage("child-status");
    noFailure(first, second);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect([second.status, second.body?.error?.code]).toEqual([409, "move_into_idea_blocked"]);
    expect((await h.pool.query("select status from tickets where id = $1", [x])).rows[0].status).toBe("in_progress");
  });
}, 30_000);

describe("item 4: a tradução do erro do banco", () => {
  const driver = (originalCode: string) => ({ meta: { driverAdapterError: { cause: { originalCode } } } });
  it("40P01 e 40001 viram 409 concurrent_update; outros códigos não", () => {
    for (const code of ["40P01", "40001"]) expect(retryableConflict(driver(code))).toMatchObject({ status: 409, code: "concurrent_update" });
    expect(retryableConflict({ code: "P2010", meta: { code: "40P01" } })).toMatchObject({ code: "concurrent_update" });
    expect(retryableConflict(new Error("deadlock detected"))).toMatchObject({ code: "concurrent_update" });
    expect(retryableConflict(driver("23505"))).toBeNull();
    expect(retryableConflict(new Error("boom"))).toBeNull();
  });
});
