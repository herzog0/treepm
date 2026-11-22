-- MCP com escrita e marcador de trabalho pela IA (ADR 0043, fatias 1 e 2).
-- Atenção à ordem de publicação: o caminho da sessão e o do token passam a ler `mcp_write_enabled`, então esta migration
-- precisa estar aplicada antes do código novo.

-- Alcance do token (ADR 0043): `read` (padrão) ou `write`. Os tokens que já existem ficam `read`; o alcance não muda depois.
ALTER TABLE "access_tokens" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'read';
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scope_check" CHECK (scope IN ('read', 'write'));

-- Segunda chave da organização, "Permitir escrita por MCP": desligada por padrão; só um administrador liga.
ALTER TABLE "organizations" ADD COLUMN "mcp_write_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Marcador de trabalho pela IA no ticket: desde quando, até quando, por qual pessoa (a do token) e a nota (vazia = sem nota).
-- Os quatro andam juntos. O marcador "vale" quando `agent_work_until` é futuro; vencido, ele só deixa de valer (ninguém limpa).
ALTER TABLE "tickets"
  ADD COLUMN "agent_work_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "agent_work_until" TIMESTAMPTZ(3),
  ADD COLUMN "agent_work_person_id" UUID,
  ADD COLUMN "agent_work_note" TEXT;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_work_together_check" CHECK (
  (agent_work_started_at IS NULL AND agent_work_until IS NULL AND agent_work_person_id IS NULL AND agent_work_note IS NULL)
  OR
  (agent_work_started_at IS NOT NULL AND agent_work_until IS NOT NULL AND agent_work_person_id IS NOT NULL AND agent_work_note IS NOT NULL)
);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_work_note_check" CHECK (agent_work_note IS NULL OR char_length(agent_work_note) <= 200);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_work_window_check" CHECK (agent_work_until IS NULL OR agent_work_until > agent_work_started_at);
-- Ticket concluído ou cancelado não tem marcador (a aplicação o limpa na MESMA instrução que muda a situação; o banco é a última guarda).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_work_not_finished_check" CHECK (agent_work_until IS NULL OR status NOT IN ('done', 'cancelled'));

-- A pessoa do marcador não some enquanto o marcador existe (a pessoa nunca é removida de fato; o RESTRICT garante).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_agent_work_person_id_fkey" FOREIGN KEY ("org_id", "agent_work_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quem escreveu o comentário foi o MCP? Guardado no próprio comentário (e não só no evento) porque a atividade lê os
-- comentários da tabela dele; assim continua certo depois de o token ser revogado ou apagado. Sem chave para `access_tokens`.
ALTER TABLE "ticket_comments" ADD COLUMN "via" TEXT;
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_via_check" CHECK (via IS NULL OR via = 'mcp');

-- Repetição de `add_comment` (revisão 1): o token (id do registro, sem chave estrangeira) e o `requestId` que o cliente mandou,
-- para uma segunda chamada igual, em até 10 minutos, devolver o mesmo comentário. Só o mínimo; nunca vai a log.
ALTER TABLE "ticket_comments" ADD COLUMN "request_token_id" UUID, ADD COLUMN "request_id" TEXT;
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_request_check" CHECK (
  (request_token_id IS NULL AND request_id IS NULL) OR (request_token_id IS NOT NULL AND request_id IS NOT NULL AND request_id ~ '^[A-Za-z0-9_-]{8,64}$')
);
CREATE INDEX "ticket_comments_request_idx" ON "ticket_comments"("org_id", "ticket_id", "request_token_id", "request_id") WHERE request_id IS NOT NULL;

-- Concessões do papel da aplicação: `organizations`, `tickets`, `access_tokens` têm concessão da tabela inteira
-- (migrations 0002, 0004 e 0012) e `ticket_comments` tem INSERT da tabela inteira (0015); as colunas novas já vêm incluídas.
-- O UPDATE de `ticket_comments` continua só nas colunas que já tinha: o `via` nunca muda depois de gravado.
