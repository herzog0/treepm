import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness();

type Body = Record<string, unknown>;

const P = () => h.world().projects.priv;
const create = (body: Body, who: Who = "admin") => h.call("POST", `/api/projects/${P()}/tickets`, as(who), body);
const made = async (body: Body, who: Who = "admin"): Promise<Body & { id: string }> => {
  const res = await create({ title: "Nó", ...body }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body & { id: string };
};
const group = (body: Body = {}) => made({ kind: "group", ...body });
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const importTo = (body: unknown, who: Who = "admin") => h.call("POST", `/api/projects/${P()}/tickets/import`, as(who), body);
const events = async (kind: string) =>
  (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;

describe("tipo do nó nas respostas", () => {
  it("ticket criado sem kind é do tipo ticket, com situação e sem progresso", async () => {
    const res = await create({ title: "T" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "ticket", status: "todo", progress: null });
  });

  it("agrupador vazio: status null e progresso 0 de 0, no detalhe e na lista", async () => {
    const g = await group();
    expect(g).toMatchObject({ kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } });
    const detail = await h.call("GET", `/api/tickets/${g.id}`, as("reader"));
    expect(detail.body).toMatchObject({ kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } });
    const list = await h.call("GET", `/api/projects/${P()}/tickets`, as("reader"));
    expect(list.body[0]).toMatchObject({ kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } });
  });

  it("o progresso conta os tickets descendentes em qualquer profundidade e não conta agrupadores", async () => {
    const outer = await group();
    const inner = await group({ parentId: outer.id });
    await made({ parentId: inner.id, status: "done" });
    await made({ parentId: outer.id, status: "in_progress" });
    await made({ parentId: outer.id, status: "cancelled" });
    const list = await h.call("GET", `/api/projects/${P()}/tickets`, as("reader"));
    const byId = Object.fromEntries(list.body.map((t: Body) => [t.id, t]));
    expect(byId[outer.id]).toMatchObject({ kind: "group", progress: { done: 1, total: 2, excluded: 1 } });
    expect(byId[inner.id]).toMatchObject({ kind: "group", progress: { done: 1, total: 1, excluded: 0 } });
    expect(list.body.filter((t: Body) => t.kind === "ticket").every((t: Body) => t.progress === null)).toBe(true);
  });
});

describe("criação com tipo", () => {
  it("cria agrupador na raiz e agrupador dentro de agrupador; recusa kind inválido (400)", async () => {
    const g = await group();
    const inner = await group({ parentId: g.id });
    expect(inner.parentId).toBe(g.id);
    expect((await create({ title: "x", kind: "folder" })).status).toBe(400);
  });

  it("pai que é ticket: 409 parent_not_group, para ticket e para agrupador, e nada é criado", async () => {
    const t = await made({});
    for (const kind of ["ticket", "group"]) {
      const res = await create({ title: "filho", kind, parentId: t.id });
      expect(res.status, kind).toBe(409);
      expect(res.body.error.code).toBe("parent_not_group");
    }
    expect((await h.pool.query("select count(*)::int as n from tickets")).rows[0].n).toBe(1);
  });

  it("agrupador criado com status no corpo: o valor é ignorado e a situação padrão fica guardada", async () => {
    const g = await group({ status: "done" });
    expect(g.status).toBeNull();
    expect((await h.pool.query("select status from tickets where id = $1", [g.id])).rows[0].status).toBe("todo");
  });

  it("agrupador aceita pessoas atribuídas", async () => {
    const person = h.world().people.reader;
    const g = await group({ assigneeIds: [person] });
    expect(g.assigneeIds).toEqual([person]);
    const t = await group();
    expect((await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("admin"))).status).toBe(200);
  });
});

describe("PATCH: transformação de tipo", () => {
  it("ticket vira agrupador mesmo com situação guardada, e a situação volta ao virar ticket de novo", async () => {
    const t = await made({ status: "in_progress" });
    const res = await patch(t.id, { kind: "group" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } });
    const back = await patch(t.id, { kind: "ticket" });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ kind: "ticket", status: "in_progress", progress: null });
  });

  it("agrupador com filhos não vira ticket: 409 ticket_has_children; nada muda", async () => {
    const g = await group();
    await made({ parentId: g.id });
    const res = await patch(g.id, { kind: "ticket" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_has_children");
    expect((await h.call("GET", `/api/tickets/${g.id}`, as("admin"))).body.kind).toBe("group");
  });

  it("agrupador cheio de agrupadores vazios também não vira ticket", async () => {
    const g = await group();
    await group({ parentId: g.id });
    expect((await patch(g.id, { kind: "ticket" })).body.error.code).toBe("ticket_has_children");
  });

  it("grava ticket.updated com kind entre os campos alterados; mesmo tipo não grava evento", async () => {
    const t = await made({});
    await patch(t.id, { kind: "ticket" });
    expect(await events("ticket.updated")).toHaveLength(0);
    await patch(t.id, { kind: "group" });
    const rows = await events("ticket.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.fields).toEqual(["kind"]);
    expect(rows[0].payload.kind).toEqual({ from: "ticket", to: "group" });
  });

  it("leitor e membro sem papel não transformam (403); quem não vê o projeto recebe 404", async () => {
    const t = await made({});
    expect((await patch(t.id, { kind: "group" }, "reader")).status).toBe(403);
    expect((await patch(t.id, { kind: "group" }, "plain")).status).toBe(404);
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("admin"))).body.kind).toBe("ticket");
  });

  it("colaborador transforma", async () => {
    const t = await made({});
    expect((await patch(t.id, { kind: "group" }, "contributor")).status).toBe(200);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const t = await made({});
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    const res = await patch(t.id, { kind: "group" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });

  it("kind inválido: 400", async () => {
    const t = await made({});
    expect((await patch(t.id, { kind: "folder" })).status).toBe(400);
  });
});

describe("PATCH: situação e pai", () => {
  it("situação em agrupador: 409 group_has_no_status (vazio ou com filhos)", async () => {
    const g = await group();
    for (let round = 0; round < 2; round++) {
      const res = await patch(g.id, { status: "done" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("group_has_no_status");
      await made({ parentId: g.id });
    }
  });

  it("ticket que vira agrupador no mesmo PATCH também não recebe situação; agrupador que vira ticket recebe", async () => {
    const t = await made({});
    expect((await patch(t.id, { kind: "group", status: "done" })).body.error.code).toBe("group_has_no_status");
    const g = await group();
    const res = await patch(g.id, { kind: "ticket", status: "done" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "ticket", status: "done" });
  });

  it("parentId apontando para um ticket: 409 parent_not_group, e nada muda", async () => {
    const t = await made({});
    const mover = await made({});
    const res = await patch(mover.id, { parentId: t.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("parent_not_group");
    expect((await h.call("GET", `/api/tickets/${mover.id}`, as("admin"))).body.parentId).toBeNull();
    const g = await group();
    expect((await patch(g.id, { parentId: t.id })).body.error.code).toBe("parent_not_group");
  });

  it("move ticket e agrupador para dentro de agrupador, e de volta para a raiz", async () => {
    const target = await group();
    const t = await made({});
    const g = await group();
    expect((await patch(t.id, { parentId: target.id })).body.parentId).toBe(target.id);
    expect((await patch(g.id, { parentId: target.id })).body.parentId).toBe(target.id);
    expect((await patch(g.id, { parentId: null })).body.parentId).toBeNull();
  });

  it("ciclo entre agrupadores continua 409 ticket_cycle", async () => {
    const a = await group();
    const b = await group({ parentId: a.id });
    const c = await group({ parentId: b.id });
    for (const parentId of [a.id, b.id, c.id]) {
      const res = await patch(a.id, { parentId });
      expect(res.status, parentId).toBe(409);
      expect(res.body.error.code).toBe("ticket_cycle");
    }
  });

  it("agrupador com filhos some da lista de pais válidos só ao virar ticket (que é recusado)", async () => {
    const g = await group();
    const child = await made({ parentId: g.id });
    await patch(child.id, { parentId: null });
    expect((await patch(g.id, { kind: "ticket" })).status).toBe(200);
    expect((await create({ title: "x", parentId: g.id })).body.error.code).toBe("parent_not_group");
  });
});

describe("remoção", () => {
  it("agrupador com filhos: 409 ticket_has_children; vazio é removido", async () => {
    const g = await group();
    const child = await made({ parentId: g.id });
    const res = await h.call("DELETE", `/api/tickets/${g.id}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_has_children");
    expect((await h.call("DELETE", `/api/tickets/${child.id}`, as("admin"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/tickets/${g.id}`, as("admin"))).status).toBe(204);
  });
});

describe("importação com tipo", () => {
  it("item com filhos vira agrupador e item sem filhos vira ticket", async () => {
    const res = await importTo({ items: [{ title: "Fase", children: [{ title: "a", status: "done" }, { title: "b" }] }, { title: "solto" }] });
    expect(res.status).toBe(201);
    const byTitle = Object.fromEntries(res.body.map((t: Body) => [t.title, t]));
    expect(byTitle["Fase"]).toMatchObject({ kind: "group", status: null, progress: { done: 1, total: 2, excluded: 0 } });
    expect(byTitle["a"]).toMatchObject({ kind: "ticket", status: "done", progress: null });
    expect(byTitle["solto"]).toMatchObject({ kind: "ticket", status: "todo" });
  });

  it("kind group sem filhos cria agrupador vazio", async () => {
    const res = await importTo({ items: [{ title: "Vazio", kind: "group" }] });
    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({ kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } });
  });

  it("kind ticket com filhos: 400 e nada criado, em qualquer profundidade", async () => {
    for (const items of [
      [{ title: "x", kind: "ticket", children: [{ title: "y" }] }],
      [{ title: "ok", children: [{ title: "x", kind: "ticket", children: [{ title: "y" }] }] }],
    ]) {
      expect((await importTo({ items })).status).toBe(400);
    }
    expect((await h.pool.query("select count(*)::int as n from tickets")).rows[0].n).toBe(0);
  });

  it("kind ticket sem filhos e kind group com filhos são aceitos", async () => {
    const res = await importTo({
      items: [{ title: "g", kind: "group", children: [{ title: "t", kind: "ticket" }] }],
    });
    expect(res.status).toBe(201);
    expect(res.body.map((t: Body) => t.kind)).toEqual(["group", "ticket"]);
  });

  it("a situação de item que vira agrupador é aceita e guardada, mas não aparece", async () => {
    const res = await importTo({ items: [{ title: "Fase", status: "in_progress", children: [{ title: "a" }] }] });
    expect(res.body[0].status).toBeNull();
    const stored = await h.pool.query("select status, kind from tickets where number = 1");
    expect(stored.rows[0]).toEqual({ status: "in_progress", kind: "group" });
  });

  it("importar dentro de um ticket: 409 parent_not_group; dentro de um agrupador funciona", async () => {
    const t = await made({});
    const bad = await importTo({ parentId: t.id, items: [{ title: "x" }] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("parent_not_group");
    const g = await group();
    const ok = await importTo({ parentId: g.id, items: [{ title: "x" }] });
    expect(ok.status).toBe(201);
    expect(ok.body[0].parentId).toBe(g.id);
  });

  it("leitor não importa (403)", async () => {
    expect((await importTo({ items: [{ title: "x", kind: "group" }] }, "reader")).status).toBe(403);
  });
});
