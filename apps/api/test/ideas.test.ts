import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0042, fatia 1: ideias (estágio na raiz; a subárvore inteira fica fora do processo) e as cinco regras.
const h = useHarness();
const priv = () => h.world().projects.priv;
const open = () => h.world().projects.org;
type Body = Record<string, unknown>;
type Page = {
  id: string;
  key: string;
  parentId: string | null;
  status: string;
  idea: null | { root: true; stage: string } | { root: false; rootId: string; rootKey: string };
  progress: null | { done: number; total: number; excluded: number; ideas: number };
  canTriageIdea: boolean;
};
type Actor = Who | "outsider";
const session = (who: Actor) => (who === "outsider" ? as("outsider", "org_B") : as(who));

const add = async (body: Body = {}, project = priv(), who: Who = "admin"): Promise<Page> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as(who), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Page;
};
const idea = (body: Body = {}, project = priv()) => add({ idea: true, ...body }, project);
const get = async (id: string, who: Who = "admin"): Promise<Page> => {
  const res = await h.call("GET", `/api/tickets/${id}`, as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const stage = (id: string, to: string, who: Actor = "admin") => h.call("PUT", `/api/tickets/${id}/idea-stage`, session(who), { stage: to });
const accept = (id: string, who: Actor = "admin") => h.call("POST", `/api/tickets/${id}/idea/accept`, session(who));
const discard = (id: string, who: Actor = "admin") => h.call("POST", `/api/tickets/${id}/idea/discard`, session(who));
const transform = (id: string, who: Actor = "admin") => h.call("POST", `/api/tickets/${id}/idea`, session(who));
const setStatus = async (id: string, status: string) => {
  expect((await patch(id, { status })).status).toBe(200);
};
const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
const listIdeas = (project = priv(), who: Actor = "admin") => h.call("GET", `/api/projects/${project}/ideas`, session(who));
const activity = async (id: string) => (await h.call("GET", `/api/tickets/${id}/activity?limit=100`, as("admin"))).body.entries as { type: string; [k: string]: unknown }[];
const eventKinds = async (id: string) =>
  (await h.pool.query("select kind, payload from activity_events where subject_id = $1 and kind like 'ticket.idea_%' order by occurred_at, id", [id])).rows as { kind: string; payload: Record<string, unknown> }[];
const autoEvents = async () =>
  (await h.pool.query("select subject_id, payload from activity_events where kind = 'ticket.updated' and payload->>'automatic' = 'true' order by occurred_at, id")).rows;

describe("registrar: POST tickets com idea: true", () => {
  it("cria no estágio new, na situação todo, com idea { root: true, stage } e progress nulo", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("contributor"), { title: "Ideia", idea: true });
    expect(res.status).toBe(201);
    expect(res.body.idea).toEqual({ root: true, stage: "new" });
    expect(res.body.status).toBe("todo");
    expect(res.body.progress).toBeNull();
    expect(res.body.canTriageIdea).toBe(false);
    expect((await get(res.body.id, "manager")).canTriageIdea).toBe(true);
    expect((await h.pool.query("select idea_stage, status from tickets where id = $1", [res.body.id])).rows[0]).toEqual({ idea_stage: "new", status: "todo" });
  });

  it("ticket comum: idea é null; idea: false também", async () => {
    expect((await add()).idea).toBeNull();
    expect((await add({ idea: false })).idea).toBeNull();
  });

  it("idea com situação que não é todo: 400", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "x", idea: true, status: "done" });
    expect(res.status).toBe(400);
    const ok = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "x", idea: true, status: "todo" });
    expect(ok.status).toBe(201);
  });

  it("evento ticket.idea_registered no assunto ticket, e a entrada idea_registered na atividade", async () => {
    const i = await idea();
    const events = await eventKinds(i.id);
    expect(events.map((e) => e.kind)).toEqual(["ticket.idea_registered"]);
    expect(events[0]?.payload).toMatchObject({ key: i.key, source: "created" });
    expect((await activity(i.id)).map((e) => e.type)).toEqual(["idea_registered", "created"]);
  });

  it.each([
    ["admin", 201],
    ["manager", 201],
    ["contributor", 201],
    ["reader", 403],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("papel %s: %i", async (who, expected) => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, session(who), { title: "I", idea: true });
    expect(res.status).toBe(expected);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "I", idea: true });
    expect(res.status).toBe(409);
    expect(code(res)).toBe("project_archived");
  });

  it("ticket comum criado dentro de uma ideia faz parte dela e nasce todo; situação diferente: 409 ticket_in_idea", async () => {
    const i = await idea({ title: "I" });
    const kid = await add({ parentId: i.id });
    expect(kid.idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
    expect(kid.status).toBe("todo");
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "x", parentId: kid.id, status: "in_progress" });
    expect(res.status).toBe(409);
    expect(code(res)).toBe("ticket_in_idea");
  });

  it("ideia dentro de ideia: a raiz mais próxima vale", async () => {
    const outer = await idea();
    const mid = await add({ parentId: outer.id });
    const inner = await idea({ parentId: mid.id });
    const leaf = await add({ parentId: inner.id });
    expect(inner.idea).toEqual({ root: true, stage: "new" });
    expect(leaf.idea).toEqual({ root: false, rootId: inner.id, rootKey: inner.key });
    expect((await get(mid.id)).idea).toEqual({ root: false, rootId: outer.id, rootKey: outer.key });
  });
});

describe("o caso da ADR 0042: ideia dentro de um ticket concluído", () => {
  it("registrar uma ideia dentro de um ticket done não o reabre (regra 1)", async () => {
    const p = await add();
    await setStatus(p.id, "done");
    const i = await idea({ parentId: p.id });
    expect((await get(p.id)).status).toBe("done");
    expect(await autoEvents()).toHaveLength(0);
    // ticket comum dentro da ideia também não reabre
    await add({ parentId: i.id });
    expect((await get(p.id)).status).toBe("done");
    expect(await autoEvents()).toHaveLength(0);
  });

  it("o pai com uma ideia aberta dentro pode ser concluído (regra 2) e o progresso não muda; ideas vale 1 (regra 3)", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    await add({ parentId: i.id });
    expect((await get(p.id)).progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 1 });
    const done = await patch(p.id, { status: "done" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 1 });
    // com um filho comum ao lado da ideia, a situação passa a ser calculada (ADR 0068): só o comum conta
    const q = await add();
    await idea({ parentId: q.id });
    await add({ parentId: q.id });
    const refused = await patch(q.id, { status: "done" });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe("status_is_derived");
  });

  it("depois de aceitar, a situação do pai done passa a sair dos filhos, com o evento automático, e o progresso conta a subárvore", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    const a = await add({ parentId: i.id });
    await add({ parentId: i.id });
    await setStatus(p.id, "done");
    const accepted = await accept(i.id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.idea).toBeNull();
    expect(accepted.body.status).toBe("todo");
    const parent = await get(p.id);
    expect(parent.status).toBe("todo");
    expect(parent.progress).toEqual({ done: 0, total: 3, excluded: 0, ideas: 0 });
    const events = await autoEvents();
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(p.id);
    expect(events[0].payload).toMatchObject({ fields: ["status"], status: { from: "done", to: "todo" }, automatic: true, causedBy: i.key });
    expect((await get(a.id)).idea).toBeNull();
    expect((await activity(p.id)).find((e) => e.type === "status_changed")).toMatchObject({ from: "done", to: "todo", automatic: true });
  });
});

describe("mudar o estágio: PUT tickets/:id/idea-stage", () => {
  it("entre new, refining e ready, com o evento idea_stage_changed (antes e depois) e a entrada na atividade", async () => {
    const i = await idea();
    const res = await stage(i.id, "refining");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toEqual({ root: true, stage: "refining" });
    expect((await stage(i.id, "ready")).body.idea).toEqual({ root: true, stage: "ready" });
    expect((await stage(i.id, "new")).body.idea).toEqual({ root: true, stage: "new" });
    const events = (await eventKinds(i.id)).filter((e) => e.kind === "ticket.idea_stage_changed");
    expect(events.map((e) => e.payload)).toEqual([
      { key: i.key, from: "new", to: "refining" },
      { key: i.key, from: "refining", to: "ready" },
      { key: i.key, from: "ready", to: "new" },
    ]);
    const entries = (await activity(i.id)).filter((e) => e.type === "idea_stage_changed");
    expect(entries.map((e) => [e.from, e.to])).toEqual([["ready", "new"], ["refining", "ready"], ["new", "refining"]]);
  });

  it("o mesmo estágio: 200, sem evento novo", async () => {
    const i = await idea();
    expect((await stage(i.id, "new")).status).toBe(200);
    expect((await eventKinds(i.id)).filter((e) => e.kind === "ticket.idea_stage_changed")).toHaveLength(0);
  });

  it("discarded não vale nesta rota (400); estágio inexistente: 400", async () => {
    const i = await idea();
    expect((await stage(i.id, "discarded")).status).toBe(400);
    expect((await stage(i.id, "banana")).status).toBe(400);
  });

  it("ticket comum: 409 ticket_not_idea_root; ticket dentro de uma ideia, que não é a raiz, também", async () => {
    const t = await add();
    const res = await stage(t.id, "refining");
    expect(res.status).toBe(409);
    expect(code(res)).toBe("ticket_not_idea_root");
    const i = await idea();
    const kid = await add({ parentId: i.id });
    expect(code(await stage(kid.id, "ready"))).toBe("ticket_not_idea_root");
  });

  it.each([
    ["admin", 200],
    ["manager", 200],
    ["contributor", 200],
    ["reader", 403],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("papel %s: %i", async (who, expected) => {
    const i = await idea();
    expect((await stage(i.id, "refining", who)).status).toBe(expected);
  });

  it("projeto arquivado: 409", async () => {
    const i = await idea();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await stage(i.id, "refining");
    expect(res.status).toBe(409);
    expect(code(res)).toBe("project_archived");
  });
});

describe("descartar e reabrir", () => {
  it("descartar: só gestor; estágio discarded; evento idea_discarded; nada mais muda", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    const kid = await add({ parentId: i.id });
    const res = await discard(i.id, "manager");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toEqual({ root: true, stage: "discarded" });
    expect((await get(kid.id)).idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
    expect((await get(kid.id)).status).toBe("todo");
    expect((await get(p.id)).status).toBe("todo");
    expect((await eventKinds(i.id)).map((e) => e.kind)).toEqual(["ticket.idea_registered", "ticket.idea_discarded"]);
    expect((await eventKinds(i.id))[1]?.payload).toMatchObject({ key: i.key, from: "new" });
    expect((await activity(i.id))[0]).toMatchObject({ type: "idea_discarded" });
  });

  it.each([
    ["admin", 200],
    ["manager", 200],
    ["contributor", 403],
    ["reader", 403],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("descartar, papel %s: %i", async (who, expected) => {
    const i = await idea();
    expect((await discard(i.id, who)).status).toBe(expected);
  });

  it("descartar ticket comum: 409 ticket_not_idea_root; descartar a descartada: 409 idea_discarded", async () => {
    const t = await add();
    expect(code(await discard(t.id))).toBe("ticket_not_idea_root");
    const i = await idea();
    await discard(i.id);
    const again = await discard(i.id);
    expect(again.status).toBe(409);
    expect(code(again)).toBe("idea_discarded");
  });

  it("reabrir: de discarded só para refining, com o evento idea_reopened (quem edita pode)", async () => {
    const i = await idea();
    await discard(i.id);
    const bad = await stage(i.id, "ready");
    expect(bad.status).toBe(409);
    expect(code(bad)).toBe("idea_stage_transition");
    expect(code(await stage(i.id, "new"))).toBe("idea_stage_transition");
    const res = await stage(i.id, "refining", "contributor");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toEqual({ root: true, stage: "refining" });
    expect((await eventKinds(i.id)).map((e) => e.kind)).toEqual(["ticket.idea_registered", "ticket.idea_discarded", "ticket.idea_reopened"]);
    expect((await activity(i.id))[0]).toMatchObject({ type: "idea_reopened" });
  });

  it("projeto arquivado: 409", async () => {
    const i = await idea();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(code(await discard(i.id))).toBe("project_archived");
    expect(code(await accept(i.id))).toBe("project_archived");
  });
});

describe("aceitar", () => {
  it.each([
    ["admin", 200],
    ["manager", 200],
    ["contributor", 403],
    ["reader", 403],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("papel %s: %i", async (who, expected) => {
    const i = await idea();
    expect((await accept(i.id, who)).status).toBe(expected);
  });

  it("tira o estágio; a subárvore vira ticket comum, todos todo; evento idea_accepted e a entrada na atividade", async () => {
    const i = await idea();
    const a = await add({ parentId: i.id });
    const b = await add({ parentId: a.id });
    const res = await accept(i.id);
    expect(res.status).toBe(200);
    expect(res.body.idea).toBeNull();
    for (const t of [i, a, b]) {
      const row = (await get(t.id)) as Page;
      expect(row.idea).toBeNull();
      expect(row.status).toBe("todo");
    }
    expect(res.body.progress).toEqual({ done: 0, total: 2, excluded: 0, ideas: 0 });
    expect((await eventKinds(i.id)).map((e) => e.kind)).toEqual(["ticket.idea_registered", "ticket.idea_accepted"]);
    expect((await eventKinds(i.id))[1]?.payload).toMatchObject({ key: i.key, from: "new" });
    expect((await activity(i.id))[0]).toMatchObject({ type: "idea_accepted" });
  });

  it("a ideia de dentro continua ideia; aceitar a de fora não aceita a de dentro", async () => {
    const outer = await idea();
    const mid = await add({ parentId: outer.id });
    const inner = await idea({ parentId: mid.id });
    const leaf = await add({ parentId: inner.id });
    const res = await accept(outer.id);
    expect(res.status).toBe(200);
    expect(res.body.idea).toBeNull();
    expect((await get(mid.id)).idea).toBeNull();
    expect((await get(inner.id)).idea).toEqual({ root: true, stage: "new" });
    expect((await get(leaf.id)).idea).toEqual({ root: false, rootId: inner.id, rootKey: inner.key });
    expect(res.body.progress).toEqual({ done: 0, total: 1, excluded: 0, ideas: 1 });
  });

  it("aceitar a ideia de dentro de outra ideia não reabre nada e ela continua fora do processo", async () => {
    const p = await add();
    const outer = await idea({ parentId: p.id });
    const inner = await idea({ parentId: outer.id });
    await setStatus(p.id, "done");
    const res = await accept(inner.id);
    expect(res.status).toBe(200);
    expect(res.body.idea).toEqual({ root: false, rootId: outer.id, rootKey: outer.key });
    expect((await get(p.id)).status).toBe("done");
    expect(await autoEvents()).toHaveLength(0);
  });

  it("aceitar refaz toda a cadeia de pais done, de baixo para cima, com um evento por ticket (ADR 0068)", async () => {
    const a = await add();
    const b = await add({ parentId: a.id });
    const i = await idea({ parentId: b.id });
    await setStatus(b.id, "done"); // b só tem a ideia: marcada à mão; a segue b e conclui pela conta
    expect((await get(a.id)).status).toBe("done");
    expect((await accept(i.id)).status).toBe(200);
    expect((await get(a.id)).status).toBe("todo");
    expect((await get(b.id)).status).toBe("todo");
    expect((await autoEvents()).map((e) => e.subject_id)).toEqual([a.id, b.id, a.id]);
  });

  it("ticket comum: 409 ticket_not_idea_root; ideia descartada: 409 idea_discarded", async () => {
    const t = await add();
    expect(code(await accept(t.id))).toBe("ticket_not_idea_root");
    const i = await idea();
    await discard(i.id);
    expect(code(await accept(i.id))).toBe("idea_discarded");
  });

  it("aceitar uma ideia na raiz (sem pai) funciona; filhos cancelados continuam cancelados", async () => {
    const i = await idea();
    const c = await add({ parentId: i.id });
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [c.id]);
    const res = await accept(i.id);
    expect(res.status).toBe(200);
    expect((await get(c.id)).status).toBe("cancelled");
    expect(res.body.progress).toEqual({ done: 0, total: 0, excluded: 1, ideas: 0 });
  });
});

describe("transformar um ticket comum em ideia: POST tickets/:id/idea", () => {
  it("ticket todo sem filhos: vira ideia new; evento idea_registered (transformed)", async () => {
    const t = await add();
    const res = await transform(t.id, "contributor");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toEqual({ root: true, stage: "new" });
    expect((await eventKinds(t.id))[0]).toMatchObject({ kind: "ticket.idea_registered", payload: { key: t.key, source: "transformed" } });
    expect((await activity(t.id))[0]).toMatchObject({ type: "idea_registered" });
  });

  it("os descendentes todo ou cancelled ficam como estão e passam a fazer parte", async () => {
    const t = await add();
    const a = await add({ parentId: t.id });
    const c = await add({ parentId: t.id });
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [c.id]);
    const res = await transform(t.id);
    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 0 });
    expect((await get(a.id)).idea).toEqual({ root: false, rootId: t.id, rootKey: t.key });
    expect((await get(a.id)).status).toBe("todo");
    expect((await get(c.id)).status).toBe("cancelled");
  });

  it.each(["in_progress", "in_review", "done"])("descendente %s: 409 idea_has_work", async (status) => {
    const t = await add();
    const kid = await add({ parentId: t.id });
    const grand = await add({ parentId: kid.id });
    await h.pool.query("update tickets set status = $2 where id = $1", [grand.id, status]);
    const res = await transform(t.id);
    expect(res.status).toBe(409);
    expect(code(res)).toBe("idea_has_work");
    expect((await get(t.id)).idea).toBeNull();
  });

  it.each(["in_progress", "in_review", "done", "cancelled"])("o próprio ticket %s: 409 idea_has_work", async (status) => {
    const t = await add();
    await h.pool.query("update tickets set status = $2 where id = $1", [t.id, status]);
    expect(code(await transform(t.id))).toBe("idea_has_work");
  });

  it("já é raiz de ideia: 409 ticket_already_idea", async () => {
    const i = await idea();
    expect(code(await transform(i.id))).toBe("ticket_already_idea");
  });

  it("um ticket de dentro de uma ideia pode virar uma ideia aninhada", async () => {
    const outer = await idea();
    const kid = await add({ parentId: outer.id });
    const res = await transform(kid.id);
    expect(res.status).toBe(200);
    expect(res.body.idea).toEqual({ root: true, stage: "new" });
  });

  it.each([
    ["admin", 200],
    ["manager", 200],
    ["contributor", 200],
    ["reader", 403],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("papel %s: %i", async (who, expected) => {
    const t = await add();
    expect((await transform(t.id, who)).status).toBe(expected);
  });

  it("projeto arquivado: 409", async () => {
    const t = await add();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(code(await transform(t.id))).toBe("project_archived");
  });
});

describe("regra 5: situação dentro de uma ideia", () => {
  it("mudar a situação da raiz ou de quem está dentro: 409 ticket_in_idea", async () => {
    const i = await idea();
    const kid = await add({ parentId: i.id });
    for (const id of [i.id, kid.id]) {
      for (const status of ["in_progress", "done", "cancelled"]) {
        const res = await patch(id, { status });
        expect(res.status, `${id} ${status}`).toBe(409);
        expect(code(res)).toBe("ticket_in_idea");
      }
    }
    expect((await get(kid.id)).status).toBe("todo");
  });

  it("mandar a mesma situação não é mudança; título, descrição, responsáveis, áreas, comentários e dependências continuam editáveis", async () => {
    const i = await idea();
    const kid = await add({ parentId: i.id });
    const other = await add();
    expect((await patch(kid.id, { status: "todo", title: "Novo", description: "d" })).status).toBe(200);
    expect((await h.call("PUT", `/api/tickets/${kid.id}/assignees/${h.world().people.manager}`, as("admin"))).status).toBe(200);
    expect((await h.call("POST", `/api/tickets/${kid.id}/comments`, as("contributor"), { body: "oi" })).status).toBe(201);
    expect((await h.call("POST", `/api/tickets/${kid.id}/dependencies`, as("admin"), { ticketId: other.id })).status).toBe(200);
    expect((await patch(i.id, { title: "Ideia melhor" })).status).toBe(200);
  });

  it("mudar a situação junto com mover para fora da ideia vale a posição final", async () => {
    const i = await idea();
    const kid = await add({ parentId: i.id });
    const res = await patch(kid.id, { parentId: null, status: "in_progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toBeNull();
    expect(res.body.status).toBe("in_progress");
  });

  it("depois de aceitar, a situação anda", async () => {
    const i = await idea();
    const kid = await add({ parentId: i.id });
    await accept(i.id);
    expect((await patch(kid.id, { status: "in_progress" })).status).toBe(200);
  });
});

describe("mover", () => {
  it("para dentro de uma ideia: ele e os descendentes todo ou cancelled, e passa a fazer parte", async () => {
    const i = await idea();
    const t = await add();
    const kid = await add({ parentId: t.id });
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [kid.id]);
    const res = await patch(t.id, { parentId: i.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
    expect((await get(kid.id)).idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
  });

  it.each(["in_progress", "in_review", "done"])("para dentro com trabalho (%s) no ticket ou num descendente: 409 move_into_idea_blocked", async (status) => {
    const i = await idea();
    const t = await add();
    const kid = await add({ parentId: t.id });
    await h.pool.query("update tickets set status = $2 where id = $1", [kid.id, status]);
    const res = await patch(t.id, { parentId: i.id });
    expect(res.status).toBe(409);
    expect(code(res)).toBe("move_into_idea_blocked");
    const own = await add();
    await h.pool.query("update tickets set status = $2 where id = $1", [own.id, status]);
    expect(code(await patch(own.id, { parentId: i.id }))).toBe("move_into_idea_blocked");
    expect((await get(own.id)).parentId).toBeNull();
  });

  it("para fora de uma ideia devolve ao processo e reabre o pai done de destino", async () => {
    const dest = await add();
    await setStatus(dest.id, "done");
    const i = await idea();
    const kid = await add({ parentId: i.id });
    const res = await patch(kid.id, { parentId: dest.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.idea).toBeNull();
    expect((await get(dest.id)).status).toBe("todo");
    const events = await autoEvents();
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(dest.id);
  });

  it("mover uma raiz de ideia para dentro de um pai done não o reabre", async () => {
    const dest = await add();
    await setStatus(dest.id, "done");
    const i = await idea();
    expect((await patch(i.id, { parentId: dest.id })).status).toBe(200);
    expect((await get(dest.id)).status).toBe("done");
    expect(await autoEvents()).toHaveLength(0);
  });

  it("mover um ticket comum para dentro de uma ideia que está sob um pai done não reabre o pai", async () => {
    const dest = await add();
    const i = await idea({ parentId: dest.id });
    await setStatus(dest.id, "done");
    const t = await add();
    expect((await patch(t.id, { parentId: i.id })).status).toBe(200);
    expect((await get(dest.id)).status).toBe("done");
  });

  it("mover entre duas ideias passa; o ciclo continua recusado", async () => {
    const a = await idea();
    const b = await idea();
    const kid = await add({ parentId: a.id });
    const res = await patch(kid.id, { parentId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.idea).toEqual({ root: false, rootId: b.id, rootKey: b.key });
    const cyc = await patch(b.id, { parentId: kid.id });
    expect(cyc.status).toBe(409);
  });
});

describe("importação por lista", () => {
  const importTo = (body: Body, who: Who = "admin") => h.call("POST", `/api/projects/${priv()}/tickets/import`, as(who), body);

  it("não cria ideias; importar dentro de uma ideia faz parte dela e não reabre o pai done", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    await setStatus(p.id, "done");
    const res = await importTo({ parentId: i.id, items: [{ title: "A", children: [{ title: "B" }] }, { title: "C" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toHaveLength(3);
    for (const row of res.body) expect(row.idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
    expect(res.body[0].progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 0 });
    expect((await get(p.id)).status).toBe("done");
    expect((await h.pool.query("select count(*)::int as n from tickets where idea_stage is not null")).rows[0].n).toBe(1);
  });

  it("dentro de uma ideia, item com situação diferente de todo: 409 ticket_in_idea e nada é criado", async () => {
    const i = await idea();
    const before = (await h.pool.query("select count(*)::int as n from tickets")).rows[0].n;
    const res = await importTo({ parentId: i.id, items: [{ title: "A", status: "done" }] });
    expect(res.status).toBe(409);
    expect(code(res)).toBe("ticket_in_idea");
    expect((await h.pool.query("select count(*)::int as n from tickets")).rows[0].n).toBe(before);
  });

  it("fora de ideia nada muda: itens têm idea null e progresso com ideas 0", async () => {
    const res = await importTo({ items: [{ title: "A", children: [{ title: "B" }] }] });
    expect(res.status).toBe(201);
    expect(res.body[0].idea).toBeNull();
    expect(res.body[0].progress).toEqual({ done: 0, total: 1, excluded: 0, ideas: 0 });
  });
});

describe("leitura: resumo, detalhe e lista de tickets", () => {
  it("o resumo (lista do projeto) traz idea em cada ticket e ideas no progresso do pai", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    const kid = await add({ parentId: i.id });
    const plain = await add({ parentId: p.id });
    const res = await h.call("GET", `/api/projects/${priv()}/tickets`, as("reader"));
    expect(res.status).toBe(200);
    const byId = new Map((res.body as Page[]).map((t) => [t.id, t]));
    expect(byId.get(p.id)?.idea).toBeNull();
    expect(byId.get(p.id)?.progress).toEqual({ done: 0, total: 1, excluded: 0, ideas: 1 });
    expect(byId.get(i.id)?.idea).toEqual({ root: true, stage: "new" });
    expect(byId.get(i.id)?.progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 0 });
    expect(byId.get(kid.id)?.idea).toEqual({ root: false, rootId: i.id, rootKey: i.key });
    expect(byId.get(plain.id)?.idea).toBeNull();
  });

  it("canTriageIdea no detalhe: só para gestor, só em raiz de ideia, falso em projeto arquivado e em ticket comum", async () => {
    const i = await idea();
    const kid = await add({ parentId: i.id });
    const t = await add();
    expect((await get(i.id, "manager")).canTriageIdea).toBe(true);
    expect((await get(i.id, "admin")).canTriageIdea).toBe(true);
    expect((await get(i.id, "contributor")).canTriageIdea).toBe(false);
    expect((await get(i.id, "reader")).canTriageIdea).toBe(false);
    expect((await get(kid.id, "manager")).canTriageIdea).toBe(false);
    expect((await get(t.id, "manager")).canTriageIdea).toBe(false);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await get(i.id, "manager")).canTriageIdea).toBe(false);
  });

  it("projeto sem nenhuma ideia: idea null em todos e ideas 0", async () => {
    const p = await add();
    await add({ parentId: p.id });
    const res = await h.call("GET", `/api/projects/${priv()}/tickets`, as("admin"));
    for (const t of res.body as Page[]) expect(t.idea).toBeNull();
    expect((await get(p.id)).progress).toEqual({ done: 0, total: 1, excluded: 0, ideas: 0 });
  });
});

describe("GET projects/:projectId/ideas", () => {
  it("as raízes, ordenadas por estágio (ready, refining, new, discarded) e depois da mais antiga para a mais nova", async () => {
    const parent = await add({ title: "Pai" });
    const gp = await add({ title: "Avô" });
    const mid = await add({ title: "Meio", parentId: gp.id });
    const a = await idea({ title: "A-new" });
    const b = await idea({ title: "B-ready", parentId: parent.id });
    const c = await idea({ title: "C-new", parentId: mid.id });
    const d = await idea({ title: "D-discarded" });
    const e = await idea({ title: "E-refining" });
    const f = await idea({ title: "F-ready" });
    await stage(b.id, "ready");
    await stage(f.id, "ready");
    await stage(e.id, "refining");
    await discard(d.id);
    await add({ parentId: a.id });
    await h.pool.query("update tickets set created_at = '2026-01-02T00:00:00Z' where id = $1", [a.id]);
    await h.pool.query("update tickets set created_at = '2026-01-01T00:00:00Z' where id = $1", [c.id]);
    await h.pool.query("update tickets set created_at = '2026-01-03T00:00:00Z' where id = $1", [b.id]);
    await h.pool.query("update tickets set created_at = '2026-01-01T12:00:00Z' where id = $1", [f.id]);
    const res = await listIdeas();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { title: string }[]).map((r) => r.title)).toEqual(["F-ready", "B-ready", "E-refining", "C-new", "A-new", "D-discarded"]);
    const row = (res.body as Record<string, unknown>[]).find((r) => r.title === "C-new");
    expect(row).toMatchObject({ id: c.id, key: c.key, number: expect.any(Number), stage: "new", path: ["Avô", "Meio"], createdAt: "2026-01-01T00:00:00.000Z" });
    expect((res.body as Record<string, unknown>[]).find((r) => r.title === "A-new")).toMatchObject({ path: [] });
    expect((res.body as Record<string, unknown>[]).find((r) => r.title === "B-ready")).toMatchObject({ path: ["Pai"] });
  });

  it("só as raízes: o que está dentro de uma ideia não aparece, a ideia de dentro de outra aparece", async () => {
    const outer = await idea({ title: "fora" });
    const kid = await add({ parentId: outer.id, title: "filho" });
    await idea({ parentId: kid.id, title: "dentro" });
    const res = await listIdeas();
    expect((res.body as { title: string; path: string[] }[]).map((r) => [r.title, r.path]).sort()).toEqual([["dentro", ["fora", "filho"]], ["fora", []]]);
  });

  it("projeto sem ideias: lista vazia", async () => {
    await add();
    const res = await listIdeas();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ["admin", 200],
    ["manager", 200],
    ["contributor", 200],
    ["reader", 200],
    ["plain", 404],
    ["outsider", 404],
  ] as const)("papel %s: %i", async (who, expected) => {
    await idea();
    expect((await listIdeas(priv(), who)).status).toBe(expected);
  });

  it("projeto arquivado pode ser lido; ideias de outro projeto não entram", async () => {
    await idea();
    await idea({}, open());
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await listIdeas();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("regra 4: o ticket da vez e o histórico completo", () => {
  it("a atividade do ticket mostra as entradas novas na ordem do mais novo para o mais antigo, com paginação", async () => {
    const i = await idea();
    await stage(i.id, "refining");
    await stage(i.id, "ready");
    await discard(i.id);
    await stage(i.id, "refining");
    await accept(i.id);
    const whole = await activity(i.id);
    expect(whole.map((e) => e.type)).toEqual(["idea_accepted", "idea_reopened", "idea_discarded", "idea_stage_changed", "idea_stage_changed", "idea_registered", "created"]);
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const res = await h.call("GET", `/api/tickets/${i.id}/activity?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`, as("admin"));
      seen.push(...(res.body.entries as { id: string }[]).map((e) => e.id));
      before = res.body.before;
      if (!before) break;
    }
    expect(seen).toEqual(whole.map((e) => e.id as string));
  });
});

describe("contrato que a web supõe (recado da coordenação)", () => {
  it("(1) ticket comum que só tem ideias abaixo devolve progress não nulo, com ideas = n, no detalhe e na lista", async () => {
    const p = await add();
    await idea({ parentId: p.id });
    await idea({ parentId: p.id });
    expect((await get(p.id)).progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 2 });
    const list = await h.call("GET", `/api/projects/${priv()}/tickets`, as("admin"));
    expect((list.body as Page[]).find((t) => t.id === p.id)?.progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 2 });
  });

  it("(2) o 409 de transformar com trabalho em andamento tem o código idea_has_work", async () => {
    const t = await add();
    const kid = await add({ parentId: t.id });
    await h.pool.query("update tickets set status = 'in_progress' where id = $1", [kid.id]);
    const res = await transform(t.id);
    expect(res.status).toBe(409);
    expect(code(res)).toBe("idea_has_work");
  });

  it("(3) a lista de tickets traz sempre a raiz da ideia junto com os tickets de dentro, com idea.rootId apontando para ela", async () => {
    const p = await add();
    const i = await idea({ parentId: p.id });
    const a = await add({ parentId: i.id });
    const b = await add({ parentId: a.id });
    const inner = await idea({ parentId: b.id });
    const c = await add({ parentId: inner.id });
    await discard(i.id);
    const list = (await h.call("GET", `/api/projects/${priv()}/tickets`, as("reader"))).body as Page[];
    const byId = new Map(list.map((t) => [t.id, t]));
    for (const id of [i.id, a.id, b.id, inner.id, c.id]) expect(byId.has(id)).toBe(true);
    for (const id of [a.id, b.id]) expect((byId.get(id)?.idea as { rootId: string }).rootId).toBe(i.id);
    expect((byId.get(c.id)?.idea as { rootId: string }).rootId).toBe(inner.id);
    expect(byId.get(i.id)?.idea).toEqual({ root: true, stage: "discarded" });
  });
});
