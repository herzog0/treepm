import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0053, fatia 2: sem aceite em vigor, nenhuma chamada ao provedor de vetores e nenhum vetor gravado.
const h = useHarness({ ...AI_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" }, { consent: false });

describe("sem aceite da organização", () => {
  it("a procura é recusada e nenhum vetor é gerado nem lido", async () => {
    await seedTree(h.pool, h.world());
    // A conversa é criada direto no banco: sem aceite nem a rota que abre a conversa chega a um provedor.
    const id = (
      await h.pool.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id, draft_title, draft_description) values ('org_A',$1,$2,'Entrar com SAML','') returning id", [h.world().projects.priv, h.world().people.contributor])
    ).rows[0]!.id;
    const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    expect(res.status).toBe(403);
    expect(h.embedder().calls).toHaveLength(0);
    expect((await h.pool.query("select count(*)::int as n from ticket_embeddings")).rows[0].n).toBe(0);
  });

  it("a elaboração sem aceite devolve consent_required e nenhuma chamada ao provedor de vetores", async () => {
    await seedTree(h.pool, h.world());
    const id = (
      await h.pool.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id, draft_title, draft_description) values ('org_A',$1,$2,'Entrar com SAML','') returning id", [h.world().projects.priv, h.world().people.contributor])
    ).rows[0]!.id;
    const res = await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
    expect(res.body.unavailable).toBe("consent_required");
    expect(h.embedder().calls).toHaveLength(0);
    expect((await h.pool.query("select count(*)::int as n from ticket_embeddings")).rows[0].n).toBe(0);
  });
});
