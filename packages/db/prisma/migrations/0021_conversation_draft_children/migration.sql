-- Filhos do rascunho da conversa de novo ticket (ADR 0044): lista JSON de `{ title, description }`, na ordem do rascunho.
-- `NULL` = rascunho de um ticket só. Até 20 filhos, um nível só (o filho não tem filhos no rascunho).
-- Atenção à ordem de publicação: a API nova lê e grava esta coluna, então a migration precisa estar aplicada antes do código novo.
ALTER TABLE "ticket_conversations" ADD COLUMN "draft_children" JSONB;
ALTER TABLE "ticket_conversations" ADD CONSTRAINT "ticket_conversations_draft_children_check" CHECK (
    "draft_children" IS NULL
    OR ("draft_title" IS NOT NULL AND jsonb_typeof("draft_children") = 'array' AND jsonb_array_length("draft_children") <= 20)
);
