-- Comentários por área (ADR 0041, fatia 2). Um comentário é do ticket (`contribution_id` nulo) ou de uma contribuição de
-- área do mesmo ticket. Comentário de área é contextual, não privado: quem vê o ticket vê todos.

-- AlterTable
ALTER TABLE "ticket_comments" ADD COLUMN "contribution_id" UUID, ADD COLUMN "area_name" TEXT;

-- CreateIndex (alvo da referência composta: garante que a contribuição é do mesmo ticket do comentário)
CREATE UNIQUE INDEX "ticket_contributions_org_id_ticket_id_id_key" ON "ticket_contributions"("org_id", "ticket_id", "id");

-- CreateIndex (ler os comentários de uma contribuição em ordem de tempo)
CREATE INDEX "ticket_comments_org_id_contribution_id_created_at_id_idx" ON "ticket_comments"("org_id", "contribution_id", "created_at", "id");

-- AddForeignKey (a contribuição tem de ser do mesmo ticket; remover a contribuição não apaga o comentário: só zera
-- `contribution_id`, e o nome da área já foi guardado pelo gatilho abaixo)
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_ticket_id_contribution_id_fkey" FOREIGN KEY ("org_id", "ticket_id", "contribution_id") REFERENCES "ticket_contributions"("org_id", "ticket_id", "id") ON DELETE SET NULL ("contribution_id") ON UPDATE CASCADE;

-- Antes de apagar uma contribuição, os comentários dela guardam o nome da área que tinham. Roda com os privilégios do
-- dono (o papel da aplicação não tem UPDATE em `area_name` nem em `contribution_id`), dentro da transação do DELETE e sob
-- a mesma RLS (a organização da sessão). Vale também para a cascata da exclusão do ticket, onde os comentários vão junto.
CREATE FUNCTION keep_area_name_on_contribution_delete() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE ticket_comments
     SET area_name = (SELECT a.name FROM areas a WHERE a.org_id = OLD.org_id AND a.id = OLD.area_id)
   WHERE org_id = OLD.org_id AND contribution_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION keep_area_name_on_contribution_delete() FROM PUBLIC;

CREATE TRIGGER ticket_contributions_keep_area_name
  BEFORE DELETE ON ticket_contributions
  FOR EACH ROW EXECUTE FUNCTION keep_area_name_on_contribution_delete();

-- Privilégio: nenhum UPDATE novo. `contribution_id` só é definido na criação (INSERT), e `area_name` só é gravado pelo
-- gatilho; a concessão de UPDATE em ticket_comments continua só (body, edited_at, removed_at, removed_by_person_id).
