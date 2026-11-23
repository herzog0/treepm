-- A decisão da procura guarda também os tickets relacionados e o duplicado (ADR 0052, itens 2, 3 e 5; fatia 2; TREEPM-328).
-- Continua SÓ identificadores e números: nenhum título nem texto. Colunas com padrão: as linhas da 0028 seguem válidas, e a API
-- tolera a ausência destas colunas (grava e lê como na 0028).
--   related: [{ ticketId, number, sameSubject, sameRequest }], em ordem de probabilidade; as duas probabilidades do Jev.
--   duplicate_ticket_id: o relacionado apontado como o mesmo pedido, se houve. Sem chave estrangeira de propósito: a decisão é
--     diagnóstico e não deve impedir apagar o ticket de que fala.
--   placement_rule: qual regra decidiu o lugar quando havia relacionado (descent = sem relacionado ou o da descida ficou).
ALTER TABLE "placement_decisions"
  ADD COLUMN "related" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "duplicate_ticket_id" UUID,
  ADD COLUMN "placement_rule" TEXT,
  ADD CONSTRAINT "placement_decisions_related_check" CHECK (jsonb_typeof("related") = 'array'),
  ADD CONSTRAINT "placement_decisions_placement_rule_check" CHECK ("placement_rule" IS NULL OR "placement_rule" IN ('descent','related_within','related_ancestor','related_choice','choice_unavailable'));
