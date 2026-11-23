-- A decisão da procura de lugar fica guardada (ADR 0052, item 5; TREEPM-328). Uma linha por conversa de novo ticket:
-- o rastro da última procura, SÓ com identificadores e números (probabilidades, ids de ticket, motivo da parada). Nenhum título,
-- trecho de descrição, rascunho ou texto de conversa entra aqui, nem em `levels`: a API valida a forma do JSON antes de gravar.
--
-- Vida da linha (decisão de retenção):
--   * enquanto a conversa existe, a linha é dela (`conversation_id`); uma nova procura na mesma conversa SUBSTITUI a anterior
--     (índice único parcial);
--   * apagar a conversa (descartar, ou a cascata de quem a escreveu ou do projeto) apaga a linha dela (CASCADE);
--   * ao criar o ticket, a API troca o dono na mesma transação: preenche `ticket_id` e zera `conversation_id`. A linha passa a
--     viver com o ticket: a conversa pode ser apagada depois sem levá-la, e apagar o ticket apaga a linha (CASCADE).
--   Conversa aberta e abandonada mantém a linha enquanto existir; não há agendador na API para expirar conversas.
CREATE TABLE "placement_decisions" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "conversation_id" UUID,
    "ticket_id" UUID,
    -- O que a descida decidiu: o caminho escolhido (ids, da raiz ao destino), as alternativas e por que parou.
    "chosen_path" UUID[] NOT NULL DEFAULT '{}',
    "alternatives" JSONB NOT NULL DEFAULT '[]',
    "uncertain" BOOLEAN NOT NULL,
    "stop_reason" TEXT,
    -- Escopo da procura (ticket) e a probabilidade de a conferência do escopo; nulos sem escopo.
    "scope_ticket_id" UUID,
    "scope_fit" DOUBLE PRECISION,
    -- Um elemento por pergunta feita ao juiz: { level, parentId, parentNumber, result, belongs, candidates: [{ ticketId, number, probability }] }; parentNumber é o número do pai (null na raiz).
    "levels" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_decisions_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "placement_decisions_stop_reason_check" CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('no_candidates','below_low','band','candidates_too_large','max_levels')),
    CONSTRAINT "placement_decisions_scope_fit_check" CHECK ("scope_fit" IS NULL OR ("scope_fit" >= 0 AND "scope_fit" <= 1)),
    CONSTRAINT "placement_decisions_levels_check" CHECK (jsonb_typeof("levels") = 'array' AND jsonb_typeof("alternatives") = 'array'),
    -- Sempre tem dono: a conversa ou o ticket criado (a API nunca grava uma linha sem nenhum dos dois).
    CONSTRAINT "placement_decisions_owner_check" CHECK ("conversation_id" IS NOT NULL OR "ticket_id" IS NOT NULL)
);

-- Uma linha por conversa (a procura nova substitui a anterior) e uma por ticket criado.
CREATE UNIQUE INDEX "placement_decisions_org_id_conversation_id_key" ON "placement_decisions"("org_id", "conversation_id") WHERE "conversation_id" IS NOT NULL;
CREATE UNIQUE INDEX "placement_decisions_org_id_ticket_id_key" ON "placement_decisions"("org_id", "ticket_id") WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "placement_decisions_org_id_project_id_idx" ON "placement_decisions"("org_id", "project_id");

ALTER TABLE "placement_decisions" ADD CONSTRAINT "placement_decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "placement_decisions" ADD CONSTRAINT "placement_decisions_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Apagar a conversa apaga a decisão que ainda é dela (a do ticket criado já trocou de dono e não passa por aqui).
ALTER TABLE "placement_decisions" ADD CONSTRAINT "placement_decisions_conversation_fkey" FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ticket_conversations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Remover o ticket criado remove a decisão.
ALTER TABLE "placement_decisions" ADD CONSTRAINT "placement_decisions_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE placement_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON placement_decisions
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo para `treepm_app`: cria, lê e apaga; só o dono muda (a decisão nunca é editada).
GRANT SELECT, INSERT, DELETE ON TABLE placement_decisions TO treepm_app;
GRANT UPDATE (ticket_id, conversation_id) ON TABLE placement_decisions TO treepm_app;
