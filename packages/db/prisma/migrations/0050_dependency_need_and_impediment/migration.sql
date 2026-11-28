-- O tipo de "depende de" e o impedimento marcado (ADR 0068, seções 3 e 5; TREEPM-568).
--
-- 1. `ticket_relations.need`: o tipo da dependência, `start` ("para começar": o trabalho fica parado até o outro ticket ficar pronto) ou
--    `deliver` ("para entregar": o trabalho começa sem o outro, e o ticket só fecha quando o outro fica pronto). Obrigatório em
--    `depends_on` e nulo nos outros tipos (o CHECK). As dependências que já existem viram `start`. Continua no máximo uma dependência
--    entre dois tickets (o índice único por par e tipo de relação que já existe); trocar o tipo é um UPDATE. Um gatilho BEFORE INSERT
--    põe "para começar" quando `depends_on` chega sem `need` (a API antiga, na janela do deploy).
-- 2. O impedimento no ticket: o motivo (texto de 1 a 1000 caracteres, com algo além de espaço), quem marcou e quando. Os três andam
--    juntos (CHECK), como o marcador de trabalho pela IA (migration 0019). "Bloqueado" é o ticket ABERTO com impedimento: a leitura
--    confere a situação, e a aplicação limpa o impedimento ao concluir ou cancelar. Não há CHECK com a situação: a situação de um pai é
--    calculada pelos filhos (ADR 0068, seção 2), e um CHECK faria essa conta falhar num pai impedido.
--
-- Sem GRANT novo: o papel da aplicação já tem UPDATE em `tickets` e `ticket_relations` inteiras (migrations 0004 e 0011), e as duas
-- tabelas já têm RLS por `org_id`.

-- ---- ticket_relations ----

ALTER TABLE "ticket_relations" ADD COLUMN "need" TEXT;
UPDATE "ticket_relations" SET "need" = 'start' WHERE "kind" = 'depends_on';

-- Durante o deploy, a API de antes desta migração ainda grava "depende de" sem `need`; o CHECK abaixo a recusaria (500 para a pessoa).
-- O gatilho completa "para começar", que é o que aquela API queria dizer. Só em INSERT: trocar o tipo é sempre um UPDATE explícito.
CREATE FUNCTION ticket_relations_default_need() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'depends_on' AND NEW.need IS NULL THEN
    NEW.need := 'start';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ticket_relations_default_need
BEFORE INSERT ON ticket_relations
FOR EACH ROW
EXECUTE FUNCTION ticket_relations_default_need();
ALTER TABLE "ticket_relations" ADD CONSTRAINT "ticket_relations_need_check" CHECK (
  ("kind" = 'depends_on' AND "need" IS NOT NULL AND "need" IN ('start', 'deliver'))
  OR ("kind" <> 'depends_on' AND "need" IS NULL)
);

-- ---- tickets ----

ALTER TABLE "tickets"
  ADD COLUMN "impediment_reason" TEXT,
  ADD COLUMN "impediment_person_id" UUID,
  ADD COLUMN "impediment_at" TIMESTAMPTZ(3);

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_impediment_together_check" CHECK (
  (impediment_reason IS NULL AND impediment_person_id IS NULL AND impediment_at IS NULL)
  OR
  (impediment_reason IS NOT NULL AND impediment_person_id IS NOT NULL AND impediment_at IS NOT NULL)
);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_impediment_reason_check" CHECK (
  impediment_reason IS NULL OR (char_length(impediment_reason) <= 1000 AND btrim(impediment_reason) <> '')
);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_impediment_person_id_fkey" FOREIGN KEY ("org_id", "impediment_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
