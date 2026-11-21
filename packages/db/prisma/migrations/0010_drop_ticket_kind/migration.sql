-- Um só tipo de ticket (ADR 0034, passo 2 de 2): remove as colunas do tipo antigo.
-- O código novo (PR #78) não lê nem grava `kind` nem `parent_kind`; a migration 0009 já tirou `parent_kind` da chave
-- estrangeira do pai. Aqui saem `parent_kind`, `kind` (com a CHECK dela) e o índice único que só servia à chave antiga.
-- Sem mudança de RLS nem de GRANT.

-- DropColumn: `parent_kind` (a CHECK dela já saiu na 0009).
ALTER TABLE "tickets" DROP COLUMN "parent_kind";

-- DropIndex: alvo da chave estrangeira antiga (org_id, project_id, id, kind). Tem que sair antes da coluna `kind`.
DROP INDEX "tickets_org_id_project_id_id_kind_key";

-- DropColumn: `kind` e a CHECK `tickets_kind_check`, que sai junto com a coluna.
ALTER TABLE "tickets" DROP COLUMN "kind";
