-- Contribuições por área no ticket (ADR 0041, fatia 1). O texto é markdown (0 a 20.000 caracteres) e a situação é
-- informativa: nada aqui toca a situação do ticket. A contribuição é apagada de verdade ao ser removida.

-- CreateTable
CREATE TABLE "ticket_contributions" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_person_id" UUID NOT NULL,

    CONSTRAINT "ticket_contributions_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_contributions_text_check" CHECK (char_length(text) <= 20000),
    CONSTRAINT "ticket_contributions_status_check" CHECK (status IN ('todo', 'in_progress', 'done'))
);

-- CreateTable
CREATE TABLE "ticket_contribution_people" (
    "org_id" TEXT NOT NULL,
    "contribution_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_contribution_people_pkey" PRIMARY KEY ("org_id","contribution_id","person_id")
);

-- CreateIndex (uma contribuição por área em cada ticket)
CREATE UNIQUE INDEX "ticket_contributions_org_id_ticket_id_area_id_key" ON "ticket_contributions"("org_id", "ticket_id", "area_id");

-- CreateIndex (ler as contribuições de um ticket em ordem de criação)
CREATE INDEX "ticket_contributions_org_id_ticket_id_created_at_id_idx" ON "ticket_contributions"("org_id", "ticket_id", "created_at", "id");

-- CreateIndex (contar as contribuições de uma área antes de apagá-la)
CREATE INDEX "ticket_contributions_org_id_area_id_idx" ON "ticket_contributions"("org_id", "area_id");

-- AddForeignKey
ALTER TABLE "ticket_contributions" ADD CONSTRAINT "ticket_contributions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (o ticket tem de ser do projeto; excluir o ticket exclui as contribuições)
ALTER TABLE "ticket_contributions" ADD CONSTRAINT "ticket_contributions_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (uma área com contribuição não pode ser apagada)
ALTER TABLE "ticket_contributions" ADD CONSTRAINT "ticket_contributions_org_id_area_id_fkey" FOREIGN KEY ("org_id", "area_id") REFERENCES "areas"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (a autoria sobrevive: não se apaga a pessoa que criou)
ALTER TABLE "ticket_contributions" ADD CONSTRAINT "ticket_contributions_org_id_created_by_person_id_fkey" FOREIGN KEY ("org_id", "created_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_contribution_people" ADD CONSTRAINT "ticket_contribution_people_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (excluir a contribuição exclui as pessoas dela)
ALTER TABLE "ticket_contribution_people" ADD CONSTRAINT "ticket_contribution_people_org_id_contribution_id_fkey" FOREIGN KEY ("org_id", "contribution_id") REFERENCES "ticket_contributions"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (a pessoa não pode ser apagada enquanto estiver numa contribuição)
ALTER TABLE "ticket_contribution_people" ADD CONSTRAINT "ticket_contribution_people_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE ticket_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_contributions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_contributions
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_contribution_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_contribution_people FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_contribution_people
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo: a contribuição é apagada de verdade (DELETE) e só texto e situação mudam depois de criada;
-- as pessoas só entram e saem. A cascata do ticket não depende de concessão.
GRANT SELECT, INSERT, DELETE ON TABLE ticket_contributions TO treepm_app;
GRANT UPDATE (text, status) ON TABLE ticket_contributions TO treepm_app;
GRANT SELECT, INSERT, DELETE ON TABLE ticket_contribution_people TO treepm_app;
