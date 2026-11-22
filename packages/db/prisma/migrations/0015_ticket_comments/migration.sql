-- Comentários do ticket (ADR 0040, fatia 2). O corpo é markdown; ao remover, o corpo é apagado na mesma gravação
-- (o banco garante: removido implica corpo vazio, e não removido implica corpo de 1 a 10.000 caracteres).

-- CreateTable
CREATE TABLE "ticket_comments" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_person_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_person_id" UUID,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_comments_body_check" CHECK (
      (removed_at IS NULL AND char_length(body) BETWEEN 1 AND 10000)
      OR (removed_at IS NOT NULL AND body = '')
    ),
    CONSTRAINT "ticket_comments_removal_check" CHECK ((removed_at IS NULL) = (removed_by_person_id IS NULL))
);

-- CreateIndex (ler os comentários de um ticket em ordem de tempo)
CREATE INDEX "ticket_comments_org_id_ticket_id_created_at_id_idx" ON "ticket_comments"("org_id", "ticket_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (o ticket tem de ser do projeto; excluir o ticket exclui os comentários)
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (a autoria sobrevive: não se apaga a pessoa que escreveu, como em activity_events)
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_author_person_id_fkey" FOREIGN KEY ("org_id", "author_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (nem a que removeu)
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_removed_by_person_id_fkey" FOREIGN KEY ("org_id", "removed_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_comments
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo: o papel da aplicação não apaga comentário (remover é UPDATE; a exclusão junto com o ticket é
-- feita pela cascata da chave estrangeira, que não depende de concessão) e só altera o que edição e remoção tocam.
GRANT SELECT, INSERT ON TABLE ticket_comments TO treepm_app;
GRANT UPDATE (body, edited_at, removed_at, removed_by_person_id) ON TABLE ticket_comments TO treepm_app;
