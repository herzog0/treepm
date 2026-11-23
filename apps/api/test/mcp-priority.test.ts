/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";

// ADR 0047: as leituras do MCP trazem a prioridade própria e a que vale; nenhuma ferramenta de escrita nova.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;

async function setup(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  // PRIV-1 é o pai de PRIV-2 e PRIV-3 (ver seedProject); a prioridade 6 no pai vale para os filhos com 0.
  await h.pool.query("update tickets set priority = 6 where project_id = $1 and number = 1", [priv()]);
  await h.pool.query("update tickets set priority = -2 where project_id = $1 and number = 3", [priv()]);
  return (await h.issue("contributor")).token;
}

describe("priority nas ferramentas de leitura do MCP", () => {
  it("get_ticket, list_tickets e a busca trazem a prioridade própria e a que vale, em cada ticket", async () => {
    const token = await setup();
    const one = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expect(one.json).toMatchObject({ priority: 0, effective_priority: 6 });
    expect(one.json?.["path"].map((t: any) => [t.key, t.priority, t.effective_priority])).toEqual([["PRIV-1", 6, 6]]);
    const list = await h.tool(token, "PRIV", "list_tickets", {});
    expect(list.json?.["tickets"].map((t: any) => [t.key, t.priority, t.effective_priority])).toEqual([
      ["PRIV-1", 6, 6],
      ["PRIV-2", 0, 6],
      ["PRIV-3", -2, -2],
      ["PRIV-4", 0, 0],
    ]);
    const found = await h.tool(token, "PRIV", "search_tickets", { query: "PRIV-3" });
    expect(found.json?.["tickets"][0]).toMatchObject({ key: "PRIV-3", priority: -2, effective_priority: -2 });
  });

  it("a visão geral traz a prioridade dos tickets do topo; os filhos que vêm no get_ticket também", async () => {
    const token = await setup();
    const overview = await h.tool(token, "PRIV", "get_project_overview");
    expect(overview.json?.["top"].tickets[0]).toMatchObject({ key: "PRIV-1", priority: 6, effective_priority: 6 });
    const parent = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(parent.json?.["children"].tickets.map((t: any) => [t.key, t.priority, t.effective_priority])).toEqual([["PRIV-2", 0, 6], ["PRIV-3", -2, -2]]);
  });

  it("não há ferramenta de escrita de prioridade, e a descrição das leituras explica o número", async () => {
    const token = await setup();
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string }[];
    expect(tools.map((t) => t.name).filter((name) => /priority/i.test(name))).toEqual([]);
    expect(tools.filter((t) => ["get_ticket", "list_tickets", "search_tickets", "get_project_overview"].includes(t.name)).every((t) => /priority/i.test(t.description))).toBe(true);
  });
});
