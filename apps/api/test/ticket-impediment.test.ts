import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0068, seção 5: bloqueado é um impedimento que alguém marca, com o motivo; concluir ou cancelar limpa.
const h = useHarness();
const P = () => h.world().projects.priv;
type Body = Record<string, unknown>;
type Impediment = { reason: string; by: { id: string; displayName: string }; at: string } | null;
type Detail = { id: string; status: string; blocked: boolean; impediment: Impediment };

const add = async (body: Body = {}): Promise<{ id: string; key: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; key: string };
};
const mark = (id: string, reason: unknown, who: Who = "admin") => h.call("PUT", `/api/tickets/${id}/impediment`, as(who), { reason });
const clear = (id: string, who: Who = "admin") => h.call("DELETE", `/api/tickets/${id}/impediment`, as(who));
const patch = (id: string, body: Body) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), body);
const detail = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body as Detail;
const listed = async (id: string) => ((await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as Detail[]).find((ticket) => ticket.id === id);
const events = async (kind: string) => (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;
const activity = async (id: string) => ((await h.call("GET", `/api/tickets/${id}/activity`, as("admin"))).body as { entries: Body[] }).entries;

describe("marcar e limpar", () => {
  it("marcar deixa o ticket bloqueado, com o motivo, quem e quando no detalhe; a lista só diz que está bloqueado", async () => {
    const a = await add();
    const res = await mark(a.id, "  Falta a chave do fornecedor  ");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Detail;
    expect(body.blocked).toBe(true);
    expect(body.impediment).toMatchObject({ reason: "Falta a chave do fornecedor", by: { id: h.world().people.admin } });
    expect(Date.parse(body.impediment?.at ?? "")).not.toBeNaN();
    expect(await detail(a.id)).toMatchObject({ blocked: true, impediment: { reason: "Falta a chave do fornecedor" } });
    const summary = await listed(a.id);
    expect(summary?.blocked).toBe(true);
    expect(summary).not.toHaveProperty("impediment");
  });

  it("limpar tira o bloqueio; limpar sem impedimento não muda nada", async () => {
    const a = await add();
    await mark(a.id, "motivo");
    const res = await clear(a.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blocked: false, impediment: null });
    expect((await listed(a.id))?.blocked).toBe(false);
    expect((await clear(a.id)).status).toBe(200);
    expect(await events("ticket.impediment_cleared")).toHaveLength(1);
  });

  it("marcar e limpar entram na linha do tempo; o evento não guarda o motivo", async () => {
    const a = await add();
    await mark(a.id, "segredo do motivo");
    await mark(a.id, "segredo do motivo");
    await mark(a.id, "outro motivo");
    await clear(a.id);
    const marked = await events("ticket.impediment_marked");
    expect(marked).toHaveLength(2);
    expect(marked[0]).toMatchObject({ subject_type: "ticket", subject_id: a.id, actor_person_id: h.world().people.admin });
    expect(marked[0].payload).toEqual({ key: "PRIV-1" });
    expect((await events("ticket.impediment_cleared"))[0].payload).toEqual({ key: "PRIV-1" });
    const types = (await activity(a.id)).map((entry) => entry["type"]);
    expect(types.filter((type) => type === "impediment_marked")).toHaveLength(2);
    expect(types).toContain("impediment_cleared");
  });

  it("vale para ticket com filhos", async () => {
    const parent = await add();
    await add({ parentId: parent.id });
    expect((await mark(parent.id, "motivo")).status).toBe(200);
    expect((await listed(parent.id))?.blocked).toBe(true);
  });
});

describe("concluir ou cancelar limpa", () => {
  it.each(["done", "cancelled"])("%s limpa o impedimento, com o evento automático", async (status) => {
    const a = await add();
    await mark(a.id, "motivo");
    expect((await patch(a.id, { status })).status).toBe(200);
    expect(await detail(a.id)).toMatchObject({ blocked: false, impediment: null });
    expect((await h.pool.query("select impediment_reason from tickets where id = $1", [a.id])).rows[0].impediment_reason).toBeNull();
    const [event] = await events("ticket.impediment_cleared");
    expect(event.payload).toEqual({ key: "PRIV-1", automatic: true, cause: "finished" });
    const cleared = (await activity(a.id)).find((entry) => entry["type"] === "impediment_cleared");
    expect(cleared).toMatchObject({ automatic: true });
  });

  it("mudar para em andamento não limpa", async () => {
    const a = await add();
    await mark(a.id, "motivo");
    await patch(a.id, { status: "in_progress" });
    expect((await detail(a.id)).blocked).toBe(true);
  });
});

describe("pai concluído pela conta dos filhos (ADR 0068, seções 2 e 5)", () => {
  it.each(["done", "cancelled"])("o último filho aberto vai a %s: o pai acaba e o impedimento sai (evento automático); reabrir o filho não traz o motivo de volta", async (status) => {
    const parent = await add();
    const a = await add({ parentId: parent.id });
    const b = await add({ parentId: parent.id });
    expect((await patch(b.id, { status })).status).toBe(200);
    expect((await mark(parent.id, "Esperando o jurídico")).status).toBe(200);
    expect((await patch(a.id, { status })).status).toBe(200);
    const finished = await detail(parent.id);
    expect(finished).toMatchObject({ status, blocked: false, impediment: null });
    expect((await h.pool.query("select impediment_reason, impediment_person_id, impediment_at from tickets where id = $1", [parent.id])).rows[0]).toEqual({ impediment_reason: null, impediment_person_id: null, impediment_at: null });
    const [event] = (await events("ticket.impediment_cleared")).filter((row) => row.subject_id === parent.id);
    expect(event?.payload).toMatchObject({ key: "PRIV-1", automatic: true, cause: "finished" });

    expect((await patch(a.id, { status: "todo" })).status).toBe(200);
    const reopened = await detail(parent.id);
    expect(reopened.status).not.toBe(status);
    expect(reopened).toMatchObject({ blocked: false, impediment: null });
    expect((await listed(parent.id))?.blocked).toBe(false);
  });
});

describe("recusas", () => {
  it("motivo vazio, longo demais ou com menção a pessoa: 400 ou 422", async () => {
    const a = await add();
    expect((await mark(a.id, "   ")).status).toBe(400);
    expect((await mark(a.id, "x".repeat(1001))).status).toBe(400);
    expect((await mark(a.id, 42)).status).toBe(400);
    expect((await h.call("PUT", `/api/tickets/${a.id}/impediment`, as("admin"), { reason: "ok", extra: 1 })).status).toBe(400);
    expect((await mark(a.id, "x".repeat(1000))).status).toBe(200);
  });

  it("ticket concluído ou cancelado: 409 ticket_finished", async () => {
    const a = await add();
    await patch(a.id, { status: "done" });
    const res = await mark(a.id, "motivo");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_finished");
  });

  it("leitor: 403; contribuidor pode; quem não vê o projeto: 404", async () => {
    const a = await add();
    expect((await mark(a.id, "motivo", "reader")).status).toBe(403);
    expect((await clear(a.id, "reader")).status).toBe(403);
    expect((await mark(a.id, "motivo", "contributor")).status).toBe(200);
    expect((await clear(a.id, "contributor")).status).toBe(200);
    expect((await mark(a.id, "motivo", "plain")).status).toBe(404);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const a = await add();
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    const res = await mark(a.id, "motivo");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });
});
