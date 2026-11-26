/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { CATEGORIZE_CONFIG } from "./linear-categorize-support.js";
import { KEY, TEAM_ENG, WORKSPACE, linearImportWorld } from "./linear-support.js";
import type { FakeTeamData } from "./linear-support.js";
import { useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// ADR 0066: o MCP não ganha a opção. `start_linear_sync` abre a sincronização normal; `continue_linear_sync` numa rodada aberta pela tela
// com a opção segue a opção gravada. `fetch` falso: nada chama o Linear.
const h = useMcpHarness(CATEGORIZE_CONFIG);
const priv = () => h.world().projects.priv;
const q = async (sql: string, params: unknown[] = []) => h.rows(sql, params);
const runs = (tail = "") => `/api/projects/${priv()}/linear/runs${tail}`;
const data: FakeTeamData = { projects: [], issues: [{ id: "a", identifier: "ENG-1", title: "Do Linear" }] };

async function linkAndImport(): Promise<void> {
  const base = linearImportWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG] } }, { [TEAM_ENG.id]: data });
  h.linear().use((call) => base(call));
  expect((await h.call("PUT", "/api/linear/connection", as("admin"), { apiKey: KEY })).status).toBe(200);
  expect((await h.call("POST", `/api/projects/${priv()}/linear`, as("admin"), { teamId: TEAM_ENG.id, confirmTeamKey: TEAM_ENG.key })).status).toBe(201);
  const opened = await h.call("POST", runs(), as("admin"), {});
  for (let i = 0, last: any = opened.body; i < 200 && last.done !== true; i += 1) last = (await h.call("POST", runs(`/${opened.body.id}/step`), as("admin"))).body;
}
let token = "";
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
  if (token === "") {
    await h.pool.query("update organizations set mcp_enabled = true, mcp_write_enabled = true where org_id = $1", [ORG]);
    token = (await h.create("admin", priv(), { scope: "write" })).body.token as string;
  }
  h.clock.advance(61_000);
  return h.tool(token, "PRIV", name, args);
}
const ticketA = async () => (await q("select t.id, t.title from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.external_id = 'a'"))[0] as { id: string; title: string };

describe("MCP e a opção de sobrescrever", () => {
  it("`start_linear_sync` abre sem a opção; `continue_linear_sync` numa rodada aberta pela tela com a opção a respeita", async () => {
    token = "";
    await linkAndImport();
    const a = await ticketA();
    expect((await h.call("PATCH", `/api/tickets/${a.id}`, as("admin"), { title: "Daqui" })).status).toBe(200);

    // Pelo MCP: a sincronização normal mantém o título daqui.
    const started = await tool("start_linear_sync");
    expect(started.isError, started.text).toBe(false);
    expect(started.data?.overwrite).toBe(false);
    expect((await q("select overwrite from external_import_runs where id = $1::uuid", [started.data?.id]))[0]).toEqual({ overwrite: false });
    for (let i = 0, last: any = started.data; i < 200 && last.done !== true; i += 1) last = (await tool("continue_linear_sync", { runId: started.data?.id })).data;
    expect((await ticketA()).title).toBe("Daqui");

    // A tela abre com a opção; o MCP recebe a mesma rodada aberta em `start_linear_sync` e a conduz: vale a opção gravada.
    const opened = await h.call("POST", runs(), as("admin"), { overwrite: true });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const again = await tool("start_linear_sync");
    expect(again.isError, again.text).toBe(false);
    expect(again.data?.id).toBe(opened.body.id);
    expect(again.data?.overwrite).toBe(true);
    let last: any = again.data;
    for (let i = 0; i < 200 && last.done !== true; i += 1) last = (await tool("continue_linear_sync", { runId: opened.body.id })).data;
    expect(last.done).toBe(true);
    expect(last.overwrite).toBe(true);
    expect(last.counts).toMatchObject({ overwritten: 1 });
    expect((await ticketA()).title).toBe("Do Linear");
  });

  it("o esquema de saída das duas ferramentas descreve `overwrite` e a entrada de `start_linear_sync` continua sem a opção", async () => {
    const { LINEAR_WRITE_TOOL_DEFINITIONS, startLinearSyncInput } = await import("../src/mcp/mcp-linear-tools.js");
    for (const name of ["start_linear_sync", "continue_linear_sync"] as const) {
      const field = LINEAR_WRITE_TOOL_DEFINITIONS[name].outputSchema.shape.overwrite;
      expect(field, name).toBeDefined();
      expect(field.description).toMatch(/only the TreePM screen/i);
      expect(field.description).toMatch(/changed in TreePM/i);
    }
    expect(Object.keys(startLinearSyncInput.shape)).toEqual([]);
  });
});
