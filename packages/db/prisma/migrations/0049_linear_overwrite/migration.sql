-- Sincronizar deixando o Linear vencer (ADR 0066). Só acrescenta: nenhum valor existente muda.
--
-- `external_import_runs.overwrite`: a opção "Sobrescrever com o Linear", escolhida ao abrir a rodada e lida em todos os passos (seja
-- quem for que os conduza). Só faz sentido em `reimport`; a API recusa a primeira importação com a opção. As rodadas que já existem
-- ficam `false` (a regra por campo de sempre). O papel da aplicação já tem SELECT, INSERT e UPDATE na tabela (migration 0038).

ALTER TABLE "external_import_runs" ADD COLUMN "overwrite" BOOLEAN NOT NULL DEFAULT false;
