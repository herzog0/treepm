import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// Prazo do ticket (ADR 0064, TREEPM-467): campo, criação, PATCH, validação, histórico e leituras. O prazo é texto `AAAA-MM-DD` de ponta a
// ponta; a API não devolve "atrasado" para a tela (o "hoje" é o do navegador). Rodar também com TZ=America/Sao_Paulo e TZ=Pacific/Kiritimati.
const h = useHarness();

type Body = Record<string, unknown>;
const P = () => h.world().projects.priv;
const create = async (body: Body = {}, who: Who = "admin"): Promise<Body & { id: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as(who), { title: "Ticket", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body & { id: string };
};
const patch = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `/api/tickets/${id}`, as(who), body);
const detail = async (id: string, who: Who = "admin"): Promise<Body> => (await h.call("GET", `/api/tickets/${id}`, as(who))).body as Body;
const list = async (): Promise<Body[]> => (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as Body[];
const activity = async (id: string): Promise<Body[]> => (await h.call("GET", `/api/tickets/${id}/activity`, as("admin"))).body.entries as Body[];
const stored = async (id: string): Promise<string | null> => (await h.pool.query("select to_char(due_date, 'YYYY-MM-DD') as d from tickets where id = $1", [id])).rows[0].d as string | null;

describe("o campo", () => {
  it("ticket nasce sem prazo; a lista e o detalhe trazem dueDate nulo e nenhum 'overdue'", async () => {
    const t = await create();
    expect(t["dueDate"]).toBeNull();
    const listed = (await list()).find((row) => row["id"] === t.id) as Body;
    expect(listed["dueDate"]).toBeNull();
    expect(listed).not.toHaveProperty("overdue");
    const page = await detail(t.id);
    expect(page["dueDate"]).toBeNull();
    expect(page).not.toHaveProperty("overdue");
  });

  it("criar com prazo grava a data como veio, e as leituras a devolvem igual (sem fuso no caminho)", async () => {
    const t = await create({ dueDate: "2026-12-12" });
    expect(t["dueDate"]).toBe("2026-12-12");
    expect(await stored(t.id)).toBe("2026-12-12");
    expect((await detail(t.id))["dueDate"]).toBe("2026-12-12");
    expect((await list()).find((row) => row["id"] === t.id)?.["dueDate"]).toBe("2026-12-12");
  });

  it("criar com prazo nulo é o mesmo que sem prazo", async () => {
    const t = await create({ dueDate: null });
    expect(t["dueDate"]).toBeNull();
  });

  it("PATCH põe, muda e tira o prazo; as bordas da faixa valem", async () => {
    const t = await create();
    for (const value of ["2026-12-12", "2000-01-01", "2100-12-31", "2024-02-29", null]) {
      const res = await patch(t.id, { dueDate: value });
      expect(res.status, String(value)).toBe(200);
      expect(res.body.dueDate).toBe(value);
      expect(await stored(t.id)).toBe(value);
    }
  });

  it("recusa data que não existe, fora da faixa, com hora, em outro formato e não texto (400 do campo); nada muda", async () => {
    const t = await create({ dueDate: "2026-12-12" });
    for (const value of ["2026-02-30", "2026-13-01", "1999-12-31", "2101-01-01", "2026-12-12T10:00:00Z", "12/12/2026", "", 20261212, true]) {
      const res = await patch(t.id, { dueDate: value });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toMatch(/dueDate/);
    }
    expect((await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "X", dueDate: "2026-02-30" })).status).toBe(400);
    expect(await stored(t.id)).toBe("2026-12-12");
  });

  it("mudar só o prazo vale como um campo do PATCH (sozinho ou junto com outros)", async () => {
    const t = await create();
    const res = await patch(t.id, { dueDate: "2027-01-05", title: "Outro" });
    expect(res.body).toMatchObject({ dueDate: "2027-01-05", title: "Outro" });
  });
});

describe("permissões e estado", () => {
  it("quem pode editar o ticket muda; leitor recebe 403 e vê o prazo", async () => {
    const t = await create();
    expect((await patch(t.id, { dueDate: "2026-12-12" }, "contributor")).status).toBe(200);
    expect((await patch(t.id, { dueDate: null }, "reader")).status).toBe(403);
    expect((await detail(t.id, "reader"))["dueDate"]).toBe("2026-12-12");
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const t = await create();
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    const res = await patch(t.id, { dueDate: "2026-12-12" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });
});

describe("histórico", () => {
  it("grava due_date_changed (de, para) nas três formas: definiu, mudou, tirou", async () => {
    const t = await create();
    await patch(t.id, { dueDate: "2026-12-12" });
    await patch(t.id, { dueDate: "2027-01-05" });
    await patch(t.id, { dueDate: null });
    const entries = (await activity(t.id)).filter((entry) => entry["type"] === "due_date_changed");
    expect(entries.map((entry) => [entry["from"], entry["to"]])).toEqual([
      ["2027-01-05", null],
      ["2026-12-12", "2027-01-05"],
      [null, "2026-12-12"],
    ]);
    expect(entries[0]).toMatchObject({ actor: { id: h.world().people.admin } });
    const events = (await h.pool.query("select payload from activity_events where kind = 'ticket.updated' order by occurred_at, id")).rows;
    expect(events.at(-1)?.payload).toMatchObject({ fields: ["dueDate"], dueDate: { from: "2027-01-05", to: null } });
  });

  it("ticket criado já com prazo: a linha do tempo mostra só 'criado', como o título inicial; o prazo está no evento de criação", async () => {
    const t = await create({ dueDate: "2026-12-12" });
    expect((await activity(t.id)).map((entry) => entry["type"])).toEqual(["created"]);
    const events = (await h.pool.query("select kind, payload from activity_events where subject_id = $1 order by occurred_at, id", [t.id])).rows;
    expect(events.map((event) => event.kind)).toEqual(["ticket.created"]);
    expect(events[0]?.payload).toMatchObject({ dueDate: "2026-12-12" });
  });

  it("não grava nada quando a data é a mesma (nem nulo sobre nulo)", async () => {
    const t = await create({ dueDate: "2026-12-12" });
    const count = async () => (await h.pool.query("select count(*) from activity_events where kind = 'ticket.updated'")).rows[0].count;
    const before = await count();
    expect((await patch(t.id, { dueDate: "2026-12-12" })).status).toBe(200);
    const other = await create();
    expect((await patch(other.id, { dueDate: null })).status).toBe(200);
    expect(await count()).toBe(before);
  });

  it("junto com a prioridade, o prazo vem depois dela (ordem fixa dos campos), do mais novo para o mais antigo", async () => {
    const t = await create();
    await patch(t.id, { priority: 3, dueDate: "2026-12-12" });
    expect((await activity(t.id)).map((entry) => entry["type"])).toEqual(["due_date_changed", "priority_changed", "created"]);
  });

  it("o evento não gera notificação", async () => {
    const t = await create();
    await patch(t.id, { dueDate: "2026-12-12" }, "contributor");
    const notifications = await h.pool.query("select to_regclass('public.notifications') as t");
    if (notifications.rows[0].t !== null) expect((await h.pool.query("select count(*) from notifications")).rows[0].count).toBe("0");
  });
});

describe("mover mantém o prazo", () => {
  it("trocar o pai não mexe no prazo", async () => {
    const parent = await create();
    const t = await create({ dueDate: "2026-12-12" });
    expect((await patch(t.id, { parentId: parent.id })).body.dueDate).toBe("2026-12-12");
  });
});

describe("ligações do detalhe trazem o prazo", () => {
  it("mentionedBy, dependsOn e blocks trazem dueDate como os outros resumos (texto ou nulo), no GET e no PATCH", async () => {
    const a = await create({ dueDate: "2026-12-12" });
    const b = await create({ dueDate: "2027-01-05" });
    const key = (t: Body) => t["key"] as string;
    const c = await create({ description: `Ver ${key(a)} e ${key(b)}.` });
    expect((await h.call("POST", `/api/tickets/${c.id}/dependencies`, as("admin"), { ticketId: a.id })).status).toBe(200);
    const d = await create();
    expect((await h.call("POST", `/api/tickets/${d.id}/dependencies`, as("admin"), { ticketId: c.id })).status).toBe(200);
    const pick = (rows: unknown) => (rows as Body[]).map((row) => [row["id"], row["dueDate"]]);
    expect(pick((await detail(a.id))["mentionedBy"])).toEqual([[c.id, null]]);
    const page = await detail(c.id);
    expect(pick(page["dependsOn"])).toEqual([[a.id, "2026-12-12"]]);
    expect(pick(page["blocks"])).toEqual([[d.id, null]]);
    expect(pick((await detail(b.id))["mentionedBy"])).toEqual([[c.id, null]]);
    expect((await patch(c.id, { dueDate: "2026-12-20" })).status).toBe(200);
    expect(pick((await detail(a.id))["mentionedBy"])).toEqual([[c.id, "2026-12-20"]]);
    const patched = (await patch(d.id, { title: "D" })).body as Body;
    expect(pick(patched["dependsOn"])).toEqual([[c.id, "2026-12-20"]]);
    const changed = (await patch(a.id, { dueDate: null })).body as Body;
    expect(pick(changed["mentionedBy"])).toEqual([[c.id, "2026-12-20"]]);
    expect(pick((await detail(c.id))["dependsOn"])).toEqual([[a.id, null]]);
  });
});
