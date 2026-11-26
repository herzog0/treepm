-- Sincronizar com o Linear, fatia 4: histórico das issues (ADR 0061, "Decisão da fatia 4"; TREEPM-482). Só acrescenta: nenhum valor
-- existente muda.
--
-- 1. `external_history_entries`: uma linha por entrada do histórico de uma issue do Linear (`IssueHistory`). Tabela própria, e não
--    `external_item_refs`: aqui o item local É a linha (não há outra tabela a apontar). `changes` guarda só as mudanças da lista da ADR
--    já normalizadas (situação, responsável, prioridade na escala do TreePM, título, pai, projeto, "alterou a descrição"); nunca e-mail.
--    Autor: a pessoa do TreePM casada (`actor_person_id`), o nome de exibição do Linear ou do robô (`external_actor_name`), ou ninguém
--    (autor apagado ou desconhecido). Nunca os dois. O nome não tem forma de e-mail: a guarda de verdade é a mesma dos comentários
--    (`linearCommentAuthorName`, no domínio); o CHECK `not like '%@%.%'` é o critério conservador da 0044, uma segunda trava.
--    O papel da aplicação lê e insere; atualiza SÓ as colunas do autor (o autor acompanha o casamento atual, como nos comentários);
--    não apaga (some em cascata com o ticket).
-- 2. `external_import_runs.phase` ganha `history` (entre `relations` e `missing`).
-- 3. A marca d'água da leitura incremental fica na rodada, não na ligação time↔projeto (a ligação é só leitura e inserção para o
--    `treepm_app`; a rodada já é atualizada a cada passo, na mesma transação do cursor):
--    `history_since` (o filtro `updatedAt > ...` fixado ao entrar na fase; nulo = time inteiro) e `history_complete` (a fase terminou
--    sem truncamento por erro). A marca de um projeto é o maior `started_at` (o começo da rodada, que já existe) das rodadas com
--    `history_complete`; o filtro da próxima é essa marca menos 10 minutos. Contar do começo da rodada, e não do começo da fase, cobre
--    a issue que nasce no Linear enquanto a rodada anda.

-- ---- external_history_entries ----

CREATE TABLE "external_history_entries" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_person_id" UUID,
    "external_actor_name" TEXT,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_history_entries_pkey" PRIMARY KEY ("org_id", "id"),
    CONSTRAINT "external_history_entries_provider_check" CHECK ("provider" IN ('linear')),
    CONSTRAINT "external_history_entries_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 200),
    CONSTRAINT "external_history_entries_actor_check" CHECK ("actor_person_id" IS NULL OR "external_actor_name" IS NULL),
    CONSTRAINT "external_history_entries_external_actor_name_check" CHECK (
      "external_actor_name" IS NULL OR (char_length("external_actor_name") BETWEEN 1 AND 120 AND "external_actor_name" NOT LIKE '%@%.%')
    ),
    CONSTRAINT "external_history_entries_changes_check" CHECK (jsonb_typeof("changes") = 'array')
);

CREATE UNIQUE INDEX "external_history_entries_external_key" ON "external_history_entries"("org_id", "provider", "external_id");
-- A linha do tempo do ticket, por data.
CREATE INDEX "external_history_entries_ticket_idx" ON "external_history_entries"("org_id", "ticket_id", "occurred_at");
-- O casamento do autor (atualizar as entradas de uma pessoa) e a chave estrangeira para pessoas.
CREATE INDEX "external_history_entries_actor_idx" ON "external_history_entries"("org_id", "actor_person_id");

ALTER TABLE "external_history_entries" ADD CONSTRAINT "external_history_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_history_entries" ADD CONSTRAINT "external_history_entries_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_history_entries" ADD CONSTRAINT "external_history_entries_actor_fkey" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE external_history_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_history_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_history_entries
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT ON TABLE external_history_entries TO treepm_app;
GRANT UPDATE (actor_person_id, external_actor_name) ON TABLE external_history_entries TO treepm_app;

-- ---- external_import_runs ----

ALTER TABLE "external_import_runs" DROP CONSTRAINT "external_import_runs_phase_check";
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_phase_check" CHECK ("phase" IN ('projects', 'issues', 'hierarchy', 'statuses', 'mentions', 'comments', 'relations', 'history', 'missing', 'categorize', 'done', 'failed'));
ALTER TABLE "external_import_runs" ADD COLUMN "history_since" TIMESTAMPTZ(3);
ALTER TABLE "external_import_runs" ADD COLUMN "history_complete" BOOLEAN NOT NULL DEFAULT false;
