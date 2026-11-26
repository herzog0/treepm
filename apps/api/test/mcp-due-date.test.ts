/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { isOverdue, utcToday } from "@treepm/domain";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// ADR 0064 (TREEPM-467): as leituras do MCP trazem `dueDate` e `overdue` ("hoje" = o dia em UTC); `update_ticket` e `create_ticket` aceitam
// `dueDate` com o alcance de escrita, pelo mesmo serviço da tela.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const DAY = 86_400_000;

/** O dia UTC a `offset` dias do relógio do teste. */
const day = (offset: number): string => utcToday(h.clock.now() + offset * DAY);
const setDue = (number: number, value: string | null) => h.pool.query("update tickets set due_date = $3::date where project_id = $1 and number = $2", [priv(), number, value]);

async function setup(scope: "read" | "write" = "read"): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  if (scope === "write") await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
  const res = await h.create("contributor", priv(), { scope });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}

describe("dueDate e overdue nas leituras", () => {
  it("get_ticket, path, children, list_tickets, busca, visão geral e fila trazem os dois campos em cada ticket", async () => {
    const token = await setup();
    // PRIV-1 in_progress (pai), PRIV-2 done, PRIV-3 todo, PRIV-4 todo (seedProject).
    await setDue(1, day(-3));
    await setDue(2, day(-3));
    await setDue(3, day(0));
    const one = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    expect(one.json).toMatchObject({ dueDate: day(0), overdue: false });
    expect(one.json?.["path"].map((t: any) => [t.key, t.dueDate, t.overdue])).toEqual([["PRIV-1", day(-3), true]]);
    const parent = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(parent.json).toMatchObject({ dueDate: day(-3), overdue: true });
    expect(parent.json?.["children"].tickets.map((t: any) => [t.key, t.dueDate, t.overdue])).toEqual([
      ["PRIV-2", day(-3), false],
      ["PRIV-3", day(0), false],
    ]);
    const list = await h.tool(token, "PRIV", "list_tickets", {});
    expect(list.json?.["tickets"].map((t: any) => [t.key, t.dueDate, t.overdue])).toEqual([
      ["PRIV-1", day(-3), true],
      ["PRIV-2", day(-3), false],
      ["PRIV-3", day(0), false],
      ["PRIV-4", null, false],
    ]);
    const found = await h.tool(token, "PRIV", "search_tickets", { query: "PRIV-1" });
    expect(found.json?.["tickets"][0]).toMatchObject({ key: "PRIV-1", dueDate: day(-3), overdue: true });
    const overview = await h.tool(token, "PRIV", "get_project_overview");
    expect(overview.json?.["top"].tickets[0]).toMatchObject({ key: "PRIV-1", dueDate: day(-3), overdue: true });
    await setDue(4, day(-1));
    const queue = await h.tool(token, "PRIV", "get_work_queue", {});
    expect(queue.json?.["tickets"].find((t: any) => t.key === "PRIV-4")).toMatchObject({ dueDate: day(-1), overdue: true });
  });

  it("cancelado nunca está atrasado", async () => {
    const token = await setup();
    await setDue(4, day(-10));
    await h.pool.query("update tickets set status = 'cancelled' where project_id = $1 and number = 4", [priv()]);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" })).json).toMatchObject({ dueDate: day(-10), overdue: false });
  });

  it("ideia (a raiz em qualquer estágio, ou um ticket dentro dela) nunca está atrasada", async () => {
    const token = await setup();
    // PRIV-1 (pai de PRIV-2 e PRIV-3) vira a raiz de uma ideia; PRIV-4 fica como ticket comum.
    for (const number of [1, 3, 4]) await setDue(number, day(-5));
    await h.pool.query("update tickets set status = 'todo' where project_id = $1 and number in (1, 3)", [priv()]);
    for (const stage of ["new", "refining", "ready", "discarded"]) {
      await h.pool.query("update tickets set idea_stage = $2 where project_id = $1 and number = 1", [priv(), stage]);
      const list = await h.tool(token, "PRIV", "list_tickets", {});
      const overdue = Object.fromEntries((list.json?.["tickets"] as any[]).map((t) => [t.key, t.overdue]));
      expect(overdue, stage).toMatchObject({ "PRIV-1": false, "PRIV-3": false, "PRIV-4": true });
      expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" })).json, stage).toMatchObject({ dueDate: day(-5), overdue: false });
    }
  });

  it("'hoje' é o dia em UTC: o prazo de hoje fica atrasado só depois da meia-noite UTC", async () => {
    const token = await setup();
    // Leva o relógio a 23:30 UTC do dia corrente.
    const now = h.clock.now();
    const midnight = Math.floor(now / DAY) * DAY;
    h.clock.advance(midnight + DAY - 30 * 60_000 - now);
    const today = utcToday(h.clock.now());
    await setDue(4, today);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" })).json).toMatchObject({ dueDate: today, overdue: false });
    h.clock.advance(60 * 60_000);
    expect(utcToday(h.clock.now())).not.toBe(today);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" })).json).toMatchObject({ dueDate: today, overdue: true });
  });

  it("as descrições das leituras explicam o prazo e o 'hoje' em UTC", async () => {
    const token = await setup();
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string }[];
    for (const name of ["get_ticket", "list_tickets", "search_tickets", "get_work_queue"]) {
      const description = tools.find((t) => t.name === name)?.description ?? "";
      expect(description, name).toMatch(/dueDate/);
      expect(description, name).toMatch(/UTC/);
    }
  });
});

describe("equivalência MCP × tela", () => {
  it("o prazo do MCP é o da página do ticket, e overdue é o domínio aplicado ao dia UTC", async () => {
    const token = await setup();
    const values: (string | null)[] = [day(-400), day(-1), day(0), null];
    for (const [index, value] of values.entries()) await setDue(index + 1, value);
    const list = await h.tool(token, "PRIV", "list_tickets", {});
    for (const t of list.json?.["tickets"] as any[]) {
      const id = (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), Number(t.key.split("-")[1])]))[0]?.id as string;
      const page = (await h.call("GET", `/api/tickets/${id}`, as("contributor"))).body;
      expect(t.dueDate, t.key).toBe(page.dueDate);
      expect(t.overdue, t.key).toBe(isOverdue({ dueDate: page.dueDate, category: page.status, today: utcToday(h.clock.now()), idea: page.idea != null }));
    }
  });
});

describe("escrita", () => {
  it("update_ticket põe, muda e tira o prazo, com evento pelo MCP; a mesma data não grava nada", async () => {
    const token = await setup("write");
    const set = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: "2026-12-12" });
    expect(set.isError, set.text).toBe(false);
    expect(set.json).toMatchObject({ key: "PRIV-3", dueDate: "2026-12-12" });
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: "2027-01-05", title: "Filho B renomeado" })).json).toMatchObject({ dueDate: "2027-01-05", title: "Filho B renomeado" });
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: null })).json).toMatchObject({ dueDate: null, overdue: false });
    const before = (await h.rows("select count(*)::int as n from activity_events where kind = 'ticket.updated'"))[0]?.["n"];
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: null });
    expect((await h.rows("select count(*)::int as n from activity_events where kind = 'ticket.updated'"))[0]?.["n"]).toBe(before);
    const events = await h.rows("select payload from activity_events where kind = 'ticket.updated' and payload ? 'dueDate' order by occurred_at, id");
    expect(events.map((e: any) => [e.payload.dueDate.from, e.payload.dueDate.to, e.payload.via])).toEqual([
      [null, "2026-12-12", "mcp"],
      ["2026-12-12", "2027-01-05", "mcp"],
      ["2027-01-05", null, "mcp"],
    ]);
  });

  it("update_ticket recusa data inválida e não muda nada", async () => {
    const token = await setup("write");
    await setDue(3, "2026-12-12");
    for (const value of ["2026-02-30", "2101-01-01", "12/12/2026", 20261212]) {
      const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: value });
      expect(res.status !== 200 || res.isError || res.raw["error"] !== undefined, JSON.stringify(value)).toBe(true);
      // Em inglês, como os outros campos do MCP; a mensagem em português é a da tela e da API.
      if (typeof value === "string") {
        expect(res.text, JSON.stringify(value)).toMatch(/dueDate must be a calendar day YYYY-MM-DD/);
        expect(res.text, JSON.stringify(value)).not.toMatch(/Data AAAA-MM-DD/);
      }
    }
    expect((await h.rows("select to_char(due_date, 'YYYY-MM-DD') as d from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["d"]).toBe("2026-12-12");
  });

  it("update_ticket sem nenhum campo continua recusado", async () => {
    const token = await setup("write");
    const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3" });
    expect(res.isError).toBe(true);
  });

  it("create_ticket aceita dueDate; a repetição com o mesmo requestId e outro prazo é recusada", async () => {
    const token = await setup("write");
    const res = await h.tool(token, "PRIV", "create_ticket", { title: "Com prazo", dueDate: "2026-12-12", requestId: "pedido-prazo-1" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json?.["ticket"]).toMatchObject({ dueDate: "2026-12-12", overdue: false });
    const again = await h.tool(token, "PRIV", "create_ticket", { title: "Com prazo", dueDate: "2026-12-13", requestId: "pedido-prazo-1" });
    expect(again.isError).toBe(true);
  });

  it("token de leitura não muda o prazo", async () => {
    const token = await setup("read");
    const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", dueDate: "2026-12-12" });
    expect(res.status !== 200 || res.isError || res.raw["error"] !== undefined).toBe(true);
    expect((await h.rows("select due_date from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["due_date"]).toBeNull();
  });

  it("a descrição de update_ticket e de create_ticket fala do prazo", async () => {
    const token = await setup("write");
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string; inputSchema: any }[];
    for (const name of ["update_ticket", "create_ticket"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/due date/i);
      expect(Object.keys(tool?.inputSchema.properties ?? {}), name).toContain("dueDate");
    }
  });
});
