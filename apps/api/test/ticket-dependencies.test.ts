import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0037, fatia 3: "A depende de B" registrada pela pessoa (kind = 'depends_on', from = A, to = B).
const h = useHarness();
const priv = () => h.world().projects.priv;
const open = () => h.world().projects.org;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
type Body = Record<string, unknown>;
type Link = { id: string; key: string; title: string; status: string };
type Detail = { id: string; status: string; dependsOn: Link[]; blocks: Link[]; mentionedBy: Link[] };

const add = async (body: Body = {}, project = priv()): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const link = (from: string, to: string, who: Who = "admin") => h.call("POST", `/api/tickets/${from}/dependencies`, as(who), { ticketId: to });
const unlink = (from: string, to: string, who: Who = "admin") => h.call("DELETE", `/api/tickets/${from}/dependencies/${to}`, as(who));
const detail = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body as Detail;
const deps = async () =>
  (await h.pool.query("select f.number as f, t.number as t from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by f.number, t.number")).rows.map(
    (row) => `${row.f}>${row.t}`,
  );
const events = async (kind: string) => (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;
const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].count);

describe("adicionar e remover", () => {
  it("registra a ligação (200), devolve o detalhe e grava um evento no ticket de origem com as duas chaves", async () => {
    const a = await add();
    const b = await add();
    const res = await link(a.id, b.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as Detail).dependsOn).toEqual([{ id: b.id, key: "PRIV-2", title: "T", status: "todo", fromLinear: false, dueDate: null, need: "start" }]);
    expect(await deps()).toEqual(["1>2"]);
    const [event] = await events("ticket.dependency_added");
    expect(event).toMatchObject({ subject_type: "ticket", subject_id: a.id, actor_person_id: h.world().people.admin });
    expect(event.payload).toEqual({ key: "PRIV-1", dependsOnKey: "PRIV-2", dependsOnTicketId: b.id, need: "start" });
    expect(await events("ticket.dependency_added")).toHaveLength(1);
  });

  it("repetir é sucesso sem duplicar e sem novo evento", async () => {
    const a = await add();
    const b = await add();
    expect((await link(a.id, b.id)).status).toBe(200);
    const before = await h.pool.query("select id, created_at from ticket_relations where kind = 'depends_on'");
    const again = await link(a.id, b.id);
    expect(again.status).toBe(200);
    expect((again.body as Detail).dependsOn).toHaveLength(1);
    expect((await h.pool.query("select id, created_at from ticket_relations where kind = 'depends_on'")).rows).toEqual(before.rows);
    expect(await events("ticket.dependency_added")).toHaveLength(1);
  });

  it("remover apaga a ligação (204) e grava o evento; remover o que não existe é 404 sem evento", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    expect((await unlink(a.id, b.id)).status).toBe(204);
    expect(await deps()).toEqual([]);
    const [event] = await events("ticket.dependency_removed");
    expect(event).toMatchObject({ subject_id: a.id });
    expect(event.payload).toEqual({ key: "PRIV-1", dependsOnKey: "PRIV-2", dependsOnTicketId: b.id });
    expect((await unlink(a.id, b.id)).status).toBe(404);
    expect(await events("ticket.dependency_removed")).toHaveLength(1);
  });

  it("um ticket pode depender de vários; o detalhe traz dependsOn e blocks em ordem de número", async () => {
    const a = await add();
    const b = await add({ title: "B" });
    const c = await add({ title: "C" });
    const d = await add();
    await link(d.id, c.id);
    await link(d.id, b.id);
    await link(c.id, a.id);
    await link(b.id, a.id);
    expect((await detail(d.id)).dependsOn.map((l) => l.key)).toEqual(["PRIV-2", "PRIV-3"]);
    expect((await detail(a.id)).blocks).toEqual([
      { id: b.id, key: "PRIV-2", title: "B", status: "todo", fromLinear: false, dueDate: null, need: "start" },
      { id: c.id, key: "PRIV-3", title: "C", status: "todo", fromLinear: false, dueDate: null, need: "start" },
    ]);
    expect((await detail(a.id)).dependsOn).toEqual([]);
    expect((await detail(d.id)).blocks).toEqual([]);
  });
});

describe("recusas", () => {
  it("depender de si mesmo: 409 dependency_self", async () => {
    const a = await add();
    const res = await link(a.id, a.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("dependency_self");
    expect(await deps()).toEqual([]);
  });

  it("fechar um ciclo direto ou por vários passos: 409 dependency_cycle, sem ligação nem evento", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await link(a.id, b.id);
    const direct = await link(b.id, a.id);
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe("dependency_cycle");
    await link(b.id, c.id);
    const long = await link(c.id, a.id);
    expect(long.status).toBe(409);
    expect(long.body.error.code).toBe("dependency_cycle");
    expect(await deps()).toEqual(["1>2", "2>3"]);
    expect(await events("ticket.dependency_added")).toHaveLength(2);
  });

  it("losango (A→B, A→C, B→D, C→D) não é ciclo", async () => {
    const [a, b, c, d] = [await add(), await add(), await add(), await add()] as const;
    for (const [x, y] of [[a, b], [a, c], [b, d], [c, d]] as const) expect((await link(x.id, y.id)).status).toBe(200);
    expect(await deps()).toEqual(["1>2", "1>3", "2>4", "3>4"]);
  });

  it("o outro ticket não existe, é de outro projeto ou de outra organização: 404 como ticket não encontrado", async () => {
    const a = await add();
    const elsewhere = await add({}, open());
    const w = h.world();
    const foreign = (
      await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_B', $1, 1, 'B', $2) returning id", [w.other.project, w.other.person])
    ).rows[0].id as string;
    for (const target of [UNKNOWN_ID, elsewhere.id, foreign]) {
      const res = await link(a.id, target);
      expect(res.status, target).toBe(404);
      expect(res.body.error.message).toBe("Ticket não encontrado.");
      expect((await unlink(a.id, target)).status, target).toBe(404);
    }
    expect((await link(UNKNOWN_ID, a.id)).status).toBe(404);
    expect(await deps()).toEqual([]);
    expect(await events("ticket.dependency_added")).toHaveLength(0);
  });

  it("corpo inválido: 400", async () => {
    const a = await add();
    for (const body of [{}, { ticketId: "x" }, { ticketId: 1 }]) {
      expect((await h.call("POST", `/api/tickets/${a.id}/dependencies`, as("admin"), body)).status).toBe(400);
    }
  });
});

describe("permissão e projeto arquivado", () => {
  it("leitor: 403 em adicionar e remover, mas lê dependsOn e blocks; quem não vê o projeto: 404", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    for (const who of ["reader"] as const) {
      expect((await link(b.id, a.id, who)).status).toBe(403);
      expect((await unlink(a.id, b.id, who)).status).toBe(403);
      const read = await h.call("GET", `/api/tickets/${a.id}`, as(who));
      expect((read.body as Detail).dependsOn).toHaveLength(1);
    }
    for (const who of ["plain", "teamAdmin"] as const) {
      expect((await link(b.id, a.id, who)).status).toBe(404);
      expect((await unlink(a.id, b.id, who)).status).toBe(404);
    }
    expect(await deps()).toEqual(["1>2"]);
  });

  it("contribuidor e gerente podem", async () => {
    const a = await add();
    const b = await add();
    expect((await link(a.id, b.id, "contributor")).status).toBe(200);
    expect((await unlink(a.id, b.id, "manager")).status).toBe(204);
  });

  it("projeto arquivado: 409 project_archived em adicionar e remover; a leitura continua", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    for (const res of [await link(b.id, a.id), await unlink(a.id, b.id)]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("project_archived");
    }
    expect(await deps()).toEqual(["1>2"]);
    expect((await detail(a.id)).dependsOn).toHaveLength(1);
  });
});

describe("nada mais muda", () => {
  it("concluir um ticket com dependência aberta continua permitido; nenhuma situação nem pai muda", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    const done = await h.call("PATCH", `/api/tickets/${a.id}`, as("admin"), { status: "done" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await detail(b.id)).status).toBe("todo");
    const rows = (await h.pool.query("select number, status, parent_id from tickets order by number")).rows;
    expect(rows.map((r) => [r.number, r.status, r.parent_id])).toEqual([[1, "done", null], [2, "todo", null]]);
    expect(await events("ticket.updated")).toHaveLength(1);
  });

  it("as rotas não tocam nas ligações menciona, e a descrição não toca em depends_on", async () => {
    const a = await add();
    const b = await add({ description: "PRIV-1" });
    const mentions = async () => (await h.pool.query("select id from ticket_relations where kind = 'mentions'")).rows;
    const before = await mentions();
    expect(before).toHaveLength(1);
    await link(b.id, a.id);
    await unlink(b.id, a.id);
    await link(a.id, b.id);
    expect(await mentions()).toEqual(before);
    await h.call("PATCH", `/api/tickets/${a.id}`, as("admin"), { description: "sem chave" });
    await h.call("PATCH", `/api/tickets/${b.id}`, as("admin"), { description: "sem chave" });
    expect(await deps()).toEqual(["1>2"]);
    expect((await detail(a.id)).mentionedBy).toEqual([]);
  });

  it("apagar o ticket leva as ligações junto", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    expect((await h.call("DELETE", `/api/tickets/${a.id}`, as("admin"))).status).toBe(204);
    expect(await count("select count(*) from ticket_relations")).toBe(0);
    expect((await detail(b.id)).blocks).toEqual([]);
  });
});

describe("corrida do ciclo", () => {
  it("A→B e B→A ao mesmo tempo: uma entra e a outra é recusada, nunca as duas", async () => {
    for (let round = 0; round < 12; round += 1) {
      await h.pool.query("delete from ticket_relations");
      await h.pool.query("delete from tickets");
      await h.pool.query("update projects set next_ticket_number = 1 where id = $1", [priv()]);
      const a = await add();
      const b = await add();
      const results = await Promise.all([link(a.id, b.id), link(b.id, a.id)]);
      expect(results.map((r) => r.status).sort(), `rodada ${round}`).toEqual([200, 409]);
      expect(await count("select count(*) from ticket_relations where kind = 'depends_on'"), `rodada ${round}`).toBe(1);
    }
  });

  it("anel de três (A→B, B→C, C→A) em paralelo: no máximo duas entram", async () => {
    for (let round = 0; round < 8; round += 1) {
      await h.pool.query("delete from ticket_relations");
      await h.pool.query("delete from tickets");
      await h.pool.query("update projects set next_ticket_number = 1 where id = $1", [priv()]);
      const [a, b, c] = [await add(), await add(), await add()] as const;
      const results = await Promise.all([link(a.id, b.id), link(b.id, c.id), link(c.id, a.id)]);
      expect(results.filter((r) => r.status === 200).length, `rodada ${round}`).toBe(2);
      expect(results.filter((r) => r.status === 409).length, `rodada ${round}`).toBe(1);
    }
  });

  it("a mesma ligação duas vezes ao mesmo tempo: as duas respondem 200 e sobra uma só, com um evento", async () => {
    const a = await add();
    const b = await add();
    const results = await Promise.all([link(a.id, b.id), link(a.id, b.id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await deps()).toEqual(["1>2"]);
    expect(await events("ticket.dependency_added")).toHaveLength(1);
  });
});
