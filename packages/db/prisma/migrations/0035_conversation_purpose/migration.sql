-- Thread de assunto: o texto livre da barra vira conversa (ADR 0056, fatia 2; TREEPM-398).
--   conversations.purpose                 para que a thread existe: `people` (marcou gente, é entre pessoas, as de antes), `topic` (um assunto
--                                         com o assistente, só de quem a abriu) ou `creation` (a conversa de novo ticket, da fatia 3). Nulo
--                                         nas principais. Gravado na inserção e IMUTÁVEL: o papel da aplicação não recebe UPDATE nela;
--   conversations.title                   o título curto que o assistente dá à thread de assunto (nulo até a primeira resposta);
--   conversations.ticket_conversation_id  a conversa de novo ticket de uma thread `creation` (a fatia 3 a preenche; nesta nenhuma rota cria `creation`).
-- Thread `topic` ou `creation` tem UM participante, quem a abriu, para sempre, e só nasce dentro de conversa principal da própria pessoa:
-- garantido aqui, não só no serviço. O assistente passa a poder falar em `topic`; em `people` continua proibido.

ALTER TABLE "conversations" ADD COLUMN "purpose" TEXT, ADD COLUMN "title" TEXT, ADD COLUMN "ticket_conversation_id" UUID;

-- As threads de hoje são todas entre pessoas.
UPDATE "conversations" SET "purpose" = 'people' WHERE "kind" = 'thread';

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_purpose_check" CHECK (
  ("kind" = 'thread') = ("purpose" IS NOT NULL) AND ("purpose" IS NULL OR "purpose" IN ('people', 'topic', 'creation'))
);
-- Título: só em thread de assunto ou de criação; 1 a 60 caracteres, aparado, sem ponto final.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_title_check" CHECK (
  "title" IS NULL OR ("purpose" IN ('topic', 'creation') AND char_length("title") BETWEEN 1 AND 60 AND "title" = btrim("title") AND right("title", 1) <> '.')
);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ticket_conversation_check" CHECK ("ticket_conversation_id" IS NULL OR "purpose" = 'creation');
-- Apagar a conversa de novo ticket solta o elo, não apaga a thread.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ticket_conversation_fkey" FOREIGN KEY ("org_id", "ticket_conversation_id") REFERENCES "ticket_conversations"("org_id", "id") ON DELETE SET NULL ("ticket_conversation_id") ON UPDATE CASCADE;
CREATE UNIQUE INDEX "conversations_ticket_conversation_key" ON "conversations"("org_id", "ticket_conversation_id") WHERE "ticket_conversation_id" IS NOT NULL;

-- A forma da árvore ganha a regra do propósito: `topic` e `creation` nascem direto sob a principal da própria pessoa.
CREATE OR REPLACE FUNCTION conversations_check_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent conversations%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.root_id <> NEW.id THEN
      RAISE EXCEPTION 'conversations_root: a principal é a própria raiz' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_root';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM conversations WHERE org_id = NEW.org_id AND id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversations_parent: a conversa de cima não existe' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_parent';
  END IF;
  IF NEW.depth <> parent.depth + 1 OR NEW.root_id <> parent.root_id THEN
    RAISE EXCEPTION 'conversations_level: o nível e a principal da thread têm de seguir os do pai' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_level';
  END IF;
  IF parent.ticket_id IS NOT NULL AND (NEW.ticket_id IS DISTINCT FROM parent.ticket_id OR NEW.project_id IS DISTINCT FROM parent.project_id) THEN
    RAISE EXCEPTION 'conversations_ticket: a thread herda o ticket do pai' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_ticket';
  END IF;
  IF NEW.purpose IN ('topic', 'creation') AND (parent.kind = 'thread' OR parent.owner_person_id <> NEW.owner_person_id) THEN
    RAISE EXCEPTION 'conversations_purpose_parent: thread de assunto só nasce dentro de conversa principal da própria pessoa' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_purpose_parent';
  END IF;
  PERFORM 1 FROM conversation_messages m WHERE m.org_id = NEW.org_id AND m.id = NEW.opening_message_id AND m.conversation_id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversations_opening: a mensagem de abertura mora na conversa de cima' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_opening';
  END IF;
  RETURN NEW;
END $$;

-- Um participante só: quem entra numa thread `topic` ou `creation` é a dona dela, e mais ninguém, por nenhum caminho.
CREATE FUNCTION conversation_participants_private() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversations c WHERE c.org_id = NEW.org_id AND c.id = NEW.conversation_id AND c.purpose IN ('topic', 'creation') AND c.owner_person_id <> NEW.person_id;
  IF FOUND THEN
    RAISE EXCEPTION 'conversation_participants_private: a thread de assunto é só de quem a abriu' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_participants_private';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_participants_private BEFORE INSERT ON "conversation_participants"
  FOR EACH ROW EXECUTE FUNCTION conversation_participants_private();

-- Quem escreve participa da conversa; o assistente (autor nulo) só fala fora das threads e nas de assunto.
CREATE OR REPLACE FUNCTION conversation_messages_check_author() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_person_id IS NULL THEN
    PERFORM 1 FROM conversations c WHERE c.org_id = NEW.org_id AND c.id = NEW.conversation_id AND (c.kind <> 'thread' OR c.purpose = 'topic');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_messages_author: o assistente não fala numa thread entre pessoas' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_messages_author';
    END IF;
  ELSE
    PERFORM 1 FROM conversation_participants p WHERE p.org_id = NEW.org_id AND p.conversation_id = NEW.conversation_id AND p.person_id = NEW.author_person_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_messages_author: quem escreve participa da conversa' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_messages_author';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- O DELETE de mensagens continua só para "limpar" a conversa principal; thread de assunto não se limpa por aqui (a política da 0033 já a exclui).

-- Privilégio: o título é a única coluna nova que a aplicação altera; o propósito e o elo da conversa de criação nunca mudam.
GRANT UPDATE (title) ON TABLE conversations TO treepm_app;
