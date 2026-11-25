-- Sincronizar com o Linear, fatia 2: comentários (ADR 0061, seções 3, 5 e 6; TREEPM-477). Acrescenta estrutura; a única linha que altera dado existente é o UPDATE do fim (nome de criador com forma de e-mail).
--
-- 1. Origem por item (`external_item_refs`): coisas que são muitas por ticket (comentários agora; relações, etiquetas e anexos nas fatias
--    deles) guardam a própria origem, com a mesma unicidade por organização da origem de ticket (`ticket_external_refs`).
--    * `local_id`: o item local (para comentário, `ticket_comments.id`); sem chave estrangeira porque o tipo muda de tabela. Nulo quando
--      o item foi removido no TreePM (`removed_here_at`): a sincronização não o traz de volta.
--    * `applied`: o que foi aplicado (datas de edição, marca do corpo original, id do usuário e do pai no Linear, se o corpo começa com a citação). Nunca o corpo nem e-mail.
--    * `last_seen_run_id`: a rodada que viu o item por último; a passada de "não vistos" marca `missing_since` nos outros.
-- 2. Comentário de quem não é pessoa do TreePM: `ticket_comments.author_person_id` passa a aceitar nulo, só em comentário trazido do
--    Linear (`via = 'linear'`). `external_author_name` guarda o nome de exibição no Linear (ou o do robô), só quando não há pessoa casada.
--    Os dois nulos = autor apagado no Linear (o comentário existe, ninguém é atribuído; nunca quem sincronizou). O e-mail não é guardado.
-- 3. `external_import_runs.phase` ganha `comments`.
-- 4. A ÚNICA linha que altera dado existente: nome de criador do Linear (0043) com forma de e-mail é zerado (o e-mail nunca é guardado).

-- ---- ticket_comments ----

ALTER TABLE "ticket_comments" ALTER COLUMN "author_person_id" DROP NOT NULL;
ALTER TABLE "ticket_comments" ADD COLUMN "external_author_name" TEXT;

ALTER TABLE "ticket_comments" DROP CONSTRAINT "ticket_comments_via_check";
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_via_check" CHECK (via IS NULL OR via IN ('mcp', 'act-as', 'linear'));
-- Autor: a pessoa (e nenhum nome), ou, só no comentário do Linear, sem pessoa (com o nome do Linear ou, autor apagado lá, sem nada).
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_check" CHECK (
  (author_person_id IS NOT NULL AND external_author_name IS NULL)
  OR (author_person_id IS NULL AND COALESCE(via, '') = 'linear')
);
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_external_author_name_check" CHECK (external_author_name IS NULL OR char_length(external_author_name) BETWEEN 1 AND 120);

-- O autor de um comentário do Linear acompanha o casamento ATUAL a cada sincronização (pessoa ↔ nome ↔ outra pessoa ↔ ninguém); o de
-- qualquer outro comentário nunca muda. Vale para todos os papéis, inclusive o dono.
CREATE FUNCTION ticket_comments_author_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.author_person_id IS NOT DISTINCT FROM OLD.author_person_id AND NEW.external_author_name IS NOT DISTINCT FROM OLD.external_author_name THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.via, '') = 'linear' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'o autor de um comentário não muda (author_person_id)' USING ERRCODE = 'check_violation';
END;
$$;
REVOKE ALL ON FUNCTION ticket_comments_author_guard() FROM PUBLIC;

CREATE TRIGGER ticket_comments_author_guard
  BEFORE UPDATE OF author_person_id, external_author_name ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION ticket_comments_author_guard();

-- O UPDATE do papel da aplicação ganha só as duas colunas de autoria (o gatilho acima decide quando podem mudar).
GRANT UPDATE (author_person_id, external_author_name) ON TABLE ticket_comments TO treepm_app;

-- ---- external_item_refs ----

CREATE TABLE "external_item_refs" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "local_id" UUID,
    "applied" JSONB NOT NULL DEFAULT '{}',
    "external_updated_at" TIMESTAMPTZ(3),
    "missing_since" TIMESTAMPTZ(3),
    "removed_here_at" TIMESTAMPTZ(3),
    "last_seen_run_id" UUID,
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_item_refs_pkey" PRIMARY KEY ("org_id", "id"),
    CONSTRAINT "external_item_refs_provider_check" CHECK ("provider" IN ('linear')),
    -- Só o que esta fatia usa; relações, etiquetas e anexos entram nas fatias deles.
    CONSTRAINT "external_item_refs_kind_check" CHECK ("kind" IN ('comment')),
    CONSTRAINT "external_item_refs_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 200),
    CONSTRAINT "external_item_refs_removed_check" CHECK ("removed_here_at" IS NULL OR "local_id" IS NULL)
);

CREATE UNIQUE INDEX "external_item_refs_external_key" ON "external_item_refs"("org_id", "provider", "kind", "external_id");
CREATE INDEX "external_item_refs_ticket_idx" ON "external_item_refs"("org_id", "ticket_id");
CREATE INDEX "external_item_refs_project_kind_idx" ON "external_item_refs"("org_id", "project_id", "kind");

ALTER TABLE "external_item_refs" ADD CONSTRAINT "external_item_refs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A origem acompanha o ticket (inclusive para outro projeto) e some com ele.
ALTER TABLE "external_item_refs" ADD CONSTRAINT "external_item_refs_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE external_item_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_item_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_item_refs
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo: sem DELETE (a origem só some com o ticket, pela cascata); o UPDATE só no estado da origem, nunca no id externo,
-- no tipo nem no ticket.
GRANT SELECT, INSERT ON TABLE external_item_refs TO treepm_app;
GRANT UPDATE (local_id, applied, external_updated_at, missing_since, removed_here_at, last_seen_run_id, last_imported_at) ON TABLE external_item_refs TO treepm_app;

-- ---- external_import_runs ----

ALTER TABLE "external_import_runs" DROP CONSTRAINT "external_import_runs_phase_check";
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_phase_check" CHECK ("phase" IN ('projects', 'issues', 'hierarchy', 'statuses', 'mentions', 'comments', 'missing', 'categorize', 'done', 'failed'));

-- ---- ticket_external_refs ----

-- Nome de criador com forma de e-mail (gravado desde a 0043): zerado. Critério conservador (contém @ seguido, em algum ponto, de um
-- ponto); a sincronização seguinte aplica o critério completo do domínio. Roda pelo papel dono, como as outras migrations que mexem em dado.
UPDATE "ticket_external_refs" SET "external_creator_name" = NULL WHERE "external_creator_name" LIKE '%@%.%';
