import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0052, item 4: sem prazo para a procura das sugeridas, o desfecho é skipped_no_time (e a sugerida volta como veio).
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300, elaborationMs: 400, suggestedLookupMs: 0 } });

describe("diagnostics sem prazo", () => {
  it("skipped_no_time", async () => {
    await seedTree(h.pool, h.world());
    const id = (await h.call("POST", `/api/projects/${h.world().projects.priv}/ticket-conversations`, as("contributor"), { message: "Quero sincronizar com o Jira" })).body.id as string;
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Sincronizar tickets com o Jira", description: "Receber só o diff" });
    h.elaborator().reply = () => ({ links: [], suggested: [{ title: "Guardar o vínculo externo", description: "d", motivo: "m" }] });
    const res = await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
    expect(res.body.suggested).toHaveLength(1);
    expect(res.body.diagnostics.lookups.map((l: { outcome: string }) => l.outcome)).toEqual(["skipped_no_time"]);
  });
});
