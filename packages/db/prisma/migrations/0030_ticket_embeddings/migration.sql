-- Um vetor por ticket para a busca por significado (ADR 0053, fatia 1; TREEPM-129). O vetor vem da Voyage AI (`voyage-4-lite`,
-- 512 dimensões) e é gerado na hora do uso, nunca na escrita do ticket. A tabela guarda, além do vetor, o modelo, as dimensões e o
-- resumo criptográfico (sha256 em hex) do texto que o gerou: trocar de modelo ou de dimensão, ou editar título ou descrição,
-- deixa a linha desatualizada, e quem consulta a põe em dia. Nenhum texto de ticket é guardado aqui: só o resumo e o vetor.
--
-- `vector` é a extensão pgvector. Sem índice aproximado por enquanto: a consulta filtra pelo projeto e ordena pela distância do
-- cosseno, exata (ADR 0053, item 4); um índice entra por medição.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "ticket_embeddings" (
    "org_id" TEXT NOT NULL,
    "ticket_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_embeddings_pkey" PRIMARY KEY ("org_id","ticket_id"),
    CONSTRAINT "ticket_embeddings_dimensions_check" CHECK ("dimensions" > 0),
    CONSTRAINT "ticket_embeddings_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-zA-Z_-]{1,128}$')
);

CREATE INDEX "ticket_embeddings_org_id_project_id_idx" ON "ticket_embeddings"("org_id", "project_id");

ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Apagar o ticket (ou o projeto, que apaga os tickets) apaga o vetor; o projeto da linha é o do ticket.
ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE ticket_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_embeddings
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo para `treepm_app`: cria, lê, apaga, e a substituição (`ON CONFLICT DO UPDATE`) muda só estas colunas.
-- A chave (`org_id`, `ticket_id`) e o projeto nunca mudam.
GRANT SELECT, INSERT, DELETE ON TABLE ticket_embeddings TO treepm_app;
GRANT UPDATE (model, dimensions, content_hash, embedding, updated_at) ON TABLE ticket_embeddings TO treepm_app;
