-- Sincronizar com o Linear, fatia 3: relações entre issues (ADR 0061, seções 3, 4 e 7; TREEPM-478). Só acrescenta: nenhum valor
-- existente muda (a coluna gerada do item 4 reescreve `external_item_refs` uma vez, ao ser criada).
--
-- 1. `ticket_relations.kind` ganha `related` ("relacionado a"): simétrica, guardada UMA vez por par, com o menor id primeiro (o CHECK
--    abaixo, junto do índice único por par e tipo que já existe). A leitura mostra nos dois tickets. Só vem do Linear (blocks → depends_on;
--    related e duplicate → related); `depends_on` e `mentions` não mudam.
-- 2. `external_item_refs.kind` ganha `relation`. `local_id` aponta para a linha de `ticket_relations` (sem chave estrangeira, como no
--    comentário); `ticket_id` é a ponta "de" da linha. `applied`: o tipo do TreePM (`depends_on` ou `related`), o id da relação, os ids
--    das duas issues e os tickets das duas pontas quando a origem foi gravada.
-- 3. `external_import_runs.phase` ganha `relations`.
-- 4. `external_item_refs.relation_id`: o id da relação no Linear, coluna GERADA de `applied->>'relationId'` (nula nos comentários), com
--    índice comum. Acha as outras formas de uma relação (o Linear deixa mudar sentido, ponta e tipo sem trocar o id). Coluna, e não índice
--    de expressão: com RLS o Postgres não usa índice sobre `jsonb ->>` (função não leakproof) para o papel da aplicação, que varreria a
--    tabela. Gerada, e não comum: nenhum código a grava, ela não diverge de `applied` e não pede GRANT (o `treepm_app` só atualiza
--    `applied`, e o Postgres a recalcula).
-- 5. Índice da origem pela linha local (a página do ticket marca as ligações vindas do Linear; a importação acha quem mais aponta para
--    uma linha).

-- ---- ticket_relations ----

ALTER TABLE "ticket_relations" DROP CONSTRAINT "ticket_relations_kind_check";
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_kind_check" CHECK ("kind" IN ('mentions', 'depends_on', 'related'));
-- `related` não tem sentido: uma linha por par, na ordem canônica (o índice único `(org_id, from, to, kind)` faz o resto).
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_related_order_check" CHECK ("kind" <> 'related' OR "from_ticket_id" < "to_ticket_id");

-- ---- external_item_refs ----

ALTER TABLE "external_item_refs" DROP CONSTRAINT "external_item_refs_kind_check";
ALTER TABLE "external_item_refs" ADD CONSTRAINT "external_item_refs_kind_check" CHECK ("kind" IN ('comment', 'relation'));
ALTER TABLE "external_item_refs" ADD COLUMN "relation_id" TEXT GENERATED ALWAYS AS ("applied"->>'relationId') STORED;
-- Parcial: só no SQL (o Prisma não descreve coluna gerada nem índice com WHERE).
CREATE INDEX "external_item_refs_relation_id_idx" ON "external_item_refs"("org_id", "relation_id") WHERE "kind" = 'relation';
CREATE INDEX "external_item_refs_local_idx" ON "external_item_refs"("org_id", "local_id");

-- ---- external_import_runs ----

ALTER TABLE "external_import_runs" DROP CONSTRAINT "external_import_runs_phase_check";
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_phase_check" CHECK ("phase" IN ('projects', 'issues', 'hierarchy', 'statuses', 'mentions', 'comments', 'relations', 'missing', 'categorize', 'done', 'failed'));
