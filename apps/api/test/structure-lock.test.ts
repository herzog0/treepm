import { afterEach, describe, expect, it } from "vitest";
import { structureLock } from "../src/tickets/structure-lock.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/**
 * ADR 0045: as mudanças de estrutura da árvore de um projeto são serializadas por uma trava consultiva por projeto.
 * Nada aqui espera "por sorte": as ordens são forçadas por travas que o teste segura (uma transação do dono) e por
 * um gatilho de teste que segura cada gravação de `parent_id` até o teste soltá-la.
 */
const h = useHarness();
const P = () => h.world().projects.priv;
const make = async (body: Record<string, unknown>): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

const HOLD = 7770001; // chave consultiva do gatilho de teste (fora do espaço do app)

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Esperado, e não aconteceu: ${what}`);
}
/** Quantas sessões estão esperando uma trava (consultiva ou de linha) agora. */
const waiting = async (): Promise<number> =>
  Number((await h.pool.query("select count(*)::int as n from pg_locks where not granted")).rows[0].n);

async function holdStructureLock(projectId: string) {
  const client = await h.pool.connect();
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${projectId}`]);
  return {
    release: async () => {
      await client.query("commit");
      client.release();
    },
  };
}

describe("a corrida real: duas mudanças de pai ao mesmo tempo", () => {
  const dropHold = async () => {
    await h.pool.query("drop trigger if exists test_hold_parent on tickets");
    await h.pool.query("drop function if exists test_hold_parent()");
  };
  afterEach(dropHold);

  it("A para dentro de B e B para dentro de A: uma passa, a outra recebe ticket_cycle, e a árvore não tem ciclo", async () => {
    const a = await make({ status: "done" });
    const b = await make({ status: "done" });
    await h.pool.query(`create function test_hold_parent() returns trigger language plpgsql as $$
      begin
        if new.parent_id is distinct from old.parent_id then perform pg_advisory_xact_lock_shared(${HOLD}); end if;
        return new;
      end $$`);
    await h.pool.query("create trigger test_hold_parent before update on tickets for each row execute function test_hold_parent()");

    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query(`select pg_advisory_xact_lock(${HOLD})`);
      const first = h.call("PATCH", `/api/tickets/${a}`, as("admin"), { parentId: b }).then((r) => r);
      const second = h.call("PATCH", `/api/tickets/${b}`, as("admin"), { parentId: a }).then((r) => r);
      // Sem a trava de estrutura, as duas já conferiram o ciclo e estão paradas no gatilho; com ela, uma está no gatilho
      // e a outra na trava do projeto. Nos dois casos, duas sessões esperando: só então o dono solta.
      await until(async () => (await waiting()) >= 2, "as duas requisições paradas");
      await owner.query("commit");
      const results = await Promise.all([first, second]);
      const statuses = results.map((r) => r.status).sort();
      const rows = (await h.pool.query("select id, parent_id from tickets where id = any($1)", [[a, b]])).rows as { id: string; parent_id: string | null }[];
      const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
      const cycle = parent.get(a) === b && parent.get(b) === a;
      expect(cycle, `A.pai=${parent.get(a)} B.pai=${parent.get(b)} respostas=${statuses.join(",")}`).toBe(false);
      expect(statuses).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409);
      expect(refused?.body.error.code).toBe("ticket_cycle");
    } finally {
      owner.release();
    }
  });

  it("mover para dentro de uma ideia enquanto um descendente muda de situação: o descendente em andamento não entra na ideia", async () => {
    const idea = await make({ idea: true });
    const x = await make({});
    const d = await make({ parentId: x });
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      // A mudança de situação do descendente, ainda não confirmada (a outra requisição não a enxerga).
      await owner.query("update tickets set status = 'in_progress' where id = $1", [d]);
      const move = h.call("PATCH", `/api/tickets/${x}`, as("admin"), { parentId: idea }).then((r) => r);
      let done = false;
      void move.then(() => (done = true));
      // Ou a requisição terminou (sem trava na subárvore), ou parou esperando a linha do descendente.
      await until(async () => done || (await waiting()) >= 1, "a requisição terminou ou parou na trava");
      await owner.query("commit");
      const res = await move;
      const inside = (
        await h.pool.query(
          `select count(*)::int as n from tickets t join tickets p on p.id = t.parent_id
           where t.id = $1 and p.id = $2 and t.status not in ('todo', 'cancelled')`,
          [d, x],
        )
      ).rows[0].n as number;
      const xParent = (await h.pool.query("select parent_id from tickets where id = $1", [x])).rows[0].parent_id as string | null;
      expect(xParent === idea && inside === 1, `ideia contém descendente em andamento (resposta ${res.status})`).toBe(false);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("move_into_idea_blocked");
    } finally {
      owner.release();
    }
  });
});

describe("a espera é limitada: com a trava ocupada, a mudança de estrutura recebe 409 structure_busy no prazo", () => {
  const original = structureLock.timeoutMs;
  afterEach(() => {
    structureLock.timeoutMs = original;
  });

  type Op = { name: string; run: (ctx: { plain: string; leaf: string; idea: string; parent: string }) => Promise<{ status: number; body: { error?: { code: string } } }> };
  const ops: Op[] = [
    { name: "trocar o pai", run: (c) => h.call("PATCH", `/api/tickets/${c.leaf}`, as("admin"), { parentId: c.parent }) },
    { name: "criar ticket com pai", run: (c) => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Filho", parentId: c.parent }) },
    { name: "remover ticket", run: (c) => h.call("DELETE", `/api/tickets/${c.leaf}`, as("admin")) },
    { name: "importar tickets", run: () => h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { items: [{ title: "Um" }] }) },
    { name: "transformar em ideia", run: (c) => h.call("POST", `/api/tickets/${c.plain}/idea`, as("admin")) },
    { name: "aceitar ideia", run: (c) => h.call("POST", `/api/tickets/${c.idea}/idea/accept`, as("admin")) },
    { name: "descartar ideia", run: (c) => h.call("POST", `/api/tickets/${c.idea}/idea/discard`, as("admin")) },
  ];

  it.each(ops)("$name", async (op) => {
    const ctx = { plain: await make({}), leaf: await make({}), idea: await make({ idea: true }), parent: await make({}) };
    structureLock.timeoutMs = 300;
    const lock = await holdStructureLock(P());
    try {
      const started = Date.now();
      const res = await op.run(ctx);
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe("structure_busy");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await lock.release();
    }
  });

  it("quem não mexe na estrutura (título, situação) não espera pela trava", async () => {
    const t = await make({});
    const lock = await holdStructureLock(P());
    try {
      const res = await h.call("PATCH", `/api/tickets/${t}`, as("admin"), { title: "Novo título", status: "in_progress" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      await lock.release();
    }
  });

  it("a trava é por projeto: outro projeto não espera", async () => {
    const other = await h.call("POST", `/api/projects/${h.world().projects.org}/tickets`, as("admin"), { title: "Em outro projeto" });
    expect(other.status).toBe(201);
    const lock = await holdStructureLock(P());
    try {
      const res = await h.call("POST", `/api/projects/${h.world().projects.org}/tickets`, as("admin"), { title: "Filho", parentId: other.body.id });
      expect(res.status).toBe(201);
    } finally {
      await lock.release();
    }
  });
});
