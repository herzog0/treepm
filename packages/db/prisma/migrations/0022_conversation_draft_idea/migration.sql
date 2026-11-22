-- O rascunho da conversa de novo ticket pode ser registrado como ideia (ADR 0044, adendo; TREEPM-242): `draft_idea` guarda a opção.
-- Falso por padrão; a IA o liga só quando a pessoa diz que é uma ideia, e a pessoa liga ou desliga na prévia.
-- Atenção à ordem de publicação: a API nova lê e grava esta coluna, então a migration precisa estar aplicada antes do código novo.
ALTER TABLE "ticket_conversations" ADD COLUMN "draft_idea" BOOLEAN NOT NULL DEFAULT false;
