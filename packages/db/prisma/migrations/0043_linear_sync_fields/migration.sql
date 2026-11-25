-- Sincronizar com o Linear, fatia 1 (ADR 0061, seções 1, 2 e 4; TREEPM-489). Só acrescenta; nenhuma linha existente muda e nada é preenchido
-- aqui: os valores chegam na próxima sincronização.
--
-- Atributos que o Linear guarda da issue e que o TreePM mostra na página do ticket, na ORIGEM (`ticket_external_refs`) e não no ticket:
-- `tickets.created_at` e `created_by_person_id` continuam sendo os do TreePM (ordenações e linha do tempo dependem deles).
--   * `external_created_at`, `external_started_at`, `external_completed_at`, `external_canceled_at`: as datas do Linear (nulas se não houver).
--   * `external_previous_keys`: os identificadores que a issue teve (trocou de time); a barra de busca da tela os acha: a lista de tickets do projeto traz as chaves (`externalKeys`, só para a tela; nunca ao MCP, ao assistente nem à Voyage), e a busca compara a chave inteira, sem diferenciar maiúsculas.
--   * `external_creator_id`: o id do usuário criador no Linear (nunca o e-mail).
--   * `creator_person_id`: a pessoa do TreePM que casou por e-mail único (mesma regra do responsável); sai da origem se a pessoa sair.
--   * `external_creator_name`: o nome de exibição do criador no Linear, guardado SÓ quando não há pessoa casada (com pessoa casada o nome
--     vem dela). É dado pessoal novo no banco; o e-mail do Linear continua não sendo guardado.

ALTER TABLE "ticket_external_refs"
  ADD COLUMN "external_created_at" TIMESTAMPTZ(3),
  ADD COLUMN "external_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "external_completed_at" TIMESTAMPTZ(3),
  ADD COLUMN "external_canceled_at" TIMESTAMPTZ(3),
  ADD COLUMN "external_previous_keys" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "external_creator_id" TEXT,
  ADD COLUMN "external_creator_name" TEXT,
  ADD COLUMN "creator_person_id" UUID;

-- A lista de colunas em SET NULL exige PostgreSQL 15+: o `org_id` da linha não pode ser zerado junto (como `destination_ticket_id`).
ALTER TABLE "ticket_external_refs" ADD CONSTRAINT "ticket_external_refs_creator_fkey" FOREIGN KEY ("org_id", "creator_person_id") REFERENCES "people"("org_id", "id") ON DELETE SET NULL ("creator_person_id") ON UPDATE CASCADE;
CREATE INDEX "ticket_external_refs_creator_idx" ON "ticket_external_refs"("org_id", "creator_person_id") WHERE "creator_person_id" IS NOT NULL;
