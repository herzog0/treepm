-- Conversa de novo ticket com a IA e resumos de ramo (ADR 0029).

-- CreateTable
CREATE TABLE "ticket_conversations" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "author_person_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "draft_title" TEXT,
    "draft_description" TEXT,
    -- A IA considera o rascunho pronto para procurar o lugar (último turno).
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "created_ticket_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_conversations_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_conversations_status_check" CHECK ("status" IN ('open', 'ticket_created', 'discarded')),
    -- Rascunho completo ou ausente, com os limites do ticket (0004).
    CONSTRAINT "ticket_conversations_draft_check" CHECK (
        ("draft_title" IS NULL AND "draft_description" IS NULL)
        OR (
            "draft_title" IS NOT NULL AND "draft_description" IS NOT NULL
            AND char_length(btrim("draft_title")) BETWEEN 1 AND 200
            AND char_length("draft_description") <= 20000
        )
    )
);

-- CreateTable
CREATE TABLE "ticket_conversation_messages" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "conversation_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- Modelo que produziu a resposta (só mensagens do assistente).
    "model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_conversation_messages_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_conversation_messages_author_check" CHECK ("author" IN ('person', 'assistant')),
    CONSTRAINT "ticket_conversation_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 20000),
    CONSTRAINT "ticket_conversation_messages_position_check" CHECK ("position" >= 1)
);

-- CreateTable
CREATE TABLE "branch_summaries" (
    "org_id" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "content_mark" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_summaries_pkey" PRIMARY KEY ("org_id","ticket_id"),
    CONSTRAINT "branch_summaries_summary_check" CHECK (char_length("summary") BETWEEN 1 AND 600)
);

-- CreateIndex
CREATE INDEX "ticket_conversations_org_id_project_id_author_person_id_upd_idx" ON "ticket_conversations"("org_id", "project_id", "author_person_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_conversations_org_id_author_person_id_idx" ON "ticket_conversations"("org_id", "author_person_id");

-- Um ticket nasce de no máximo uma conversa (a criação idempotente se apoia nisto).
CREATE UNIQUE INDEX "ticket_conversations_org_id_created_ticket_id_key" ON "ticket_conversations"("org_id", "created_ticket_id") WHERE "created_ticket_id" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ticket_conversation_messages_org_id_conversation_id_positio_key" ON "ticket_conversation_messages"("org_id", "conversation_id", "position");

-- CreateIndex
CREATE INDEX "branch_summaries_org_id_project_id_idx" ON "branch_summaries"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "ticket_conversations" ADD CONSTRAINT "ticket_conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_conversations" ADD CONSTRAINT "ticket_conversations_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_conversations" ADD CONSTRAINT "ticket_conversations_org_id_author_person_id_fkey" FOREIGN KEY ("org_id", "author_person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (o ticket criado é do projeto da conversa; remover o ticket só desfaz a referência.
-- A lista de colunas em SET NULL exige PostgreSQL 15+; o Prisma não a modela, então a ação vive só aqui.)
ALTER TABLE "ticket_conversations" ADD CONSTRAINT "ticket_conversations_org_id_project_id_created_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "created_ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE SET NULL ("created_ticket_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_conversation_messages" ADD CONSTRAINT "ticket_conversation_messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_conversation_messages" ADD CONSTRAINT "ticket_conversation_messages_org_id_conversation_id_fkey" FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ticket_conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (o ticket é do projeto informado; remover o ticket remove o resumo)
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE ticket_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_conversations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_conversation_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_conversation_messages
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE branch_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_summaries
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ticket_conversations, ticket_conversation_messages, branch_summaries TO treepm_app;
