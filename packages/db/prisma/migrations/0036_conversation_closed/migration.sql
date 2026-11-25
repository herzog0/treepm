-- Fechar conversa (ADR 0059; TREEPM-417).
--   conversation_participants.closed_seq  a marca de que a PESSOA fechou a conversa: a posição (`seq`) da última mensagem da conversa
--                                         no momento em que fechou (0 se ainda não havia mensagem); nulo = aberta. Fechar é por pessoa e
--                                         não muda quem lê o quê. A conversa volta sozinha quando existe nela mensagem de outra pessoa ou
--                                         do assistente com `seq` maior que esta marca: isso se decide na leitura, sem atualizar a linha
--                                         de ninguém a cada mensagem. Quem escreve na conversa a reabre (o serviço zera a marca).
-- Tudo o que existe hoje continua aberto (a coluna nasce nula).

ALTER TABLE "conversation_participants" ADD COLUMN "closed_seq" BIGINT;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_closed_check" CHECK ("closed_seq" IS NULL OR "closed_seq" >= 0);

-- Privilégio: o papel da aplicação passa a alterar também esta coluna (e continua sem alterar nenhuma outra).
GRANT UPDATE (closed_seq) ON TABLE conversation_participants TO treepm_app;
