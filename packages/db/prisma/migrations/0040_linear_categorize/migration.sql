-- Categorização do lote importado do Linear (ADR 0060, fatia 4; TREEPM-425). Só acrescenta; nenhuma linha existente muda.
--
-- A categorização é uma ação oferecida DEPOIS de uma importação concluída: procura o lugar de cada raiz do lote na árvore do projeto. Ela
-- reaproveita `external_import_runs` com `mode = 'categorize'` (fase `categorize` enquanto há candidato; depois `done` ou `failed`): assim o
-- índice único parcial "uma rodada aberta por projeto" vale também entre importação e categorização, que não podem andar juntas.
-- `source_run_id` é a rodada de importação concluída sobre a qual a categorização foi aberta (sem chave estrangeira: só informa).
--
-- `external_categorize_items`: a lista CONGELADA de candidatos da rodada (um item por ticket, na ordem de `position`) e o que a procura
-- decidiu de cada um: `pending` (falta), `placed` (movido), `to_check` (ficou onde estava, para a pessoa conferir; `suggested_path` é o caminho
-- sugerido, só ids), `kept` (o melhor lugar é onde está), `skipped` (deixou de ser candidato antes do passo) e `failed` (o provedor falhou duas
-- vezes). `attempts` conta as falhas do candidato (provedor ou erro inesperado) e `waits` os limites de taxa seguidos no mesmo candidato
-- (na 10ª espera ele vira `failed`). `parent_before` é o pai que o ticket tinha ao ser decidido: "a conferir"
-- só continua na lista enquanto o pai for esse. `dismissed_at` é a pessoa dizendo "conferi". A aplicação lê, insere e atualiza; não apaga.
-- O item some com o ticket (CASCADE) e com a rodada.
--
-- `placement_decisions.placed_by` ganha `import` (a decisão veio da categorização do lote importado, não de uma conversa).

ALTER TABLE "external_import_runs" DROP CONSTRAINT "external_import_runs_mode_check";
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_mode_check" CHECK ("mode" IN ('first', 'reimport', 'categorize'));
ALTER TABLE "external_import_runs" ADD COLUMN "source_run_id" UUID;

CREATE TABLE "external_categorize_items" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "run_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "waits" INTEGER NOT NULL DEFAULT 0,
    "parent_before" UUID,
    "suggested_path" UUID[] NOT NULL DEFAULT '{}',
    "decided_at" TIMESTAMPTZ(3),
    "dismissed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_categorize_items_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "external_categorize_items_state_check" CHECK ("state" IN ('pending', 'placed', 'to_check', 'kept', 'skipped', 'failed')),
    CONSTRAINT "external_categorize_items_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "external_categorize_items_waits_check" CHECK ("waits" >= 0)
);

CREATE UNIQUE INDEX "external_categorize_items_run_ticket_key" ON "external_categorize_items"("org_id", "run_id", "ticket_id");
CREATE INDEX "external_categorize_items_run_idx" ON "external_categorize_items"("org_id", "run_id", "state", "position");
CREATE INDEX "external_categorize_items_ticket_idx" ON "external_categorize_items"("org_id", "project_id", "ticket_id");

ALTER TABLE "external_categorize_items" ADD CONSTRAINT "external_categorize_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_categorize_items" ADD CONSTRAINT "external_categorize_items_run_fkey" FOREIGN KEY ("org_id", "run_id") REFERENCES "external_import_runs"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_categorize_items" ADD CONSTRAINT "external_categorize_items_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE external_categorize_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_categorize_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_categorize_items
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE ON TABLE external_categorize_items TO treepm_app;

ALTER TABLE "placement_decisions" DROP CONSTRAINT "placement_decisions_placed_by_check";
ALTER TABLE "placement_decisions" ADD CONSTRAINT "placement_decisions_placed_by_check" CHECK ("placed_by" IN ('search', 'option', 'stay', 'recent', 'map', 'import'));
