-- Conversas em níveis e chat geral (ADR 0055, fatia 2; TREEPM-370, 371 e 372). Substitui o chat por ticket da 0027:
--   conversations              toda conversa é uma "conversa": a principal de uma pessoa num ticket (`kind = 'ticket'`), o chat geral dela
--                              (`kind = 'general'`) ou uma thread (`kind = 'thread'`), que mora DENTRO de outra conversa (`parent_id`) até o
--                              teto técnico de 40 níveis (`depth`); o limite de dez níveis é da API, contado a partir da conversa mais alta que quem abre lê. `root_id` é a principal de onde a conversa descende;
--   conversation_participants  quem participa de cada conversa, com o ponto de leitura DA PESSOA nela (`last_read_seq`);
--   conversation_messages      as mensagens (a tabela `ticket_chat_messages`, alterada no lugar para o `seq` e os pontos de leitura
--                              sobreviverem): cada uma pertence a UMA conversa. A mensagem que abriu uma thread mora na conversa de
--                              cima (`conversations.opening_message_id`) e quem participa da thread a lê como primeira da thread.
-- Quem lê o quê NÃO é decidido só aqui: a regra de pessoa é de @treepm/domain (`conversation-visibility`) e a API passa toda rota por
-- ela. O banco guarda o isolamento por organização, a forma das linhas, o nível máximo e a invariante da ADR: os participantes de uma
-- thread incluem os da conversa de cima (conferida no fim de cada transação).
-- Os dados da 0027 são migrados aqui mesmo: cada chat vira conversa principal (mesmo id); cada thread vira thread de nível 1 sob a
-- conversa principal de quem a abriu (mesmo id da mensagem-raiz), com os participantes de hoje e o "lido até" do chat de cada um.

-- ---- conversas -----------------------------------------------------------------------------------------------------
CREATE TABLE "conversations" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "kind" TEXT NOT NULL,
    -- Quem abriu (a dona da principal, ou quem marcou alguém numa mensagem e abriu a thread).
    "owner_person_id" UUID NOT NULL,
    -- O ticket de que a conversa trata; nulo no chat geral e nas threads dele que não tratam de ticket. Sempre os dois ou nenhum.
    "project_id" UUID,
    "ticket_id" UUID,
    "parent_id" UUID,
    -- A principal de onde descende (a própria, nas principais).
    "root_id" UUID NOT NULL,
    -- 0 nas principais; 1 a 10 nas threads.
    "depth" INTEGER NOT NULL DEFAULT 0,
    -- A mensagem (da conversa de cima) que abriu a thread; nulo nas principais.
    "opening_message_id" UUID,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A vez do assistente: preenchido enquanto um pedido da pessoa espera a resposta do provedor (uma por vez por conversa principal).
    "turn_started_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "conversations_kind_check" CHECK ("kind" IN ('ticket', 'general', 'thread')),
    -- Dez níveis de thread (ADR 0055); a principal é o nível 0.
    CONSTRAINT "conversations_depth_check" CHECK ("depth" BETWEEN 0 AND 40),
    -- Principal: sem pai, nível 0, sem mensagem de abertura. Thread: com pai, nível 1 ou mais, com mensagem de abertura.
    CONSTRAINT "conversations_shape_check" CHECK (
      ("kind" = 'thread') = ("parent_id" IS NOT NULL)
      AND ("kind" = 'thread') = ("opening_message_id" IS NOT NULL)
      AND ("kind" = 'thread') = ("depth" > 0)
    ),
    CONSTRAINT "conversations_ticket_check" CHECK (("project_id" IS NULL) = ("ticket_id" IS NULL) AND ("kind" <> 'ticket' OR "ticket_id" IS NOT NULL))
);

-- Uma principal por pessoa e ticket; um chat geral por pessoa (as threads não têm unicidade).
CREATE UNIQUE INDEX "conversations_ticket_owner_key" ON "conversations"("org_id", "ticket_id", "owner_person_id") WHERE "kind" = 'ticket';
CREATE UNIQUE INDEX "conversations_general_owner_key" ON "conversations"("org_id", "owner_person_id") WHERE "kind" = 'general';
-- Uma mensagem abre no máximo uma thread.
CREATE UNIQUE INDEX "conversations_opening_message_key" ON "conversations"("org_id", "opening_message_id") WHERE "opening_message_id" IS NOT NULL;
CREATE INDEX "conversations_parent_idx" ON "conversations"("org_id", "parent_id") WHERE "parent_id" IS NOT NULL;
CREATE INDEX "conversations_root_idx" ON "conversations"("org_id", "root_id");
CREATE INDEX "conversations_ticket_idx" ON "conversations"("org_id", "ticket_id") WHERE "ticket_id" IS NOT NULL;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Remover o ticket remove as conversas dele (com os campos nulos, a chave não se aplica).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_fkey" FOREIGN KEY ("org_id", "owner_person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_parent_fkey" FOREIGN KEY ("org_id", "parent_id") REFERENCES "conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_root_fkey" FOREIGN KEY ("org_id", "root_id") REFERENCES "conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---- participantes ----------------------------------------------------------------------------------------------
CREATE TABLE "conversation_participants" (
    "org_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    -- Quem a incluiu (nulo: a dona da conversa, ou dado migrado).
    "added_by_person_id" UUID,
    -- Tudo com `seq` até aqui já foi lido por esta pessoa NESTA conversa.
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("org_id","conversation_id","person_id"),
    CONSTRAINT "conversation_participants_read_check" CHECK ("last_read_seq" >= 0)
);
-- "As conversas de que eu participo".
CREATE INDEX "conversation_participants_person_idx" ON "conversation_participants"("org_id", "person_id");

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_fkey" FOREIGN KEY ("org_id", "conversation_id") REFERENCES "conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_person_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_added_by_fkey" FOREIGN KEY ("org_id", "added_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---- migração dos dados da 0027 --------------------------------------------------------------------------------
-- 1) Cada chat vira conversa principal, com o MESMO id, e a dona participa com o ponto de leitura que o chat tinha.
INSERT INTO "conversations" ("org_id", "id", "kind", "owner_person_id", "project_id", "ticket_id", "root_id", "depth", "last_activity_at", "turn_started_at", "created_at")
SELECT "org_id", "id", 'ticket', "person_id", "project_id", "ticket_id", "id", 0, "last_activity_at", "turn_started_at", "created_at" FROM "ticket_chats";
INSERT INTO "conversation_participants" ("org_id", "conversation_id", "person_id", "last_read_seq", "added_at")
SELECT "org_id", "id", "person_id", "last_read_seq", "created_at" FROM "ticket_chats";

-- 2) Quem abriu uma thread e não tem chat naquele ticket ganha a principal (a thread precisa de um pai).
DO $$
DECLARE
  missing RECORD;
  new_id UUID;
BEGIN
  FOR missing IN
    SELECT DISTINCT r."org_id", r."project_id", r."ticket_id", r."author_person_id" AS "person_id"
    FROM "ticket_chat_messages" r
    WHERE r."thread_id" = r."id"
      AND NOT EXISTS (SELECT 1 FROM "ticket_chats" c WHERE c."org_id" = r."org_id" AND c."ticket_id" = r."ticket_id" AND c."person_id" = r."author_person_id")
  LOOP
    new_id := app_uuid_v7();
    INSERT INTO "conversations" ("org_id", "id", "kind", "owner_person_id", "project_id", "ticket_id", "root_id", "depth")
      VALUES (missing."org_id", new_id, 'ticket', missing."person_id", missing."project_id", missing."ticket_id", new_id, 0);
    INSERT INTO "conversation_participants" ("org_id", "conversation_id", "person_id") VALUES (missing."org_id", new_id, missing."person_id");
  END LOOP;
END $$;

-- 3) Cada thread vira conversa de nível 1 sob a principal de quem a abriu, com o id da mensagem-raiz.
INSERT INTO "conversations" ("org_id", "id", "kind", "owner_person_id", "project_id", "ticket_id", "parent_id", "root_id", "depth", "opening_message_id", "last_activity_at", "created_at")
SELECT r."org_id", r."id", 'thread', r."author_person_id", r."project_id", r."ticket_id", p."id", p."id", 1, r."id",
       COALESCE((SELECT max(m."created_at") FROM "ticket_chat_messages" m WHERE m."org_id" = r."org_id" AND m."thread_id" = r."id"), r."created_at"),
       r."created_at"
FROM "ticket_chat_messages" r
JOIN "conversations" p ON p."org_id" = r."org_id" AND p."kind" = 'ticket' AND p."ticket_id" = r."ticket_id" AND p."owner_person_id" = r."author_person_id"
WHERE r."thread_id" = r."id";

-- 4) Os participantes de hoje, cada um com o "lido até" do chat dele no ticket (a dona da thread sempre participa).
INSERT INTO "conversation_participants" ("org_id", "conversation_id", "person_id", "added_by_person_id", "last_read_seq", "added_at")
SELECT tm."org_id", tm."thread_id", tm."person_id",
       CASE WHEN tm."person_id" = t."owner_person_id" THEN NULL ELSE t."owner_person_id" END,
       COALESCE(ch."last_read_seq", 0), tm."added_at"
FROM "ticket_chat_thread_members" tm
JOIN "conversations" t ON t."org_id" = tm."org_id" AND t."id" = tm."thread_id"
LEFT JOIN "ticket_chats" ch ON ch."org_id" = tm."org_id" AND ch."ticket_id" = tm."ticket_id" AND ch."person_id" = tm."person_id";
INSERT INTO "conversation_participants" ("org_id", "conversation_id", "person_id", "last_read_seq")
SELECT t."org_id", t."id", t."owner_person_id", COALESCE(ch."last_read_seq", 0)
FROM "conversations" t
LEFT JOIN "ticket_chats" ch ON ch."org_id" = t."org_id" AND ch."ticket_id" = t."ticket_id" AND ch."person_id" = t."owner_person_id"
WHERE t."kind" = 'thread'
ON CONFLICT DO NOTHING;

-- 5) A tabela de mensagens é alterada no lugar (o `seq` identity e os pontos de leitura continuam valendo).
DROP TABLE "ticket_chat_thread_members";
DROP FUNCTION ticket_chat_thread_member_root();
DROP TRIGGER ticket_chat_message_thread_root ON "ticket_chat_messages";
DROP FUNCTION ticket_chat_message_thread_root();
DROP POLICY chat_conversation_delete_only ON "ticket_chat_messages";
ALTER TABLE "ticket_chat_messages" RENAME TO "conversation_messages";
ALTER TABLE "conversation_messages" ADD COLUMN "conversation_id" UUID;
-- A conversa com o assistente: o chat. A raiz de uma thread passa para a conversa de cima (é a mensagem de abertura); as respostas
-- passam para a thread nova (que tem o id da raiz).
UPDATE "conversation_messages" SET "conversation_id" = "chat_id" WHERE "chat_id" IS NOT NULL;
UPDATE "conversation_messages" m SET "conversation_id" = c."parent_id" FROM "conversations" c WHERE m."thread_id" = m."id" AND c."org_id" = m."org_id" AND c."id" = m."id";
UPDATE "conversation_messages" SET "conversation_id" = "thread_id" WHERE "thread_id" IS NOT NULL AND "thread_id" <> "id";
ALTER TABLE "conversation_messages" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "conversation_messages" DROP CONSTRAINT "ticket_chat_messages_home_check";
ALTER TABLE "conversation_messages" DROP CONSTRAINT "ticket_chat_messages_thread_author_check";
ALTER TABLE "conversation_messages" DROP COLUMN "chat_id", DROP COLUMN "thread_id", DROP COLUMN "ticket_id", DROP COLUMN "project_id";
DROP TABLE "ticket_chats";

ALTER TABLE "conversation_messages" RENAME CONSTRAINT "ticket_chat_messages_pkey" TO "conversation_messages_pkey";
ALTER TABLE "conversation_messages" RENAME CONSTRAINT "ticket_chat_messages_body_check" TO "conversation_messages_body_check";
ALTER TABLE "conversation_messages" RENAME CONSTRAINT "ticket_chat_messages_model_check" TO "conversation_messages_model_check";
ALTER TABLE "conversation_messages" RENAME CONSTRAINT "ticket_chat_messages_org_id_fkey" TO "conversation_messages_org_id_fkey";
ALTER TABLE "conversation_messages" RENAME CONSTRAINT "ticket_chat_messages_org_id_author_person_id_fkey" TO "conversation_messages_author_fkey";
-- A página da conversa, por `seq`.
CREATE INDEX "conversation_messages_conversation_idx" ON "conversation_messages"("org_id", "conversation_id", "seq");
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_fkey" FOREIGN KEY ("org_id", "conversation_id") REFERENCES "conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A thread aponta para a mensagem que a abriu. Verificada no fim da transação: remover um ticket apaga as duas pontas de uma vez.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_opening_message_fkey" FOREIGN KEY ("org_id", "opening_message_id") REFERENCES "conversation_messages"("org_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- ---- regras do banco ---------------------------------------------------------------------------------------------
-- A forma da árvore: o pai existe, o nível e a principal batem com os dele, o ticket é herdado, a mensagem de abertura mora no pai.
CREATE FUNCTION conversations_check_shape() RETURNS trigger
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
  PERFORM 1 FROM conversation_messages m WHERE m.org_id = NEW.org_id AND m.id = NEW.opening_message_id AND m.conversation_id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversations_opening: a mensagem de abertura mora na conversa de cima' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_opening';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_check_shape BEFORE INSERT ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION conversations_check_shape();

-- Invariante (ADR 0055, regra 3), parte 1: a thread nova nasce com a dona e com TODOS os participantes da conversa de cima.
CREATE FUNCTION conversations_check_participants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversation_participants p WHERE p.org_id = NEW.org_id AND p.conversation_id = NEW.id AND p.person_id = NEW.owner_person_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversations_owner: quem abriu a conversa participa dela' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_owner';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM 1 FROM conversation_participants up
      WHERE up.org_id = NEW.org_id AND up.conversation_id = NEW.parent_id
        AND NOT EXISTS (SELECT 1 FROM conversation_participants me WHERE me.org_id = up.org_id AND me.conversation_id = NEW.id AND me.person_id = up.person_id);
    IF FOUND THEN
      RAISE EXCEPTION 'conversations_participants: a thread inclui todos os participantes da conversa de cima' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_participants';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER conversations_check_participants AFTER INSERT ON "conversations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION conversations_check_participants();

-- Só a dona participa de uma principal (ninguém é "adicionado" à conversa de uma pessoa com o assistente).
CREATE FUNCTION conversation_participants_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversations c WHERE c.org_id = NEW.org_id AND c.id = NEW.conversation_id AND c.kind <> 'thread' AND c.owner_person_id <> NEW.person_id;
  IF FOUND THEN
    RAISE EXCEPTION 'conversation_participants_principal: a conversa principal é só da dona' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_participants_principal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_participants_principal BEFORE INSERT ON "conversation_participants"
  FOR EACH ROW EXECUTE FUNCTION conversation_participants_principal();

-- Invariante, parte 2: quem entra numa conversa já está, no fim da transação, em todas as threads abertas dentro dela (as de baixo
-- repetem a conferência para as delas).
CREATE FUNCTION conversation_participants_descendants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversations child
    WHERE child.org_id = NEW.org_id AND child.parent_id = NEW.conversation_id
      AND NOT EXISTS (SELECT 1 FROM conversation_participants p WHERE p.org_id = child.org_id AND p.conversation_id = child.id AND p.person_id = NEW.person_id);
  IF FOUND THEN
    RAISE EXCEPTION 'conversation_participants_descendants: quem participa de uma conversa participa das threads de dentro' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_participants_descendants';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER conversation_participants_descendants AFTER INSERT ON "conversation_participants"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION conversation_participants_descendants();

-- Quem escreve participa da conversa; o assistente (autor nulo) só fala fora das threads.
-- Toda mudança na árvore (nova conversa, novo participante) trava a linha da principal-raiz ANTES de qualquer conferência: duas
-- transações na mesma árvore se serializam e a invariante (filha inclui a de cima), conferida no commit, enxerga a outra.
CREATE FUNCTION conversations_lock_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM 1 FROM conversations r WHERE r.org_id = NEW.org_id AND r.id = NEW.root_id FOR UPDATE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_conversations_lock_root BEFORE INSERT ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION conversations_lock_root();

CREATE FUNCTION conversation_participants_lock_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversations r WHERE r.org_id = NEW.org_id AND r.id = (SELECT c.root_id FROM conversations c WHERE c.org_id = NEW.org_id AND c.id = NEW.conversation_id) FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER a_conversation_participants_lock_root BEFORE INSERT ON "conversation_participants"
  FOR EACH ROW EXECUTE FUNCTION conversation_participants_lock_root();

CREATE FUNCTION conversation_messages_check_author() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_person_id IS NULL THEN
    PERFORM 1 FROM conversations c WHERE c.org_id = NEW.org_id AND c.id = NEW.conversation_id AND c.kind <> 'thread';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_messages_author: o assistente não fala numa thread' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_messages_author';
    END IF;
  ELSE
    PERFORM 1 FROM conversation_participants p WHERE p.org_id = NEW.org_id AND p.conversation_id = NEW.conversation_id AND p.person_id = NEW.author_person_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_messages_author: quem escreve participa da conversa' USING ERRCODE = 'check_violation', CONSTRAINT = 'conversation_messages_author';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_messages_check_author BEFORE INSERT ON "conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_check_author();

-- ---- isolamento por organização (ADR 0021), idêntico às demais tabelas -------------------------------------------
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_participants
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- O DELETE de mensagens é só para "limpar" a conversa de uma pessoa com o assistente: a política RESTRITIVA nunca deixa o papel da
-- aplicação apagar mensagem de thread (e a chave da mensagem de abertura impede apagar a que abriu uma thread).
CREATE POLICY conversation_delete_only ON conversation_messages AS RESTRICTIVE FOR DELETE
  USING (EXISTS (SELECT 1 FROM conversations c WHERE c.org_id = conversation_messages.org_id AND c.id = conversation_messages.conversation_id AND c.kind <> 'thread'));

-- ---- privilégio mínimo para `treepm_app` ---------------------------------------------------------------------------
-- Conversa: cria e só altera a última atividade e a vez do assistente (quem é a dona, o ticket e o lugar na árvore nunca mudam).
GRANT SELECT, INSERT ON TABLE conversations TO treepm_app;
GRANT UPDATE (last_activity_at, turn_started_at) ON TABLE conversations TO treepm_app;
-- Participante: entra e nunca sai; só o ponto de leitura muda.
GRANT SELECT, INSERT ON TABLE conversation_participants TO treepm_app;
GRANT UPDATE (last_read_seq) ON TABLE conversation_participants TO treepm_app;
-- Mensagem: os privilégios da 0027 (SELECT, INSERT e DELETE) acompanham a tabela renomeada; nunca é editada.
