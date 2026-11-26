import { describe, expect, it } from "vitest";
import { WRITE_TOOL_DEFINITIONS } from "../src/mcp/mcp-write-tools.js";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { LINEAR_SENTINELS, seedRelated } from "./related-support.js";
import { ORG } from "./world.js";

// ADR 0061 fatia 3 (TREEPM-478): `get_ticket` mostra "relacionado a" como lista de tickets, nos dois tickets do par, e nada da
// origem no Linear (id da relação, ids das issues, endereço) sai pelo MCP, com ou sem o alcance de pessoas.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const idOf = async (number: number): Promise<string> => (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), number]))[0]?.["id"] as string;

async function seed(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  // PRIV-2 relacionado a PRIV-3 e a PRIV-4: o 2 fica de lados diferentes conforme a ordem dos ids.
  await seedRelated(h.pool, ORG, priv(), await idOf(2), await idOf(3));
  return seedRelated(h.pool, ORG, priv(), await idOf(4), await idOf(2));
}

const keys = (list: { tickets: { key: string }[] }) => list.tickets.map((t) => t.key);

function expectNoLinear(text: string, relationIds: string[]): void {
  for (const banned of [...LINEAR_SENTINELS, ...relationIds]) expect(text, banned).not.toContain(banned);
}

describe("get_ticket: related", () => {
  it("lists the related tickets on both tickets of each pair, as plain ticket summaries, and no Linear origin", async () => {
    const last = await seed();
    const token = (await h.issue("contributor")).token;
    const relationIds = [...(await h.rows("select id from ticket_relations where kind = 'related'")).map((r) => String(r["id"])), last];
    const two = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expect(two.isError).toBe(false);
    const related = two.json?.["relations"].related;
    expect(keys(related)).toEqual(["PRIV-3", "PRIV-4"]);
    expect(related.truncated).toBe(false);
    expect(related.tickets[0]).toEqual({ key: "PRIV-3", title: "Filho B", excerpt: "Segundo filho sobre relatórios", status: "todo", parent: "PRIV-1", idea: null, agentWork: null, priority: 0, effective_priority: 0, dueDate: null, overdue: false });
    expect(keys((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).json?.["relations"].related)).toEqual(["PRIV-2"]);
    expect(keys((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" })).json?.["relations"].related)).toEqual(["PRIV-2"]);
    // A dependência continua separada: `related` não vira `depends_on`.
    expect(keys(two.json?.["relations"].depends_on.incoming)).toEqual(["PRIV-4"]);
    for (const n of [1, 2, 3, 4]) expectNoLinear(JSON.stringify((await h.tool(token, "PRIV", "get_ticket", { key: `PRIV-${n}` })).raw), relationIds);
  });

  it("with the people scope, related tickets carry assignees and still no Linear origin", async () => {
    await seed();
    await h.pool.query("update organizations set mcp_enabled = true, mcp_people_enabled = true where org_id = $1", [ORG]);
    const res = await h.create("contributor", priv(), { scope: "read", people: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const token = res.body.token as string;
    const two = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-2" });
    expect(two.isError, two.text).toBe(false);
    const related = two.json?.["relations"].related;
    expect(keys(related)).toEqual(["PRIV-3", "PRIV-4"]);
    expect(related.tickets[1].assignees).toHaveLength(1);
    const relationIds = (await h.rows("select id from ticket_relations where kind = 'related'")).map((r) => String(r["id"]));
    expectNoLinear(JSON.stringify(two.raw), relationIds);
  });

  it("describes related in the tool description, without making it writable", async () => {
    const token = (await h.issue("contributor")).token;
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string; inputSchema: unknown }[];
    const get = tools.find((t) => t.name === "get_ticket");
    expect(get?.description).toMatch(/`related` means "related to"/);
    for (const name of ["add_dependency", "remove_dependency"] as const) {
      const { description, inputSchema } = WRITE_TOOL_DEFINITIONS[name];
      expect(description, name).not.toContain("related");
      expect(Object.keys(inputSchema.shape), name).not.toContain("kind");
    }
  });
});
