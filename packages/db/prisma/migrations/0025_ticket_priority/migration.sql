-- Prioridade do ticket (ADR 0047, TREEPM-221): inteiro de -999 a 999, 0 por padrão, número maior primeiro.
-- A prioridade que VALE (herdada do ancestral mais próximo diferente de 0) é calculada no domínio e na web, não guardada.
-- Sem índice: nenhuma consulta filtra ou ordena por esta coluna no banco; a fila é montada em memória a partir da lista do projeto.
-- ADD COLUMN com padrão constante não reescreve a tabela (Postgres 11 ou mais novo), então a migration é rápida mesmo com tickets.
-- O papel da aplicação já tem UPDATE na tabela `tickets` (sem concessão por coluna), então a coluna nova entra sem GRANT.
ALTER TABLE "tickets" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priority_range_check" CHECK (priority BETWEEN -999 AND 999);
