-- Reimportação do Linear (ADR 0060, fatia 3; TREEPM-424). Só acrescenta colunas e relaxa um CHECK; nenhuma linha existente muda.
--
-- `external_import_runs.phase` ganha `statuses` (a situação decidida depois da árvore) e `missing`: a fase que, ao fim de uma reimportação que percorreu o time inteiro, marca as origens
-- que o Linear não mostrou mais.
--
-- `ticket_external_refs.last_seen_run_id`: a rodada em que a origem foi vista pela última vez (sem chave estrangeira: a rodada não
-- se apaga e a coluna só serve para comparar com a rodada em andamento). `hierarchy_pending`: a origem de ISSUE acabou de ser criada
-- (nasce `true` em qualquer modo; a de projeto do Linear nasce `false`, não tem hierarquia a decidir) OU a reimportação viu que o pai
-- (ou o projeto) da issue mudou no Linear, e a fase `hierarchy` ainda não decidiu se o ticket desce; só essa fase limpa a marca
-- (por isso uma rodada abandonada não perde o que criou). Na primeira importação a marca dos que não têm pai no Linear sai ao fim da fase.
--
-- `status_pending`: a origem precisa ser avaliada pela fase `statuses` (marca durável, que uma rodada abandonada não perde). Liga
-- quando a situação do Linear mudou, quando a situação aplicada difere da desejada sem que ninguém tenha mexido (um ticket em
-- DESVIO: uma invariante o impediu de assumir a desejada), ou quando a hierarquia moveu o ticket ou o tocou como pai. Só a fase
-- `statuses` a desliga, e só quando o ticket assumiu a desejada ou foi mexido aqui. A situação do Linear (retrato de origem) avança
-- já na leitura; a aplicada, só quando a fase `statuses` a aplica. Não há preenchimento: o desvio dos tickets da fatia 2 sai da
-- comparação entre o retrato aplicado e o de origem na primeira reimportação.
-- `status_run_id` e `status_run_flags` são só o controle da rodada em andamento (qual rodada, e o que ela já contou/avaliou do ticket:
-- 1 atualizado, 2 mexido, 4 avaliado, 8 o Linear mudou a situação); a lista de trabalho da fase `statuses` é recalculada a cada passo
-- a partir deles, em vez de um cursor por profundidade.
--
-- `external_import_runs.batch_size`: o teto de itens por passo das fases em lote (`hierarchy`, `statuses`, `mentions`, `missing`),
-- reduzido à metade quando a transação estoura (nulo = o tamanho normal de cada fase). `size_streak`: passos bem-sucedidos seguidos
-- desde a última redução; o tamanho só volta a crescer depois de três.

ALTER TABLE "external_import_runs" DROP CONSTRAINT "external_import_runs_phase_check";
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_phase_check" CHECK ("phase" IN ('projects', 'issues', 'hierarchy', 'statuses', 'mentions', 'missing', 'categorize', 'done', 'failed'));

ALTER TABLE "ticket_external_refs" ADD COLUMN "last_seen_run_id" UUID;
ALTER TABLE "ticket_external_refs" ADD COLUMN "hierarchy_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ticket_external_refs" ADD COLUMN "status_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ticket_external_refs" ADD COLUMN "status_run_id" UUID;
ALTER TABLE "ticket_external_refs" ADD COLUMN "status_run_flags" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "external_import_runs" ADD COLUMN "batch_size" INTEGER;
ALTER TABLE "external_import_runs" ADD COLUMN "size_streak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "external_import_runs" ADD CONSTRAINT "external_import_runs_batch_size_check" CHECK ("batch_size" IS NULL OR "batch_size" BETWEEN 1 AND 1000);

-- A consulta de `markMissing` e das fases em lotes varre as origens do projeto em ordem de `ticket_id`.
CREATE INDEX "ticket_external_refs_project_ticket_idx" ON "ticket_external_refs"("org_id", "project_id", "ticket_id");
