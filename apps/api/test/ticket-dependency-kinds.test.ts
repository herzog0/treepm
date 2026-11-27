import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0068, seções 3 e 4: o tipo de "depende de" (para começar, para entregar) e o lugar na fila (livre, próximo, esperando).
const h = useHarness();
const P = () => h.world().projects.priv;
type Body = Record<string, unknown>;
type Link = { id: string; key: string; need: string };
type Detail = { id: string; status: string; place: string | null; blocked: boolean; dependsOn: Link[]; blocks: Link[] };

const add = async (body: Body = {}): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const link = (from: string, to: string, need?: string) => h.call("POST", `/api/tickets/${from}/dependencies`, as("admin"), need === undefined ? { ticketId: to } : { ticketId: to, need });
const patch = (id: string, body: Body) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), body);
const detail = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body as Detail;
const list = async () => (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as Detail[];
const placeOf = async (id: string) => (await list()).find((ticket) => ticket.id === id)?.place;
const needs = async () =>
  (await h.pool.query("select f.number as f, t.number as t, r.need from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by f.number, t.number")).rows.map(
    (row) => `${row.f}>${row.t}:${row.need}`,
  );
const events = async (kind: string) => (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;

describe("o tipo da dependência", () => {
  it("sem tipo cria 'para começar'; o detalhe traz o tipo nos dois lados; o evento guarda o tipo", async () => {
    const a = await add();
    const b = await add();
    const res = await link(a.id, b.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as Detail).dependsOn).toMatchObject([{ id: b.id, need: "start" }]);
    expect((await detail(b.id)).blocks).toMatchObject([{ id: a.id, need: "start" }]);
    expect(await needs()).toEqual(["1>2:start"]);
    expect((await events("ticket.dependency_added"))[0].payload).toEqual({ key: "PRIV-1", dependsOnKey: "PRIV-2", dependsOnTicketId: b.id, need: "start" });
  });

  it("cria 'para entregar' quando pedido", async () => {
    const a = await add();
    const b = await add();
    expect((await link(a.id, b.id, "deliver")).status).toBe(200);
    expect((await detail(a.id)).dependsOn).toMatchObject([{ id: b.id, need: "deliver" }]);
    expect(await needs()).toEqual(["1>2:deliver"]);
  });

  it("pedir o mesmo par com outro tipo troca o tipo (uma linha só) e grava o evento da troca; com o mesmo tipo, nada muda", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    const changed = await link(a.id, b.id, "deliver");
    expect(changed.status).toBe(200);
    expect((changed.body as Detail).dependsOn).toMatchObject([{ id: b.id, need: "deliver" }]);
    expect(await needs()).toEqual(["1>2:deliver"]);
    const [event] = await events("ticket.dependency_need_changed");
    expect(event).toMatchObject({ subject_type: "ticket", subject_id: a.id });
    expect(event.payload).toEqual({ key: "PRIV-1", dependsOnKey: "PRIV-2", dependsOnTicketId: b.id, need: { from: "start", to: "deliver" } });
    expect((await link(a.id, b.id, "deliver")).status).toBe(200);
    expect(await events("ticket.dependency_need_changed")).toHaveLength(1);
    expect(await events("ticket.dependency_added")).toHaveLength(1);
  });

  it("tipo desconhecido: 400", async () => {
    const a = await add();
    const b = await add();
    expect((await link(a.id, b.id, "later")).status).toBe(400);
  });

  it("a recusa de ciclo olha os dois tipos juntos", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await link(a.id, b.id, "deliver");
    await link(b.id, c.id, "start");
    const res = await link(c.id, a.id, "deliver");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("dependency_cycle");
  });
});

describe("concluir com dependência para entregar aberta", () => {
  it("é recusado com 409 e as chaves que faltam; cancelar continua livre", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const d = await add();
    await link(a.id, b.id, "deliver");
    await link(a.id, c.id, "deliver");
    await link(a.id, d.id, "start");
    await patch(c.id, { status: "done" });
    const refused = await patch(a.id, { status: "done" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("ticket_has_open_delivery_dependencies");
    expect(refused.body.error.details).toEqual({ keys: ["PRIV-2"] });
    expect((await detail(a.id)).status).toBe("todo");
    expect((await patch(a.id, { status: "cancelled" })).status).toBe(200);
  });

  it("com a dependência para entregar finalizada, concluir passa; dependência para começar aberta não impede concluir", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await link(a.id, b.id, "deliver");
    await link(a.id, c.id, "start");
    await patch(b.id, { status: "cancelled" });
    expect((await patch(a.id, { status: "done" })).status).toBe(200);
  });
});

describe("lugar na fila no resumo e no detalhe", () => {
  it("livre, próximo e esperando seguem as dependências para começar", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await link(a.id, b.id);
    await link(b.id, c.id);
    expect([await placeOf(a.id), await placeOf(b.id), await placeOf(c.id)]).toEqual(["waiting", "next", "free"]);
    expect((await detail(a.id)).place).toBe("waiting");
    await patch(c.id, { status: "done" });
    expect([await placeOf(a.id), await placeOf(b.id), await placeOf(c.id)]).toEqual(["next", "free", null]);
    expect((await detail(b.id)).place).toBe("free");
  });

  // Revisão 1 (decisão da coordenação): alvo sem lugar na fila (pai ou ideia) não conta como livre.
  it("dependência para começar aberta num pai ou numa ideia: esperando, no resumo e no detalhe", async () => {
    const onParent = await add();
    const onIdea = await add();
    const parent = await add();
    await add({ parentId: parent.id });
    const idea = await add();
    expect((await h.call("POST", `/api/tickets/${idea.id}/idea`, as("admin"))).status).toBe(200);
    await link(onParent.id, parent.id);
    await link(onIdea.id, idea.id);
    expect([await placeOf(onParent.id), await placeOf(onIdea.id)]).toEqual(["waiting", "waiting"]);
    expect([(await detail(onParent.id)).place, (await detail(onIdea.id)).place]).toEqual(["waiting", "waiting"]);
  });

  it("para entregar não muda o lugar", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id, "deliver");
    expect(await placeOf(a.id)).toBe("free");
  });

  it("dependência aberta não deixa o ticket bloqueado", async () => {
    const a = await add();
    const b = await add();
    await link(a.id, b.id);
    expect((await list()).find((ticket) => ticket.id === a.id)?.blocked).toBe(false);
    expect((await detail(a.id)).blocked).toBe(false);
  });

  it("pai, concluído, cancelado e ideia não têm lugar", async () => {
    const parent = await add();
    const child = await add({ parentId: parent.id });
    const done = await add();
    await patch(done.id, { status: "done" });
    const ideaId = (await add()).id;
    expect((await h.call("POST", `/api/tickets/${ideaId}/idea`, as("admin"))).status).toBe(200);
    const tickets = await list();
    const place = (id: string) => tickets.find((ticket) => ticket.id === id)?.place;
    expect([place(parent.id), place(child.id), place(done.id), place(ideaId)]).toEqual([null, "free", null, null]);
    expect((await detail(parent.id)).place).toBeNull();
    expect((await detail(ideaId)).place).toBeNull();
  });
});

// ADR 0069, seção 1: a lista do projeto leva, em cada ticket, os tickets de que ele depende e o tipo; o mapa calcula o resto.
describe("a lista do projeto leva as dependências", () => {
  it("cada ticket traz `dependencies` (id e tipo, em ordem de número); quem não depende de ninguém traz lista vazia", async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await link(a.id, c.id, "deliver");
    await link(a.id, b.id);
    await link(b.id, c.id);
    const rows = (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as { id: string; dependencies: { id: string; need: string }[] }[];
    const of = (id: string) => rows.find((row) => row.id === id)?.dependencies;
    expect(of(a.id)).toEqual([
      { id: b.id, need: "start" },
      { id: c.id, need: "deliver" },
    ]);
    expect(of(b.id)).toEqual([{ id: c.id, need: "start" }]);
    expect(of(c.id)).toEqual([]);
  });
});
