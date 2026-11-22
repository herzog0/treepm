-- Aceite da organização para a IA (ADR 0039, TREEPM-90). Cada aceitar cria uma linha; retirar preenche a retirada da
-- linha em vigor; as linhas antigas ficam como registro (a aplicação não apaga nem reescreve o que foi aceito).

-- CreateTable
CREATE TABLE "organization_consents" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "kind" TEXT NOT NULL,
    "document_version" TEXT NOT NULL,
    "accepted_by_person_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_by_person_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_consents_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "organization_consents_kind_check" CHECK ("kind" IN ('assistant', 'code_reading')),
    CONSTRAINT "organization_consents_version_check" CHECK (char_length("document_version") BETWEEN 1 AND 80),
    -- quem retirou e quando andam juntos
    CONSTRAINT "organization_consents_withdrawal_check" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by_person_id" IS NULL))
);

-- CreateIndex (as linhas de uma organização, por tipo)
CREATE INDEX "organization_consents_org_id_kind_idx" ON "organization_consents"("org_id", "kind");

-- No máximo uma linha em vigor (não retirada) por organização e tipo; o Prisma não modela índice parcial.
CREATE UNIQUE INDEX "organization_consents_in_force_key" ON "organization_consents"("org_id", "kind") WHERE "withdrawn_at" IS NULL;

-- AddForeignKey
ALTER TABLE "organization_consents" ADD CONSTRAINT "organization_consents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (a pessoa que aceitou não pode ser apagada, como em activity_events)
ALTER TABLE "organization_consents" ADD CONSTRAINT "organization_consents_org_id_accepted_by_person_id_fkey" FOREIGN KEY ("org_id", "accepted_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (idem para a que retirou)
ALTER TABLE "organization_consents" ADD CONSTRAINT "organization_consents_org_id_withdrawn_by_person_id_fkey" FOREIGN KEY ("org_id", "withdrawn_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE organization_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_consents
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- A aplicação lê, grava o aceite e só preenche a retirada; nunca apaga nem muda quem aceitou ou a versão.
GRANT SELECT, INSERT ON TABLE organization_consents TO treepm_app;
GRANT UPDATE (withdrawn_by_person_id, withdrawn_at) ON TABLE organization_consents TO treepm_app;
