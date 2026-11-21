import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness();

type Body = Record<string, unknown>;

const P = () => h.world().projects.priv;
const create = (body: Body, who: Who = "admin") => h.call("POST", `/api/projects/${P()}/tickets`, as(who), body);
const made = async (body: Body = {}, who: Who = "admin"): Promise<Body & { id: string }> => {
  const res = await create({ title: "Nó", ...body }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body & { id: string };
};
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const get = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body as Body;
const importTo = (body: unknown, who: Who = "admin") => h.call("POST", `/api/projects/${P()}/tickets/import`, as(who), body);
const events = async (kind: string) =>
  (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;

describe("um só tipo: respostas", () => {
  it("o ticket não traz kind; sem filhos tem situação e progress null", async () => {
    const t = await made({});
    expect(t).not.toHaveProperty("kind");
    expect(t).toMatchObject({ status: "todo", progress: null });
    const list = await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"));
    for (const row of list.body) expect(row).not.toHaveProperty("kind");
  });

  it("ticket com filhos mostra a situação guardada e progress objeto; sem filhos, progress null", async () => {
    const parent = await made({ status: "in_review" });
    await made({ parentId: parent.id, status: "done" });
    await made({ parentId: parent.id, status: "cancelled" });
    await made({ parentId: parent.id });
    expect(await get(parent.id)).toMatchObject({ status: "in_review", progress: { done: 1, total: 2, excluded: 1 } });
    const list = await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"));
    expect(list.body[0]).toMatchObject({ status: "in_review", progress: { done: 1, total: 2, excluded: 1 } });
    expect(list.body[1]).toMatchObject({ progress: null });
  });

  it("o ex-agrupador (linha com kind='group' e status guardado) volta a mostrar a situação guardada", async () => {
    const before = await made({});
    await h.pool.query("update tickets set kind = 'group', status = 'in_progress' where id = $1", [before.id]);
    await made({ parentId: before.id });
    const detail = await get(before.id);
    expect(detail).toMatchObject({ status: "in_progress", progress: { done: 0, total: 1, excluded: 0 } });
    expect(detail).not.toHaveProperty("kind");
  });

  it("o progresso conta todos os descendentes em qualquer nível, inclusive os que também têm filhos", async () => {
    const root = await made({});
    const mid = await made({ parentId: root.id, status: "in_progress" });
    await made({ parentId: mid.id, status: "done" });
    await made({ parentId: mid.id, status: "cancelled" });
    const list = await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"));
    const byId = Object.fromEntries(list.body.map((t: Body) => [t.id, t]));
    expect(byId[root.id as string]).toMatchObject({ progress: { done: 1, total: 2, excluded: 1 } });
    expect(byId[mid.id as string]).toMatchObject({ progress: { done: 1, total: 1, excluded: 1 } });
  });
});

describe("kind no corpo", () => {
  it("criar, PATCH e item da importação com kind: 400 (campo desconhecido), nada criado", async () => {
    const t = await made({});
    expect((await create({ title: "x", kind: "group" })).status).toBe(400);
    expect((await create({ title: "x", kind: "ticket" })).status).toBe(400);
    expect((await patch(t.id, { kind: "group" })).status).toBe(400);
    expect((await importTo({ items: [{ title: "x", kind: "group" }] })).status).toBe(400);
    expect((await importTo({ items: [{ title: "x", children: [{ title: "y", kind: "ticket" }] }] })).status).toBe(400);
    expect((await h.pool.query("select count(*)::int as n from tickets")).rows[0].n).toBe(1);
  });

  it("a gravação nova não escreve parent_kind e deixa kind no padrão", async () => {
    const a = await made({});
    const b = await made({ parentId: a.id });
    const row = (await h.pool.query("select kind, parent_kind from tickets where id = $1", [b.id])).rows[0];
    expect(row).toEqual({ kind: "ticket", parent_kind: null });
  });
});

describe("pai: qualquer ticket do projeto fora da própria subárvore", () => {
  it("criar dentro de um ticket sem filhos e mover para dentro dele", async () => {
    const leaf = await made({});
    const child = await made({ parentId: leaf.id });
    expect(child.parentId).toBe(leaf.id);
    const other = await made({});
    const moved = await patch(other.id, { parentId: leaf.id });
    expect(moved.status).toBe(200);
    expect(moved.body.parentId).toBe(leaf.id);
    expect((await patch(other.id, { parentId: null })).body.parentId).toBeNull();
  });

  it("ciclo recusado: o próprio ticket ou um descendente (409 ticket_cycle)", async () => {
    const a = await made({});
    const b = await made({ parentId: a.id });
    const c = await made({ parentId: b.id });
    for (const parentId of [a.id, b.id, c.id]) {
      const res = await patch(a.id, { parentId });
      expect(res.status, parentId).toBe(409);
      expect(res.body.error.code).toBe("ticket_cycle");
    }
    expect((await get(a.id)).parentId).toBeNull();
  });

  it("pai de outro projeto ou inexistente: 404", async () => {
    const a = await made({});
    const other = (await h.call("POST", `/api/projects/${h.world().projects.org}/tickets`, as("admin"), { title: "o" })).body.id;
    expect((await create({ title: "x", parentId: other })).status).toBe(404);
    expect((await patch(a.id, { parentId: other })).status).toBe(404);
  });

  it("os erros antigos de tipo não existem mais", async () => {
    const t = await made({});
    const res = await create({ title: "filho", parentId: t.id });
    expect(res.status).toBe(201);
    const withStatus = await patch(t.id, { status: "done" });
    // t tem um filho aberto: o erro agora é outro, e não é group_has_no_status.
    expect(withStatus.body.error.code).toBe("ticket_has_open_children");
  });
});

describe("concluir com filho direto aberto", () => {
  it("recusa com um filho aberto: 409 ticket_has_open_children e a contagem no corpo; nada muda", async () => {
    const p = await made({});
    await made({ parentId: p.id });
    const res = await patch(p.id, { status: "done" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_has_open_children");
    expect(res.body.error.details).toEqual({ openChildCount: 1 });
    expect((await get(p.id)).status).toBe("todo");
  });

  it("recusa com vários filhos abertos (todo, em andamento, em revisão), contando só os diretos abertos", async () => {
    const p = await made({});
    await made({ parentId: p.id, status: "todo" });
    await made({ parentId: p.id, status: "in_progress" });
    const review = await made({ parentId: p.id, status: "in_review" });
    await made({ parentId: p.id, status: "done" });
    await made({ parentId: p.id, status: "cancelled" });
    await made({ parentId: review.id }); // neto aberto não entra na contagem do avô
    const res = await patch(p.id, { status: "done" });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ openChildCount: 3 });
  });

  it("recusa também no mesmo PATCH que muda o título", async () => {
    const p = await made({});
    await made({ parentId: p.id });
    expect((await patch(p.id, { title: "Novo", status: "done" })).status).toBe(409);
    expect((await get(p.id)).title).toBe("Nó");
  });

  it("aceita com todos os filhos diretos finalizados, ou sem filhos", async () => {
    const p = await made({});
    await made({ parentId: p.id, status: "done" });
    await made({ parentId: p.id, status: "cancelled" });
    expect((await patch(p.id, { status: "done" })).body.status).toBe("done");
    const leaf = await made({});
    expect((await patch(leaf.id, { status: "done" })).body.status).toBe("done");
  });

  it("aceita com filho finalizado que tem neto aberto (só os filhos diretos contam)", async () => {
    const p = await made({});
    const kid = await made({ parentId: p.id, status: "done" });
    await made({ parentId: kid.id, status: "todo" }); // reabre o kid (J1b); o estado "done com neto aberto" vem do banco
    await h.pool.query("update tickets set status = 'done' where id = $1", [kid.id]);
    expect((await patch(p.id, { status: "done" })).status).toBe(200);
  });

  it("cancelar um pai com filhos abertos é aceito e não mexe nos filhos", async () => {
    const p = await made({});
    const kid = await made({ parentId: p.id });
    const res = await patch(p.id, { status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await get(kid.id)).status).toBe("todo");
  });

  it("nenhuma situação muda sozinha: finalizar o último filho não mexe no pai", async () => {
    const p = await made({ status: "in_progress" });
    const kid = await made({ parentId: p.id });
    await patch(kid.id, { status: "done" });
    expect((await get(p.id)).status).toBe("in_progress");
  });

  it("criar filho aberto em pai concluído é aceito e reabre o pai (J1b); mover para dentro também", async () => {
    const p = await made({});
    await patch(p.id, { status: "done" });
    const kid = await made({ parentId: p.id });
    expect(kid.status).toBe("todo");
    expect((await get(p.id)).status).toBe("todo");
    await patch(kid.id, { status: "done" });
    await patch(p.id, { status: "done" });
    const other = await made({});
    expect((await patch(other.id, { parentId: p.id })).status).toBe(200);
    expect((await get(p.id)).status).toBe("todo");
  });

  it("reabrir um filho de pai concluído é aceito e reabre o pai (J1b)", async () => {
    const p = await made({});
    const kid = await made({ parentId: p.id, status: "done" });
    await patch(p.id, { status: "done" });
    expect((await patch(kid.id, { status: "todo" })).status).toBe(200);
    expect((await get(p.id)).status).toBe("todo");
  });

  it("sequencial nos dois sentidos: filho criado antes impede concluir; concluir antes deixa criar", async () => {
    const a = await made({});
    await made({ parentId: a.id });
    expect((await patch(a.id, { status: "done" })).status).toBe(409);
    const b = await made({});
    expect((await patch(b.id, { status: "done" })).status).toBe(200);
    expect((await create({ title: "depois", parentId: b.id })).status).toBe(201);
    expect((await get(b.id)).status).toBe("todo"); // reaberto (J1b)
  });

  it("concluir de novo um pai que foi reaberto por um filho aberto é recusado", async () => {
    const p = await made({});
    await patch(p.id, { status: "done" });
    await made({ parentId: p.id });
    expect((await patch(p.id, { status: "done", title: "Outro" })).status).toBe(409);
  });
});

describe("evento de atividade", () => {
  it("ticket.created e ticket.updated não levam kind", async () => {
    const t = await made({});
    const created = await events("ticket.created");
    expect(created[0].payload).not.toHaveProperty("kind");
    await patch(t.id, { title: "Outro" });
    const updated = await events("ticket.updated");
    expect(updated[0].payload.fields).toEqual(["title"]);
  });
});

describe("remoção", () => {
  it("ticket com filhos: 409 ticket_has_children; sem filhos é removido", async () => {
    const p = await made({});
    const child = await made({ parentId: p.id });
    const res = await h.call("DELETE", `/api/tickets/${p.id}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_has_children");
    expect((await h.call("DELETE", `/api/tickets/${child.id}`, as("admin"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/tickets/${p.id}`, as("admin"))).status).toBe(204);
  });
});

describe("importação", () => {
  it("item com filhos é só um ticket com filhos: situação própria e progresso", async () => {
    const res = await importTo({
      items: [{ title: "Fase", status: "in_progress", children: [{ title: "a", status: "done" }, { title: "b" }] }, { title: "solto" }],
    });
    expect(res.status).toBe(201);
    const byTitle = Object.fromEntries(res.body.map((t: Body) => [t.title, t]));
    expect(byTitle["Fase"]).toMatchObject({ status: "in_progress", progress: { done: 1, total: 2, excluded: 0 } });
    expect(byTitle["a"]).toMatchObject({ status: "done", progress: null });
    expect(byTitle["solto"]).toMatchObject({ status: "todo", progress: null });
    for (const row of res.body) expect(row).not.toHaveProperty("kind");
  });

  it("importar dentro de qualquer ticket funciona; dentro de inexistente é 404", async () => {
    const t = await made({});
    const ok = await importTo({ parentId: t.id, items: [{ title: "x" }] });
    expect(ok.status).toBe(201);
    expect(ok.body[0].parentId).toBe(t.id);
    expect((await importTo({ parentId: "00000000-0000-4000-8000-000000000000", items: [{ title: "x" }] })).status).toBe(404);
  });

  it("leitor não importa (403)", async () => {
    expect((await importTo({ items: [{ title: "x" }] }, "reader")).status).toBe(403);
  });
});
