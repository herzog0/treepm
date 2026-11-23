import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0053: com SEMANTIC_TRIAGE=off (o padrão), mesmo com a chave da Voyage as duas rotas só usam palavras: nada lido, nada sincronizado, nada chamado.
const h = useHarness({ ...AI_CONFIG, VOYAGE_API_KEY: "v-test" }, { timeouts: { relatedMs: 8000, elaborationMs: 3000 } });
const priv = () => h.world().projects.priv;
const embeddingRows = async () => (await h.pool.query("select count(*)::int as n from ticket_embeddings")).rows[0].n as number;
const open = async (title: string, description: string) => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "oi" })).body.id as string;
  await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title, description });
  return id;
};

describe("SEMANTIC_TRIAGE=off (padrão), com VOYAGE_API_KEY presente", () => {
  it("a procura: zero chamadas ao provedor, zero vetores gravados, candidatos só das palavras e o código disabled", async () => {
    await seedTree(h.pool, h.world());
    h.embedder().concepts = { autenticar: "login-unico", federacao: "login-unico", saml: "login-unico" };
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
    const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    expect(res.status).toBe(201);
    expect(h.related().calls[0]!.candidates.map((c) => c.title)).toEqual(expect.arrayContaining(["SAML", "Login"]));
    expect(h.embedder().calls).toHaveLength(0);
    expect(await embeddingRows()).toBe(0);
    const read = (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
    expect(read.triage).toMatchObject({ vector: 0, onlyVector: 0, both: 0, semantic: { failure: "disabled", synced: 0, embedded: 0 } });
  });

  it("a procura devolve os mesmos candidatos que a de palavras sozinha (sem provedor)", async () => {
    await seedTree(h.pool, h.world());
    const id = await open("Autenticar por federacao", "Sem senha propria");
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    // Nada em comum por palavras com a árvore de teste além do que a triagem já acha; o vetor nunca acrescenta candidato.
    const read = (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
    expect(read.triage.onlyVector).toBe(0);
    expect(read.triage.sent).toBe(read.triage.words);
  });

  it("a elaboração: o mesmo, sem provedor nem vetores e com disabled nos diagnósticos", async () => {
    await seedTree(h.pool, h.world());
    h.elaborator().reply = () => ({ links: [], suggested: [{ title: "Manter o vínculo permanente com o sistema de origem", description: "Registrar o identificador externo", motivo: "m" }] });
    h.elaborator().matchReply = () => null;
    const id = await open("Autenticar por federacao", "Sem senha propria");
    const res = await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
    expect(res.status).toBe(201);
    expect(res.body.diagnostics.semantic).toMatchObject({ failure: "disabled", synced: 0, embedded: 0 });
    expect(h.embedder().calls).toHaveLength(0);
    expect(await embeddingRows()).toBe(0);
  });
});
