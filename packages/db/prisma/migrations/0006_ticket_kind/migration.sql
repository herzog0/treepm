-- Agrupadores (ADR 0031): cada nó é `ticket` ou `group`, e só `group` tem filhos.
-- O banco garante a regra: o tipo do pai faz parte da chave estrangeira do pai.

-- A chave estrangeira do pai será refeita com o tipo do pai.
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_org_id_project_id_parent_id_fkey";

-- Tipo do nó.
ALTER TABLE "tickets" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ticket';
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_kind_check" CHECK ("kind" IN ('ticket', 'group'));

-- Dados existentes: todo ticket que já tem filho vira agrupador. Nada é movido nem removido.
UPDATE "tickets" AS p SET "kind" = 'group'
WHERE EXISTS (
  SELECT 1 FROM "tickets" AS c
  WHERE c."org_id" = p."org_id" AND c."project_id" = p."project_id" AND c."parent_id" = p."id"
);

-- Tipo do pai: nulo se e só se não há pai, e sempre `group`. (`IS NOT NULL` explícito: um CHECK com resultado
-- desconhecido passa, e `parent_kind` nulo com pai tem que falhar.)
ALTER TABLE "tickets" ADD COLUMN "parent_kind" TEXT;
UPDATE "tickets" SET "parent_kind" = 'group' WHERE "parent_id" IS NOT NULL;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_kind_check" CHECK (
  ("parent_id" IS NULL AND "parent_kind" IS NULL) OR ("parent_id" IS NOT NULL AND "parent_kind" IS NOT NULL AND "parent_kind" = 'group')
);

-- CreateIndex (alvo da chave estrangeira do pai)
CREATE UNIQUE INDEX "tickets_org_id_project_id_id_kind_key" ON "tickets"("org_id", "project_id", "id", "kind");

-- AddForeignKey: o pai é do mesmo projeto e é um agrupador. `ON UPDATE RESTRICT` faz mudar para `ticket`
-- um agrupador que tem filhos falhar no banco, mesmo em requisições simultâneas.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_project_id_parent_id_parent_kind_fkey" FOREIGN KEY ("org_id", "project_id", "parent_id", "parent_kind") REFERENCES "tickets"("org_id", "project_id", "id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
