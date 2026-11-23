-- A decisão da procura guarda os números da triagem de relacionados: quantos candidatos vieram das palavras, do vetor e das duas
-- listas, quantos foram ao Jev e o que o passo de vetor fez (ADR 0053, itens 7 e 8; fatia 2; TREEPM-349).
-- Continua SÓ números e códigos curtos: nenhum título, texto, vetor nem chave. Coluna com padrão: as linhas anteriores seguem
-- válidas, e a API tolera a ausência desta coluna (grava e lê como na 0029).
--   triage: { words, vector, both, onlyVector, sent, semantic: { synced, embedded, pending, syncMs, queryMs, failure? } }
ALTER TABLE "placement_decisions"
  ADD COLUMN "triage" JSONB NOT NULL DEFAULT '{}',
  ADD CONSTRAINT "placement_decisions_triage_check" CHECK (jsonb_typeof("triage") = 'object');
