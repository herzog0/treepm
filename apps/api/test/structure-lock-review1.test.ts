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

describe("item 4: impasse entre travas de linha vira 409 concurrent_update", () => {
  const HOLD = 7770002;
  afterEach(async () => {
    await h.pool.query("drop trigger if exists test_hold_reopen on tickets");
    await h.pool.query("drop function if exists test_hold_reopen()");
  });

  it("subárvore travada por id (filho com id menor) contra a reabertura de baixo para cima: nenhuma resposta é 500", async () => {
    const idea = await make({ idea: true });
    const d = await make({}); // id menor
    const x = await make({}); // id maior: o pai
    await h.pool.query("update tickets set parent_id = $1 where id = $2", [x, d]);
    await h.pool.query("update tickets set status = 'done' where id = $1", [x]);
    await h.pool.query(`create function test_hold_reopen() returns trigger language plpgsql as $$
      begin
        if new.id = '${x}' and new.status is distinct from old.status then perform pg_advisory_xact_lock_shared(${HOLD}); end if;
        return new;
      end $$`);
    await h.pool.query("create trigger test_hold_reopen before update on tickets for each row execute function test_hold_reopen()");
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query(`select pg_advisory_xact_lock(${HOLD})`);
      // A: situação do filho. Trava o pai (reabertura) e para na gravação do pai, segurando-o.
      const a = h.call("PATCH", `/api/tickets/${d}`, as("admin"), { status: "in_progress" }).then((r) => r);
      await until(async () => (await waiting()) >= 1, "A parada na gravação do pai");
      // B: move o pai para a ideia. Trava a subárvore por id: pega o filho e espera o pai, que A segura.
      const b = h.call("PATCH", `/api/tickets/${x}`, as("admin"), { parentId: idea }).then((r) => r);
      await until(async () => (await waiting()) >= 2, "B esperando o pai");
      await owner.query("commit"); // A segue e quer o filho, que B segura: impasse; o PostgreSQL aborta uma das duas.
      const [ra, rb] = await Promise.all([a, b]);
      const all = [ra, rb];
      expect(all.map((r) => r.status).filter((s) => s >= 500), JSON.stringify(all.map((r) => r.body))).toEqual([]);
      expect(all.filter((r) => r.body?.error?.code === "concurrent_update")).toHaveLength(1);
    } finally {
      owner.release();
    }
  }, 30_000);
});

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
