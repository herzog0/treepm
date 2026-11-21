-- Texto fixo do agrupador (ADR 0033). O resumo guardado deixa de ser só cache da IA: a pessoa também pode escrevê-lo.
-- `source` diz quem escreveu por último; `model` só existe quando foi a IA; `edited_by_person_id` é a pessoa que
-- escreveu o texto (nulo quando quem escreveu foi a IA). As linhas que já existem foram escritas pela IA.
-- Sem mudança de RLS nem de GRANT: a tabela e as políticas são as da migration 0005.

-- AlterTable
ALTER TABLE "branch_summaries" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'assistant';
ALTER TABLE "branch_summaries" ADD COLUMN "edited_by_person_id" UUID;
ALTER TABLE "branch_summaries" ALTER COLUMN "model" DROP NOT NULL;

-- AddCheck
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_source_check" CHECK ("source" IN ('assistant', 'person'));

-- AddCheck: modelo nulo se e só se quem escreveu foi a pessoa.
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_model_source_check" CHECK (("model" IS NULL) = ("source" = 'person'));

-- O texto escrito pela pessoa vai até 1000 caracteres; a IA continua escrevendo até 600 (limite do resumidor, na API).
ALTER TABLE "branch_summaries" DROP CONSTRAINT "branch_summaries_summary_check";
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_summary_check" CHECK (char_length("summary") BETWEEN 1 AND 1000);

-- AddForeignKey (remover quem editou só desfaz a referência; a lista de colunas em SET NULL exige PostgreSQL 15+ e o
-- Prisma não a modela, então a ação vive só aqui, como nas migrations 0005 e 0007)
ALTER TABLE "branch_summaries" ADD CONSTRAINT "branch_summaries_org_id_edited_by_person_id_fkey" FOREIGN KEY ("org_id", "edited_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE SET NULL ("edited_by_person_id") ON UPDATE CASCADE;
