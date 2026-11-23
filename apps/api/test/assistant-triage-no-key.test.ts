import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0053, fatia 2: sem chave de vetores (ou sem aceite) nenhuma chamada e nenhum vetor lido; a busca é só por palavras.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;

describe("sem VOYAGE_API_KEY", () => {
  it("a procura funciona só com palavras; o provedor de vetores nem existe e a decisão registra no_embedder", async () => {
    await seedTree(h.pool, h.world());
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "oi" })).body.id as string;
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único pela empresa" });
    const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    expect(res.status).toBe(201);
    expect(h.related().calls[0]!.candidates.map((c) => c.title)).toEqual(expect.arrayContaining(["SAML", "Login"]));
    expect(h.embedder().calls).toHaveLength(0);
    const rowsOut = (await h.pool.query("select count(*)::int as n from ticket_embeddings")).rows[0];
    expect(rowsOut.n).toBe(0);
    const read = (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
    expect(read.triage).toMatchObject({ vector: 0, onlyVector: 0, semantic: { failure: "no_embedder" } });
  });
});
