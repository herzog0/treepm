import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0053: SEMANTIC_TRIAGE=interleave e SEMANTIC_QUERY_KIND=document valem nas duas rotas.
const h = useHarness({ ...AI_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "interleave", SEMANTIC_QUERY_KIND: "document" }, { timeouts: { relatedMs: 8000, elaborationMs: 3000 } });
const priv = () => h.world().projects.priv;
const open = async (title: string, description: string) => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "oi" })).body.id as string;
  await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title, description });
  return id;
};

describe("SEMANTIC_TRIAGE=interleave com SEMANTIC_QUERY_KIND=document", () => {
  it("a procura usa a intercalação e consulta como `document`", async () => {
    await seedTree(h.pool, h.world());
    h.embedder().concepts = { autenticar: "login-unico", federacao: "login-unico", saml: "login-unico" };
    const id = await open("Autenticar por federacao", "Sem senha propria");
    const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    expect(res.status).toBe(201);
    expect(h.embedder().calls.every((call) => call.kind === "document")).toBe(true);
    expect(h.embedder().calls.some((call) => call.texts.includes("Autenticar por federacao\n\nSem senha propria"))).toBe(true);
    expect(h.related().calls[0]!.candidates.map((c) => c.title)).toContain("SAML");
    const read = (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
    expect(read.triage.semantic.failure).toBeUndefined();
  });

  it("a elaboração também consulta como `document`", async () => {
    await seedTree(h.pool, h.world());
    h.elaborator().reply = () => ({ links: [], suggested: [{ title: "Manter o vínculo permanente", description: "Registrar o identificador externo", motivo: "m" }] });
    h.elaborator().matchReply = () => null;
    const id = await open("Autenticar por federacao", "Sem senha propria");
    const res = await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
    expect(res.status).toBe(201);
    expect(h.embedder().calls.length).toBeGreaterThan(0);
    expect(h.embedder().calls.every((call) => call.kind === "document")).toBe(true);
  });
});
