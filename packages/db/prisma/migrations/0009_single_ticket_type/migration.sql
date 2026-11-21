-- Um só tipo de ticket (ADR 0034, primeira fatia, passo 1 de 2): todo ticket pode ter filhos.
-- Tira a exigência de `parent_kind` e a chave estrangeira que incluía o tipo do pai, e refaz a chave do pai só com
-- organização, projeto e ticket (mesmo comportamento de exclusão da migration 0004: ON DELETE RESTRICT).
-- As colunas `kind` e `parent_kind` FICAM, com os valores que têm: o servidor antigo ainda as lê e grava até a troca
-- do código. `kind` continua NOT NULL DEFAULT 'ticket' (com seu CHECK) e `parent_kind` continua aceitando nulo.
-- Uma migration seguinte removerá as duas colunas. Sem mudança de RLS nem de GRANT.

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_org_id_project_id_parent_id_parent_kind_fkey";

-- DropCheck: `parent_kind` deixa de ser exigido (nulo com pai passa; o servidor antigo ainda grava 'group').
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_parent_kind_check";

-- AddForeignKey: o pai é um ticket do mesmo projeto e da mesma organização. O índice único de que ela precisa
-- (org_id, project_id, id) já existe desde a migration 0004 (tickets_org_id_project_id_id_key).
-- ON UPDATE RESTRICT, como na 0006: nenhum código muda o id de um ticket.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_project_id_parent_id_fkey" FOREIGN KEY ("org_id", "project_id", "parent_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- O índice único tickets_org_id_project_id_id_kind_key (org_id, project_id, id, kind) FICA: era alvo da chave estrangeira
-- antiga, mas o servidor antigo não deve perder nada até a troca do código. A migration que remover as colunas `kind`
-- e `parent_kind` o remove junto.
