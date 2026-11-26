/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";

// ADR 0043, parte 4 (ADR 0042, fatia 5): `idea` em cada ticket lido pelo MCP e o resumo do projeto com as ideias à parte.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;

async function setup(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  // PRIV-1 vira a raiz de uma ideia (PRIV-2 e PRIV-3 ficam dentro); PRIV-2 volta para a fazer (regra da ideia).
  await h.pool.query("update tickets set status = 'todo' where project_id = $1 and number in (1, 2)", [priv()]);
  await h.pool.query("update tickets set idea_stage = 'refining' where project_id = $1 and number = 1", [priv()]);
  return (await h.issue("contributor")).token;
}

describe("idea nas ferramentas de leitura do MCP", () => {
  it("a raiz diz o estágio, quem está dentro diz a chave da raiz, ticket comum é null", async () => {
    const token = await setup();
    const root = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    const inside = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    const plain = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" });
    expect(root.json?.["idea"]).toEqual({ kind: "root", stage: "refining" });
    expect(inside.json?.["idea"]).toEqual({ kind: "inside", root: "PRIV-1" });
    expect(plain.json?.["idea"]).toBeNull();
    expect(root.json?.["children"].tickets.map((t: any) => t.idea)).toEqual([{ kind: "inside", root: "PRIV-1" }, { kind: "inside", root: "PRIV-1" }]);
    const list = await h.tool(token, "PRIV", "list_tickets", {});
    expect(list.json?.["tickets"].map((t: any) => t.idea?.kind ?? null)).toEqual(["root", "inside", "inside", null]);
  });

  it("o resumo conta por situação só o que é trabalho e traz as ideias à parte", async () => {
    const token = await setup();
    const overview = await h.tool(token, "PRIV", "get_project_overview");
    expect(overview.json).toMatchObject({ total: 1, by_status: { todo: 1, in_progress: 0, in_review: 0, done: 0, cancelled: 0 }, ideas: { new: 0, refining: 1, ready: 0, discarded: 0 } });
  });

  it("a descrição das ferramentas explica o que é uma ideia", async () => {
    const token = await setup();
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string }[];
    // Toda ferramenta que devolve tickets; `list_labels` (ADR 0065) devolve só as etiquetas do projeto, sem ticket.
    const ticketTools = tools.filter((t) => t.name !== "list_labels");
    expect(ticketTools.map((t) => t.name).sort()).toEqual(["get_project_overview", "get_ticket", "get_work_queue", "list_tickets", "search_tickets"]);
    expect(ticketTools.every((t) => /idea is not accepted work yet/i.test(t.description))).toBe(true);
  });
});
