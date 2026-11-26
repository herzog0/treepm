-- Prazo do ticket (ADR 0064, TREEPM-467). Só acrescenta: nenhum valor existente muda.
-- Data de calendário, sem hora e sem fuso (tipo `date`): "12 de dezembro" é o mesmo dia para todo mundo. Nula = sem prazo.
-- Faixa de 2000-01-01 a 2100-12-31 (a mesma do domínio, `isValidDueDate`): cabe todo prazo real e recusa os erros de digitação que
-- viram datas absurdas. O CHECK é a segunda trava; a primeira é a validação de entrada na API e na sincronização com o Linear.
-- "Atrasado" é derivado (prazo < hoje de quem olha, categoria aberta) e não é gravado.
-- Sem índice: nenhuma consulta filtra ou ordena por esta coluna no banco nesta fatia (o filtro do mapa é a fatia 2).
-- ADD COLUMN sem padrão não reescreve a tabela. O papel da aplicação já tem UPDATE na tabela `tickets` (sem concessão por coluna).
ALTER TABLE "tickets" ADD COLUMN "due_date" DATE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_due_date_range_check" CHECK (due_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31');
