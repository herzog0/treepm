import { describe, expect, it, vi } from "vitest";
import { effectivePriorities } from "@treepm/domain";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// Prioridade do ticket (ADR 0047, TREEPM-221): campo, PATCH, histórico, herança no detalhe e o lugar na fila (ADR 0068) no resumo.
const h = useHarness();

type Body = Record<string, unknown>;
const P = () => h.world().projects.priv;
const create = async (body: Body = {}, who: Who = "admin"): Promise<Body & { id: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as(who), { title: "Ticket", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body & { id: string };
};
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const list = async (): Promise<Body[]> => (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as Body[];
const activity = async (id: string): Promise<Body[]> => (await h.call("GET", `/api/tickets/${id}/activity`, as("admin"))).body.entries as Body[];

describe("o campo", () => {
  it("ticket nasce com prioridade 0; a lista e o detalhe trazem o número", async () => {
    const t = await create();
    expect(t["priority"]).toBe(0);
    expect((await list())[0]).toMatchObject({ priority: 0, blocked: false });
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("admin"))).body).toMatchObject({ priority: 0, effectivePriority: { value: 0, from: null } });
  });

  it("PATCH muda a prioridade (positiva, negativa e zero) e devolve a página do ticket", async () => {
    const t = await create();
    for (const value of [5, -3, 999, -999, 0]) {
      const res = await patch(t.id, { priority: value });
      expect(res.status, String(value)).toBe(200);
      expect(res.body.priority).toBe(value);
    }
    expect((await list())[0]?.["priority"]).toBe(0);
  });

  it("recusa fora do intervalo, fracionário e não numérico (400, com a mensagem do campo)", async () => {
    const t = await create();
    for (const value of [1000, -1000, 1.5, "5", null, Number.NaN]) {
      const res = await patch(t.id, { priority: value });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
    expect((await patch(t.id, { priority: 1000 })).body.error.message).toMatch(/priority/i);
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("admin"))).body.priority).toBe(0);
  });

  it("mudar só a prioridade vale como um campo do PATCH (sozinho ou junto com os outros)", async () => {
    const t = await create();
    const res = await patch(t.id, { priority: 4, title: "Outro" });
    expect(res.body).toMatchObject({ priority: 4, title: "Outro" });
  });
});

describe("permissões e estado", () => {
  it("quem pode editar o ticket muda; leitor recebe 403", async () => {
    const t = await create();
    expect((await patch(t.id, { priority: 2 }, "contributor")).status).toBe(200);
    expect((await patch(t.id, { priority: 3 }, "reader")).status).toBe(403);
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("reader"))).body.priority).toBe(2);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const t = await create();
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    const res = await patch(t.id, { priority: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });
});

describe("histórico e updated_at", () => {
  it("grava priority_changed (de, para) na atividade, na ordem certa entre os campos", async () => {
    const t = await create();
    await patch(t.id, { priority: 5 });
    await patch(t.id, { priority: -2 });
    const entries = (await activity(t.id)).filter((entry) => entry["type"] === "priority_changed");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "priority_changed", from: 5, to: -2, actor: { id: h.world().people.admin } });
    expect(entries[1]).toMatchObject({ from: 0, to: 5 });
    const events = (await h.pool.query("select payload from activity_events where kind = 'ticket.updated' order by occurred_at, id")).rows;
    expect(events.at(-1)?.payload).toMatchObject({ fields: ["priority"], priority: { from: 5, to: -2 } });
  });

  it("não grava nada quando o número é o mesmo", async () => {
    const t = await create();
    const before = (await h.pool.query("select count(*) from activity_events where kind = 'ticket.updated'")).rows[0].count;
    expect((await patch(t.id, { priority: 0 })).status).toBe(200);
    expect((await h.pool.query("select count(*) from activity_events where kind = 'ticket.updated'")).rows[0].count).toBe(before);
  });

  it("muda o updated_at do ticket", async () => {
    const t = await create();
    const read = async () => (await h.pool.query("select updated_at from tickets where id = $1", [t.id])).rows[0].updated_at as Date;
    const before = await read();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await patch(t.id, { priority: 9 });
    expect((await read()).getTime()).toBeGreaterThan(before.getTime());
  });

  it("junto com título e situação, as entradas vêm do mais novo para o mais antigo", async () => {
    const t = await create();
    await patch(t.id, { title: "Novo", priority: 3, status: "in_progress" });
    const types = (await activity(t.id)).map((entry) => entry["type"]);
    expect(types).toEqual(["priority_changed", "status_changed", "title_changed", "created"]);
  });
});

describe("prioridade que vale (detalhe)", () => {
  it("própria diferente de 0: vale ela, de si mesma", async () => {
    const t = await create({ });
    await patch(t.id, { priority: 4 });
    const page = (await h.call("GET", `/api/tickets/${t.id}`, as("admin"))).body;
    expect(page.effectivePriority).toEqual({ value: 4, from: { id: t.id, key: t["key"] } });
  });

  it("0 herda do ancestral mais próximo diferente de 0, em vários níveis, e diz de qual ticket", async () => {
    const a = await create();
    const b = await create({ parentId: a.id });
    const c = await create({ parentId: b.id });
    const d = await create({ parentId: c.id });
    await patch(a.id, { priority: 7 });
    expect((await h.call("GET", `/api/tickets/${d.id}`, as("admin"))).body).toMatchObject({ priority: 0, effectivePriority: { value: 7, from: { id: a.id, key: a["key"] } } });
    await patch(c.id, { priority: -1 });
    expect((await h.call("GET", `/api/tickets/${d.id}`, as("admin"))).body.effectivePriority).toEqual({ value: -1, from: { id: c.id, key: c["key"] } });
    expect((await h.call("GET", `/api/tickets/${b.id}`, as("admin"))).body.effectivePriority).toEqual({ value: 7, from: { id: a.id, key: a["key"] } });
  });

  it("a página devolvida pelo PATCH já traz a prioridade que vale", async () => {
    const a = await create();
    const b = await create({ parentId: a.id });
    const res = await patch(a.id, { priority: 3 });
    expect(res.body.effectivePriority).toMatchObject({ value: 3 });
    expect((await h.call("GET", `/api/tickets/${b.id}`, as("admin"))).body.effectivePriority.value).toBe(3);
  });
});

describe("lugar na fila (ADR 0068) no resumo: a dependência aberta não bloqueia, faz esperar", () => {
  const link = (from: string, to: string) => h.call("POST", `/api/tickets/${from}/dependencies`, as("admin"), { ticketId: to });

  it("é 'próximo' enquanto algum ticket de que depende está aberto; 'livre' quando todos terminaram; nunca 'bloqueado'", async () => {
    const a = await create();
    const b = await create();
    const c = await create();
    expect((await link(a.id, b.id)).status).toBe(200);
    expect((await link(a.id, c.id)).status).toBe(200);
    const summary = async (id: string) => (await list()).find((entry) => entry["id"] === id);
    expect(await summary(a.id)).toMatchObject({ place: "next", blocked: false });
    expect(await summary(b.id)).toMatchObject({ place: "free" });
    await patch(b.id, { status: "done" });
    expect((await summary(a.id))?.["place"]).toBe("next");
    await patch(c.id, { status: "cancelled" });
    expect((await summary(a.id))?.["place"]).toBe("free");
    await patch(c.id, { status: "todo" });
    expect((await summary(a.id))?.["place"]).toBe("next");
    expect((await h.call("GET", `/api/tickets/${a.id}`, as("admin"))).body).toMatchObject({ place: "next", blocked: false });
  });

  it("'menciona' não faz esperar: só 'depende de'", async () => {
    const a = await create();
    const b = await create();
    await patch(a.id, { description: `veja ${b["key"]}` });
    expect((await list()).find((entry) => entry["id"] === a.id)?.["place"]).toBe("free");
  });
});

describe("não é mudança de estrutura (ADR 0045)", () => {
  it("só a prioridade não pega a trava de estrutura do projeto; mudar o pai pega", async () => {
    const t = await create();
    const parent = await create();
    const lock = vi.spyOn(h.app().get(TicketsService), "lockStructure");
    try {
      expect((await patch(t.id, { priority: 1 })).status).toBe(200);
      expect(lock).not.toHaveBeenCalled();
      expect((await patch(t.id, { parentId: parent.id })).status).toBe(200);
      expect(lock).toHaveBeenCalledTimes(1);
    } finally {
      lock.mockRestore();
    }
  });
});

describe("o SQL do detalhe e o domínio da lista concordam (árvore gerada)", () => {
  it("a prioridade que vale do detalhe é a de effectivePriorities sobre a lista, em cada ticket", async () => {
    let seed = 2026;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const made: (Body & { id: string })[] = [];
    for (let i = 0; i < 24; i += 1) {
      const parent = i === 0 || rand() < 0.15 ? null : made[Math.floor(rand() * made.length)];
      const t = await create(parent ? { parentId: parent.id } : {});
      if (rand() < 0.45) await patch(t.id, { priority: Math.floor(rand() * 21) - 10 || 3 });
      made.push(t);
    }
    const rows = (await list()) as unknown as { id: string; parentId: string | null; priority: number }[];
    const expected = effectivePriorities(rows);
    for (const row of rows) {
      const page = (await h.call("GET", `/api/tickets/${row.id}`, as("admin"))).body;
      const want = expected.get(row.id);
      expect(page.effectivePriority.value, row.id).toBe(want?.value);
      expect(page.effectivePriority.from?.id ?? null, row.id).toBe(want?.fromId);
    }
  });
});
