-- Relações entre tickets (ADR 0037): "menciona" (derivada da descrição) e "depende de" (registrada pela pessoa).
-- Nenhuma tabela existente muda e a migration não interpreta texto de descrição.

-- CreateTable
CREATE TABLE "ticket_relations" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "from_ticket_id" UUID NOT NULL,
    "to_ticket_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_relations_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_relations_kind_check" CHECK ("kind" IN ('mentions', 'depends_on')),
    CONSTRAINT "ticket_relations_not_self_check" CHECK ("from_ticket_id" <> "to_ticket_id")
);

-- CreateIndex (no máximo uma ligação por par e tipo)
CREATE UNIQUE INDEX "ticket_relations_org_id_from_ticket_id_to_ticket_id_kind_key" ON "ticket_relations"("org_id", "from_ticket_id", "to_ticket_id", "kind");

-- CreateIndex (quem aponta para um ticket)
CREATE INDEX "ticket_relations_org_id_to_ticket_id_kind_idx" ON "ticket_relations"("org_id", "to_ticket_id", "kind");

-- AddForeignKey
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (as duas pontas são do mesmo projeto: garantido pelo banco, como na árvore)
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_org_id_project_id_from_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "from_ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_org_id_project_id_to_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "to_ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE ticket_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_relations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ticket_relations TO treepm_app;
