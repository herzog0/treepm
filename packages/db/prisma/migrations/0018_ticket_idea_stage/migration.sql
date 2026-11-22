-- Estágio de ideia (ADR 0042, fatia 1): coluna opcional em `tickets`. Só a raiz de uma ideia tem estágio; o que está
-- embaixo dela faz parte da ideia por estar ali, sem campo próprio. Nenhuma tabela nova.

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "idea_stage" TEXT;

-- As quatro opções: new | refining | ready | discarded. Sem estágio (NULL), é um ticket comum.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_idea_stage_check" CHECK (idea_stage IN ('new', 'refining', 'ready', 'discarded'));

-- Raiz de ideia fica sempre em "a fazer": a situação de uma ideia não anda (ADR 0042).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_idea_stage_todo_check" CHECK (idea_stage IS NULL OR status = 'todo');

-- CreateIndex (listar as ideias de um projeto da mais antiga para a mais nova; parcial, só as raízes de ideia)
CREATE INDEX "tickets_ideas_idx" ON "tickets"("org_id", "project_id", "created_at", "id") WHERE idea_stage IS NOT NULL;

-- A concessão de `tickets` ao papel da aplicação é da tabela inteira (migration 0004); a coluna nova já vem incluída.
