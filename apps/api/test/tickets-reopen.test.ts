import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

/** ADR 0034, J1b: o pai concluído que ganha um filho aberto é reaberto (`todo`), subindo até o primeiro que não está `done`. */
const h = useHarness();
type Body = Record<string, unknown>;
const P = () => h.world().projects.priv;
const create = (body: Body, who: Who = "admin") => h.call("POST", `/api/projects/${P()}/tickets`, as(who), { title: "Nó", ...body });
const made = async (body: Body = {}, who: Who = "admin"): Promise<{ id: string; status: string }> => {
  const res = await create(body, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; status: string };
};
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const status = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body.status as string;
const done = async (body: Body = {}) => {
  const t = await made(body);
  expect((await patch(t.id, { status: "done" })).status).toBe(200);
  return t;
};
const violations = async () =>
  (await h.pool.query(
    "select count(*)::int as n from tickets p where p.status = 'done' and exists (select 1 from tickets c where c.parent_id = p.id and c.status not in ('done','cancelled'))",
  )).rows[0].n as number;
const autoEvents = async () =>
  (await h.pool.query("select subject_id, payload from activity_events where kind = 'ticket.updated' and payload->>'automatic' = 'true' order by occurred_at, id")).rows;

describe("pontos de entrada que reabrem o pai concluído", () => {
  it("criar ticket aberto dentro de um done reabre o pai, com um evento automático", async () => {
    const p = await done();
    const kid = await made({ parentId: p.id });
    expect(await status(p.id)).toBe("todo");
    expect(await status(kid.id)).toBe("todo");
    const events = await autoEvents();
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(p.id);
    expect(events[0].payload).toMatchObject({ fields: ["status"], status: { from: "done", to: "todo" }, automatic: true });
    expect(events[0].payload.causedBy).toBeTruthy();
  });

  it("a subida por dois níveis, e para no cancelado", async () => {
    const a = await done();
    const b = await made({ parentId: a.id, status: "done" });
    await h.pool.query("update tickets set status = 'done' where id = $1", [a.id]);
    await made({ parentId: b.id });
    expect(await status(b.id)).toBe("todo");
    expect(await status(a.id)).toBe("todo");
    expect(await autoEvents()).toHaveLength(2);
    const x = await made({});
    const y = await made({ parentId: x.id, status: "cancelled" });
    const z = await made({ parentId: y.id, status: "done" });
    await h.pool.query("update tickets set status = 'done' where id = $1", [x.id]);
    await made({ parentId: z.id });
    expect(await status(z.id)).toBe("todo");
    expect(await status(y.id)).toBe("cancelled");
    expect(await status(x.id)).toBe("done");
  });

  it("pai cancelado não é reaberto", async () => {
    const p = await made({ status: "cancelled" });
    await made({ parentId: p.id });
    expect(await status(p.id)).toBe("cancelled");
    expect(await autoEvents()).toHaveLength(0);
  });

  it("mover um ticket aberto para dentro de um done reabre; o PATCH que muda pai e situação vale a situação final", async () => {
    const p = await done();
    const t = await made({});
    expect((await patch(t.id, { parentId: p.id })).status).toBe(200);
    expect(await status(p.id)).toBe("todo");
    const q = await done();
    const u = await made({ status: "done" });
    expect((await patch(u.id, { parentId: q.id, status: "todo" })).status).toBe(200);
    expect(await status(q.id)).toBe("todo");
    const r = await done();
    const w = await made({});
    expect((await patch(w.id, { parentId: r.id, status: "done" })).status).toBe(200);
    expect(await status(r.id)).toBe("done");
  });

  it("reabrir um filho (de done ou cancelled) cujo pai está done reabre o pai", async () => {
    for (const closed of ["done", "cancelled"]) {
      const p = await made({});
      const kid = await made({ parentId: p.id, status: closed });
      await patch(p.id, { status: "done" });
      expect((await patch(kid.id, { status: "in_progress" })).status).toBe(200);
      expect(await status(p.id)).toBe("todo");
    }
  });

  it("importação com pai existente done: item aberto reabre; item finalizado não", async () => {
    const p = await done();
    const res = await h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { parentId: p.id, items: [{ title: "x", status: "done" }] });
    expect(res.status).toBe(201);
    expect(await status(p.id)).toBe("done");
    expect((await h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { parentId: p.id, items: [{ title: "y" }] })).status).toBe(201);
    expect(await status(p.id)).toBe("todo");
  });

  it("importação: item done com filho aberto na própria lista nasce todo", async () => {
    const res = await h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { items: [{ title: "pai", status: "done", children: [{ title: "f" }] }] });
    expect(res.status).toBe(201);
    expect(res.body[0].status).toBe("todo");
    expect(await violations()).toBe(0);
  });

  it("a proposta de pai novo dentro de um destino done reabre o destino", async () => {
    const dest = await made({});
    const a = await made({ parentId: dest.id });
    await patch(a.id, { status: "done" });
    await patch(dest.id, { status: "done" });
    const events = await h.pool.query("select 1");
    expect(events.rows).toHaveLength(1);
    // o pai criado nasce todo dentro do destino: usa o mesmo caminho de criação
    const novo = await made({ parentId: dest.id, title: "Pai novo" });
    expect(novo.status).toBe("todo");
    expect(await status(dest.id)).toBe("todo");
  });
});

describe("o que não reabre", () => {
  it("criar ou mover um ticket finalizado para dentro de um done", async () => {
    const p = await done();
    await made({ parentId: p.id, status: "done" });
    await made({ parentId: p.id, status: "cancelled" });
    const t = await made({ status: "done" });
    await patch(t.id, { parentId: p.id });
    expect(await status(p.id)).toBe("done");
    expect(await autoEvents()).toHaveLength(0);
  });

  it("finalizar o último filho não muda o pai", async () => {
    const p = await made({ status: "in_progress" });
    const kid = await made({ parentId: p.id });
    await patch(kid.id, { status: "done" });
    expect(await status(p.id)).toBe("in_progress");
  });
});

describe("permissões e corrida", () => {
  it("quem pode criar o filho causa a reabertura, sem outra permissão", async () => {
    const p = await done();
    expect((await create({ parentId: p.id }, "contributor")).status).toBe(201);
    expect(await status(p.id)).toBe("todo");
    const q = await done();
    expect((await create({ parentId: q.id }, "reader")).status).toBe(403);
    expect(await status(q.id)).toBe("done");
  });

  it("concluir o pai × criar filho aberto ao mesmo tempo: nunca pai concluído com filho aberto", async () => {
    for (let i = 0; i < 6; i++) {
      const p = await made({});
      const [conclude, child] = await Promise.all([patch(p.id, { status: "done" }), create({ parentId: p.id })]);
      expect(child.status).toBe(201);
      expect([200, 409]).toContain(conclude.status);
      expect(await status(p.id)).toBe("todo");
      expect(await violations()).toBe(0);
    }
  });

  it("invariante depois de uma sequência variada de operações", async () => {
    const a = await made({});
    const b = await made({ parentId: a.id });
    const c = await made({ parentId: b.id, status: "done" });
    await patch(b.id, { status: "cancelled" });
    await patch(a.id, { status: "done" });
    await made({ parentId: a.id });
    const d = await made({ status: "done" });
    await patch(d.id, { parentId: c.id, status: "todo" });
    await patch(c.id, { status: "done" });
    await patch(c.id, { parentId: null });
    await patch(d.id, { status: "done" });
    await patch(a.id, { status: "done" });
    await patch(c.id, { parentId: a.id, status: "in_review" });
    expect(await violations()).toBe(0);
  });
});
