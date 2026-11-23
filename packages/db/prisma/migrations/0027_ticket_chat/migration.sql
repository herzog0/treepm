-- Chat de trabalho por ticket (ADR 0049, fatias 1 e 2). Três tabelas:
--   ticket_chats               o chat de UMA pessoa em UM ticket, com o ponto de leitura (`last_read_seq`) e a última atividade;
--   ticket_chat_messages       as mensagens: a conversa da pessoa com o assistente (mora no chat: `chat_id`, sem `thread_id`)
--                              ou a mensagem entre pessoas (mora na thread: `thread_id`, sem `chat_id`). Exatamente uma das duas;
--   ticket_chat_thread_members quem participa de cada thread (quem a abriu e quem foi mencionado).
-- Quem lê o quê NÃO é decidido aqui: a regra de pessoa é do serviço (uma função só, `canReadChatMessage` em @treepm/domain); o banco
-- guarda o isolamento por organização, a forma das linhas e o que a ADR proíbe de mudar.

-- ---- chats -----------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_chats" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    -- Tudo com `seq` até aqui já foi lido pela dona do chat (o `seq` das mensagens é único e só cresce).
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A vez do assistente: preenchido enquanto um pedido da pessoa espera a resposta do provedor (uma conversa por vez por chat). A
    -- API o limpa ao gravar ou ao falhar; um valor esquecido vence sozinho depois de alguns minutos.
    "turn_started_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_chats_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_chats_read_check" CHECK ("last_read_seq" >= 0)
);

-- Um chat por pessoa e ticket; é também a consulta "o meu chat deste ticket".
CREATE UNIQUE INDEX "ticket_chats_org_id_ticket_id_person_id_key" ON "ticket_chats"("org_id", "ticket_id", "person_id");
-- Chaves de destino das chaves estrangeiras compostas das mensagens (a pessoa e o ticket da mensagem batem com os do chat).
CREATE UNIQUE INDEX "ticket_chats_org_id_id_person_id_key" ON "ticket_chats"("org_id", "id", "person_id");
CREATE UNIQUE INDEX "ticket_chats_org_id_project_id_ticket_id_id_key" ON "ticket_chats"("org_id", "project_id", "ticket_id", "id");
-- "Meus chats": os da pessoa, do mais recente ao mais antigo.
CREATE INDEX "ticket_chats_org_id_person_id_last_activity_at_idx" ON "ticket_chats"("org_id", "person_id", "last_activity_at" DESC);

ALTER TABLE "ticket_chats" ADD CONSTRAINT "ticket_chats_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Remover o ticket remove os chats dele (ADR 0049).
ALTER TABLE "ticket_chats" ADD CONSTRAINT "ticket_chats_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_chats" ADD CONSTRAINT "ticket_chats_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---- mensagens -------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_chat_messages" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    -- Ordem total das mensagens (ordenação, cursor de página e ponto de leitura). `created_at` não serve: duas mensagens da mesma
    -- transação têm o mesmo instante, e `app_uuid_v7()` não é monotônico dentro do mesmo milissegundo.
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "chat_id" UUID,
    -- A mensagem-raiz da thread a que pertence; a própria raiz aponta para si (`thread_id = id`).
    "thread_id" UUID,
    -- Nulo = o assistente (só na conversa do chat).
    "author_person_id" UUID,
    "body" TEXT NOT NULL,
    "model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_chat_messages_pkey" PRIMARY KEY ("org_id","id"),
    -- Mora no chat OU na thread, nunca nos dois nem em nenhum.
    CONSTRAINT "ticket_chat_messages_home_check" CHECK (("chat_id" IS NULL) <> ("thread_id" IS NULL)),
    -- Mensagem de thread é sempre de uma pessoa; o assistente só fala na conversa do chat.
    CONSTRAINT "ticket_chat_messages_thread_author_check" CHECK ("thread_id" IS NULL OR "author_person_id" IS NOT NULL),
    -- Pessoa até 4.000 caracteres; assistente até 8.000. Nunca vazia.
    CONSTRAINT "ticket_chat_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND (CASE WHEN "author_person_id" IS NULL THEN 8000 ELSE 4000 END)),
    CONSTRAINT "ticket_chat_messages_model_check" CHECK ("model" IS NULL OR "author_person_id" IS NULL)
);

-- A página da conversa de um chat, e a das threads: por `seq`.
CREATE INDEX "ticket_chat_messages_chat_idx" ON "ticket_chat_messages"("org_id", "chat_id", "seq") WHERE "chat_id" IS NOT NULL;
CREATE INDEX "ticket_chat_messages_thread_idx" ON "ticket_chat_messages"("org_id", "thread_id", "seq") WHERE "thread_id" IS NOT NULL;
-- Chave de destino da chave estrangeira dos participantes (a thread é do mesmo ticket do participante).
CREATE UNIQUE INDEX "ticket_chat_messages_org_id_id_ticket_id_key" ON "ticket_chat_messages"("org_id", "id", "ticket_id");

ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- O chat é do mesmo ticket da mensagem (com `chat_id` nulo, a chave não se aplica).
ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_chat_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id", "chat_id") REFERENCES "ticket_chats"("org_id", "project_id", "ticket_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Na conversa do chat, a mensagem de pessoa é da dona do chat (com `author_person_id` nulo, a chave não se aplica).
ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_chat_owner_fkey" FOREIGN KEY ("org_id", "chat_id", "author_person_id") REFERENCES "ticket_chats"("org_id", "id", "person_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A thread acaba junto com a raiz (a raiz só some com o ticket).
ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_thread_fkey" FOREIGN KEY ("org_id", "thread_id") REFERENCES "ticket_chat_messages"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A autoria sobrevive: a pessoa que escreveu numa thread não se apaga (como em ticket_comments).
ALTER TABLE "ticket_chat_messages" ADD CONSTRAINT "ticket_chat_messages_org_id_author_person_id_fkey" FOREIGN KEY ("org_id", "author_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Uma resposta aponta para uma RAIZ (que aponta para si) do MESMO ticket; sem isto, uma thread poderia pendurar-se numa resposta ou
-- atravessar tickets.
CREATE FUNCTION ticket_chat_message_thread_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NOT NULL AND NEW.thread_id <> NEW.id THEN
    PERFORM 1 FROM ticket_chat_messages root
      WHERE root.org_id = NEW.org_id AND root.id = NEW.thread_id AND root.thread_id = root.id AND root.ticket_id = NEW.ticket_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ticket_chat_messages_thread_root: a thread % não é uma mensagem-raiz deste ticket', NEW.thread_id USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_chat_messages_thread_root';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_chat_message_thread_root BEFORE INSERT ON "ticket_chat_messages"
  FOR EACH ROW EXECUTE FUNCTION ticket_chat_message_thread_root();

-- ---- participantes das threads ----------------------------------------------------------------------------------
CREATE TABLE "ticket_chat_thread_members" (
    "org_id" TEXT NOT NULL,
    "thread_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_chat_thread_members_pkey" PRIMARY KEY ("org_id","thread_id","person_id")
);

-- "As threads de que eu participo" (e, por ticket, as do meu chat daquele ticket).
CREATE INDEX "ticket_chat_thread_members_person_idx" ON "ticket_chat_thread_members"("org_id", "person_id", "ticket_id");

ALTER TABLE "ticket_chat_thread_members" ADD CONSTRAINT "ticket_chat_thread_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_chat_thread_members" ADD CONSTRAINT "ticket_chat_thread_members_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A thread é do mesmo ticket do participante; sem a raiz, sem participantes.
ALTER TABLE "ticket_chat_thread_members" ADD CONSTRAINT "ticket_chat_thread_members_thread_fkey" FOREIGN KEY ("org_id", "thread_id", "ticket_id") REFERENCES "ticket_chat_messages"("org_id", "id", "ticket_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_chat_thread_members" ADD CONSTRAINT "ticket_chat_thread_members_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Só a raiz de uma thread tem participantes (a FK aceitaria qualquer mensagem do ticket).
CREATE FUNCTION ticket_chat_thread_member_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM ticket_chat_messages root WHERE root.org_id = NEW.org_id AND root.id = NEW.thread_id AND root.thread_id = root.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket_chat_thread_members_root: % não é uma mensagem-raiz', NEW.thread_id USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_chat_thread_members_root';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_chat_thread_member_root BEFORE INSERT ON "ticket_chat_thread_members"
  FOR EACH ROW EXECUTE FUNCTION ticket_chat_thread_member_root();

-- ---- "meus chats": os tickets de que a pessoa é responsável, sem varrer o projeto ----------------------------------
CREATE INDEX "ticket_assignees_org_id_person_id_ticket_id_idx" ON "ticket_assignees"("org_id", "person_id", "ticket_id");

-- ---- isolamento por organização (ADR 0021), idêntico às demais tabelas -------------------------------------------
ALTER TABLE ticket_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_chats
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_chat_messages
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_chat_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_chat_thread_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_chat_thread_members
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- O DELETE de mensagens é só para "limpar" a conversa com o assistente: a política RESTRITIVA (somada à de isolamento) nunca deixa o
-- papel da aplicação apagar mensagem de thread. A cascata do ticket (chave estrangeira) não passa por política.
CREATE POLICY chat_conversation_delete_only ON ticket_chat_messages AS RESTRICTIVE FOR DELETE
  USING (chat_id IS NOT NULL);

-- ---- privilégio mínimo para `treepm_app` ---------------------------------------------------------------------------
-- Chat: cria e só altera o ponto de leitura, a última atividade e a vez do assistente (quem é a pessoa e de que ticket é nunca muda).
GRANT SELECT, INSERT ON TABLE ticket_chats TO treepm_app;
GRANT UPDATE (last_read_seq, last_activity_at, turn_started_at) ON TABLE ticket_chats TO treepm_app;
-- Mensagem: nunca é editada. O DELETE existe para "limpar o meu chat" (o serviço só apaga as do chat da própria pessoa).
GRANT SELECT, INSERT, DELETE ON TABLE ticket_chat_messages TO treepm_app;
-- Participante: entra e nunca sai nem muda (a thread é de quem foi incluído; perder acesso ao ticket é conferido na leitura).
GRANT SELECT, INSERT ON TABLE ticket_chat_thread_members TO treepm_app;
