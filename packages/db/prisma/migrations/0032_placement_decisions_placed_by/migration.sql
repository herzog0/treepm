-- A criação do ticket pela conversa registra de que tipo foi a escolha do lugar (ADR 0054, adendo; TREEPM-361 e TREEPM-362):
-- o destino confirmado da procura, uma opção da pergunta, "fica aqui", um lugar recente ou o mapa. É diagnóstico: mostra quais
-- opções servem (TREEPM-358). Coluna nula (decisão sem criação, ou anterior a esta migration).
--
-- A decisão nunca é editada (a 0028 só dá UPDATE em ticket_id e conversation_id ao papel da aplicação), então a coluna nova
-- ganha o próprio GRANT de UPDATE, só nela. A API tolera a ausência da coluna (erro 42703): grava e lê como antes.
ALTER TABLE "placement_decisions"
  ADD COLUMN "placed_by" TEXT,
  ADD CONSTRAINT "placement_decisions_placed_by_check" CHECK ("placed_by" IN ('search', 'option', 'stay', 'recent', 'map'));

GRANT UPDATE ("placed_by") ON TABLE placement_decisions TO treepm_app;
