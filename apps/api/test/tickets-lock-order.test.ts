import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/**
 * ADR 0068, revisão 1: a situação de um pai sai dos filhos, e quem escreve trava as linhas de tickets de um projeto numa ordem só
 * (`id` crescente, num comando só). Cada caso encena uma corrida com uma transação do dono que segura uma linha ou a trava de
 * estrutura, e solta no meio.
 */
const h = useHarness();
type Body = Record<string, unknown>;
const P = () => h.world().projects.priv;
const made = async (body: Body = {}): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};
const patch = (id: string, body: Body) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), body).then((r) => r);
const status = async (id: string) => (await h.pool.query("select status from tickets where id = $1", [id])).rows[0].status as string;
const parentOf = async (id: string) => (await h.pool.query("select parent_id from tickets where id = $1", [id])).rows[0].parent_id as string | null;

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Esperado, e não aconteceu: ${what}`);
}
/** Quantas sessões esperam o fim de outra transação (linha travada) agora. */
const rowWaiters = async (): Promise<number> => Number((await h.pool.query("select count(*)::int as n from pg_locks where not granted and locktype in ('transactionid', 'tuple')")).rows[0].n);
const advisoryWaiters = async (): Promise<number> => Number((await h.pool.query("select count(*)::int as n from pg_locks where not granted and locktype = 'advisory'")).rows[0].n);

async function holding<T>(body: (owner: PoolClient) => Promise<T>): Promise<T> {
  const owner = await h.pool.connect();
  try {
    await owner.query("begin");
    const result = await body(owner);
    return result;
  } finally {
    await owner.query("rollback").catch(() => undefined);
    owner.release();
  }
}
/** A linha está livre agora? (`nowait`: quem a segura é outra transação, e o pedido falha na hora em vez de esperar). */
const free = async (owner: PoolClient, id: string): Promise<boolean> =>
  owner.query("savepoint probe").then(async () => {
    try {
      await owner.query("select id from tickets where id = $1 for update nowait", [id]);
      await owner.query("release savepoint probe");
      return true;
    } catch {
      await owner.query("rollback to savepoint probe");
      return false;
    }
  });

describe("mudança de situação × mudança de pai do mesmo ticket", () => {
  it("a conta sobe pelo pai lido COM a trava: o pai novo fica certo mesmo quando a situação foi pedida antes de a mudança confirmar", async () => {
    const p1 = await made({ title: "P1" });
    const c = await made({ title: "C", parentId: p1 });
    const p2 = await made({ title: "P2" });
    await made({ title: "Y", parentId: p2, status: "done" });
    await made({ title: "Z", parentId: p1, status: "done" });
    const [move, done] = await holding(async (owner) => {
      await owner.query("select id from tickets where id = $1 for update", [c]);
      const move = patch(c, { parentId: p2 });
      await until(async () => (await rowWaiters()) >= 1, "a mudança de pai esperando C");
      const done = patch(c, { status: "done" });
      await until(async () => (await rowWaiters()) >= 2, "a mudança de situação esperando também");
      await owner.query("commit");
      return Promise.all([move, done]);
    });
    expect([move.status, done.status], JSON.stringify([move.body, done.body])).toEqual([200, 200]);
    expect(await parentOf(c)).toBe(p2);
    expect(await status(c)).toBe("done");
    expect(await status(p2)).toBe("done"); // Y e C concluídos
    expect(await status(p1)).toBe("done"); // só Z ficou
  });
});

describe("remoção × mudança de pai", () => {
  it("a remoção refaz o pai lido depois da trava de estrutura, não o de antes", async () => {
    const p1 = await made({ title: "P1" });
    await made({ title: "Z", parentId: p1, status: "done" });
    const c = await made({ title: "C", parentId: p1 });
    const p2 = await made({ title: "P2" });
    await made({ title: "Y", parentId: p2, status: "done" });
    const removed = await holding(async (owner) => {
      await owner.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${P()}`]);
      const pending = h.call("DELETE", `/api/tickets/${c}`, as("admin")).then((r) => r);
      await until(async () => (await advisoryWaiters()) >= 1, "a remoção esperando a trava de estrutura");
      // Outra transação muda C de pai e refaz os dois pais, como faria a API.
      await owner.query("update tickets set parent_id = $1 where id = $2", [p2, c]);
      await owner.query("update tickets set status = 'in_progress' where id = $1", [p2]);
      await owner.query("update tickets set status = 'done' where id = $1", [p1]);
      await owner.query("commit");
      return pending;
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await status(p2)).toBe("done"); // só Y, concluído
    expect(await status(p1)).toBe("done");
  });
});

describe("remoção × situação de um irmão, ao mesmo tempo", () => {
  it("o pai termina com a situação dos filhos que ficaram", async () => {
    for (let i = 0; i < 4; i += 1) {
      const p = await made({ title: `P${i}` });
      const a = await made({ title: "A", parentId: p });
      const b = await made({ title: "B", parentId: p });
      const [removed, changed] = await Promise.all([h.call("DELETE", `/api/tickets/${b}`, as("admin")).then((r) => r), patch(a, { status: "done" })]);
      expect([removed.status, changed.status], JSON.stringify([removed.body, changed.body])).toEqual([204, 200]);
      expect(await status(p), `rodada ${i}`).toBe("done");
    }
  });

  it("encenado: com o pai travado, a remoção e a situação esperam, e o pai sai certo", async () => {
    const p = await made({ title: "P" });
    const a = await made({ title: "A", parentId: p });
    const b = await made({ title: "B", parentId: p });
    const [removed, changed] = await holding(async (owner) => {
      await owner.query("select id from tickets where id = $1 for update", [p]);
      const removed = h.call("DELETE", `/api/tickets/${b}`, as("admin")).then((r) => r);
      const changed = patch(a, { status: "done" });
      await until(async () => (await rowWaiters()) >= 2, "as duas esperando o pai");
      await owner.query("commit");
      return Promise.all([removed, changed]);
    });
    expect([removed.status, changed.status]).toEqual([204, 200]);
    expect(await status(p)).toBe("done");
  });
});

describe("uma ordem só: id crescente (pai criado antes tem id menor que o filho)", () => {
  it("a situação do filho trava o pai ANTES do filho: com o pai preso, o filho segue livre", async () => {
    const x = await made({ title: "X" });
    const d = await made({ title: "D", parentId: x });
    expect(x < d).toBe(true);
    const res = await holding(async (owner) => {
      await owner.query("select id from tickets where id = $1 for update", [x]);
      const pending = patch(d, { status: "in_progress" });
      await until(async () => (await rowWaiters()) >= 1, "a situação do filho esperando o pai");
      expect(await free(owner, d)).toBe(true);
      await owner.query("commit");
      return pending;
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status(x)).toBe("in_progress");
  });

  it("transformar o pai em ideia × situação do filho: as duas na mesma ordem, uma passa e a outra é recusada com código conhecido", async () => {
    const x = await made({ title: "X" });
    const d = await made({ title: "D", parentId: x });
    const [a, b] = await holding(async (owner) => {
      await owner.query("select id from tickets where id = $1 for update", [x]);
      const a = patch(d, { status: "in_progress" });
      await until(async () => (await rowWaiters()) >= 1, "A esperando X");
      expect(await free(owner, d)).toBe(true);
      const b = h.call("POST", `/api/tickets/${x}/idea`, as("admin")).then((r) => r);
      await until(async () => (await rowWaiters()) >= 2, "B esperando também");
      await owner.query("commit");
      return Promise.all([a, b]);
    });
    const all = [a, b];
    expect(all.map((r) => r.status).filter((s) => s >= 500), JSON.stringify(all.map((r) => r.body))).toEqual([]);
    expect(all.filter((r) => r.body?.error?.code === "concurrent_update")).toHaveLength(0);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect([b.status, b.body?.error?.code]).toEqual([409, "idea_has_work"]);
  });
});
