-- Importação do Linear em passos (ADR 0060, fatia 2; TREEPM-423). Só cria tabelas novas: não toca nenhuma linha existente.
--
-- `ticket_external_refs`: a ORIGEM de um ticket no provedor (a issue, ou o projeto do provedor que virou ticket pai). É única na
-- ORGANIZAÇÃO por provedor, tipo e id externo (o UUID estável do Linear), e não no projeto: a origem acompanha o ticket para onde ele
-- for, e uma reimportação o encontra lá em vez de criar outro. Guarda dois retratos da última importação (`source_snapshot`, o que veio
-- do provedor; `applied_snapshot`, o que foi aplicado no TreePM) para a reimportação saber o que mudou de cada lado. Sem e-mail
-- do provedor. A origem some com o ticket (CASCADE); a aplicação não a apaga diretamente. A chave estrangeira composta
-- (org_id, project_id, ticket_id) mantém `project_id` sempre igual ao projeto do ticket, e ON UPDATE CASCADE o acompanha se o ticket mudar.
--
-- `external_import_runs`: uma rodada de importação (fase, cursor, contagens, quem iniciou, tamanho atual da página,
-- falhas seguidas e se um destino foi escolhido, para o destino apagado não virar a raiz em silêncio). No máximo UMA rodada não terminada por
-- projeto (índice único parcial). A aplicação lê, cria e atualiza; o histórico não se apaga.

CREATE TABLE "ticket_external_refs" (
    "org_id" TEXT NOT NULL,
    "ticket_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_key" TEXT,
    "external_url" TEXT,
    "external_parent_id" TEXT,
    "external_project_id" TEXT,
    "source_snapshot" JSONB NOT NULL,
    "applied_snapshot" JSONB NOT NULL,
    "external_updated_at" TIMESTAMPTZ(3),
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_since" TIMESTAMPTZ(3),

    CONSTRAINT "ticket_external_refs_pkey" PRIMARY KEY ("org_id","ticket_id"),
    CONSTRAINT "ticket_external_refs_provider_check" CHECK ("provider" IN ('linear')),
    CONSTRAINT "ticket_external_refs_kind_check" CHECK ("kind" IN ('issue', 'project'))
);

CREATE UNIQUE INDEX "ticket_external_refs_external_key" ON "ticket_external_refs"("org_id", "provider", "kind", "external_id");
CREATE INDEX "ticket_external_refs_project_idx" ON "ticket_external_refs"("org_id", "project_id");

ALTER TABLE "ticket_external_refs" ADD CONSTRAINT "ticket_external_refs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_external_refs" ADD CONSTRAINT "ticket_external_refs_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE ticket_external_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_external_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_external_refs
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE ON TABLE ticket_external_refs TO treepm_app;

CREATE TABLE "external_import_runs" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "started_by_person_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "cursor" TEXT,
    "destination_ticket_id" UUID,
    "categorize" BOOLEAN NOT NULL DEFAULT false,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "total_expected" INTEGER,
    "wait_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "page_size" INTEGER NOT NULL DEFAULT 50,
    "error_streak" INTEGER NOT NULL DEFAULT 0,
    "has_destination" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "external_import_runs_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "external_import_runs_provider_check" CHECK ("provider" IN ('linear')),
    CONSTRAINT "external_import_runs_mode_check" CHECK ("mode" IN ('first', 'reimport')),
    CONSTRAINT "external_import_runs_phase_check" CHECK ("phase" IN ('projects', 'issues', 'hierarchy', 'mentions', 'categorize', 'done', 'failed')),
    CONSTRAINT "external_import_runs_page_size_check" CHECK ("page_size" BETWEEN 1 AND 250),
    CONSTRAINT "external_import_runs_error_streak_check" CHECK ("error_streak" >= 0),
    CONSTRAINT "external_import_runs_total_check" CHECK ("total_expected" IS NULL OR "total_expected" >= 0)
);

-- No máximo uma rodada não terminada por projeto.
CREATE UNIQUE INDEX "external_import_runs_open_key" ON "external_import_runs"("org_id", "project_id") WHERE "phase" NOT IN ('done', 'failed');
CREATE INDEX "external_import_runs_project_idx" ON "external_import_runs"("org_id", "project_id", "started_at");

ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_project_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_started_by_fkey" FOREIGN KEY ("org_id", "started_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- O destino é um ticket do mesmo projeto; apagar o ticket volta a rodada para a raiz do projeto.
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_destination_fkey" FOREIGN KEY ("org_id", "project_id", "destination_ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE SET NULL ("destination_ticket_id") ON UPDATE CASCADE;

ALTER TABLE external_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_import_runs
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE ON TABLE external_import_runs TO treepm_app;
