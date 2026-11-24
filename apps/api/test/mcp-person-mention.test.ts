import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG } from "./world.js";

// ADR 0058: o MCP também não grava menção de pessoa na descrição.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;

describe("create_ticket com elo de pessoa na descrição", () => {
  it("é recusado e nada é gravado", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    await h.enableMcp();
    await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
    const { token } = await h.create("contributor", priv(), { scope: "write" }).then((res) => ({ token: res.body.token as string }));
    const before = Number((await h.rows("select count(*)::int n from tickets where project_id = $1", [priv()]))[0]?.n);
    const res = await h.tool(token, "PRIV", "create_ticket", { title: "Com pessoa", description: `Fale com ${personLink("11111111-1111-4111-8111-111111111111", "Alice")}` });
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toContain("person_mention_not_allowed");
    const link = personLink("11111111-1111-4111-8111-111111111111", "Alice");
    for (const input of [{ title: "T", description: `\`${link}\`` }, { title: "T", description: "> ```\n> " + link + "\n> ```" }, { title: link }, { title: "T", description: link.replace("person:", "PERSON:") }]) {
      const hidden = await h.tool(token, "PRIV", "create_ticket", input);
      expect(hidden.isError, hidden.text).toBe(true);
      expect(hidden.text).toContain("person_mention_not_allowed");
    }
    expect(Number((await h.rows("select count(*)::int n from tickets where project_id = $1", [priv()]))[0]?.n)).toBe(before);
    const ok = await h.tool(token, "PRIV", "create_ticket", { title: "Sem pessoa", description: "Veja #PRIV-1 e @Alice" });
    expect(ok.isError, ok.text).toBe(false);
  });
});
