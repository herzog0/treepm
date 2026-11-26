-- Etiquetas por projeto (ADR 0065; TREEPM-466), fatia 1. Só acrescenta: nenhum valor existente muda.
--
-- 1. `project_labels`: a lista de etiquetas de cada projeto. Nome de 1 a 60 pontos de código (o `char_length`), já aparado e sem
--    controle, quebra de linha, formato invisível (zero-width, hífen suave, BOM) nem controle de direção (o domínio limpa antes:
--    `cleanLabelName`; o CHECK é a segunda trava, conferido contra o domínio pela lista `LABEL_NAME_CASES`). A chave tem até 240: a
--    NFKC expande (um "ﷺ" vira 18), e o domínio recusa o nome cuja chave passaria disso (`labelNameRefused`). `name_key` é a chave de
--    unicidade sem diferenciar maiúsculas, PREENCHIDA PELO DOMÍNIO (`labelNameKey`: NFKC e minúsculas sem localidade), e não um
--    `lower()` gerado: o `lower()` do Postgres depende da localidade do banco (o de teste e o de produção podem diferir, e com `C` ele
--    só baixa ASCII), e a tela precisa decidir "já existe" exatamente como o banco. Cor: uma das oito chaves da paleta (ADR 0065, seção 2).
--    Os limites de 20 por ticket e 200 por projeto são do domínio e da API, não do banco.
-- 2. `ticket_labels`: as etiquetas de cada ticket. A chave estrangeira composta (org, projeto, etiqueta) com o projeto do ticket
--    garante que a etiqueta é do MESMO projeto do ticket. Some com o ticket e com a etiqueta (cascata).
-- 3. `project_label_origins`: a origem de uma etiqueta do projeto no Linear (id da etiqueta de lá, nome e cor aplicados). Tabela própria,
--    no molde da ligação do projeto com o time (`project_external_sources`) e da origem do ticket (`ticket_external_refs`), e não colunas
--    em `project_labels`: a origem SOBREVIVE à etiqueta. Apagar a etiqueta aqui zera `label_id` (e a aplicação marca `removed_here_at`),
--    e a sincronização não a faz renascer. Única por projeto (a mesma etiqueta de workspace do Linear pode estar em dois projetos).
-- 4. `external_item_refs.kind` ganha `label`: o vínculo ticket↔etiqueta trazido do Linear (ADR 0061, seção 3). `external_id` é
--    `<issue>:<etiqueta>` do Linear; `local_id` é a etiqueta daqui.

-- ---- project_labels ----

CREATE TABLE "project_labels" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_labels_pkey" PRIMARY KEY ("org_id", "id"),
    CONSTRAINT "project_labels_name_check" CHECK (
      char_length("name") BETWEEN 1 AND 60
      AND "name" = btrim("name")
      AND "name" !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'
    ),
    CONSTRAINT "project_labels_name_key_check" CHECK (char_length("name_key") BETWEEN 1 AND 240),
    CONSTRAINT "project_labels_color_check" CHECK ("color" IN ('gray', 'brown', 'orange', 'olive', 'cyan', 'indigo', 'violet', 'rose'))
);

CREATE UNIQUE INDEX "project_labels_name_key" ON "project_labels"("org_id", "project_id", "name_key");
-- Alvo das chaves estrangeiras compostas (etiqueta do mesmo projeto).
CREATE UNIQUE INDEX "project_labels_project_id_key" ON "project_labels"("org_id", "project_id", "id");

ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_project_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE project_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_labels
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Privilégio mínimo: o UPDATE só em nome, chave, cor e data; nunca o projeto nem o id.
GRANT SELECT, INSERT, DELETE ON TABLE project_labels TO treepm_app;
GRANT UPDATE ("name", "name_key", "color", "updated_at") ON TABLE project_labels TO treepm_app;

-- ---- ticket_labels ----

CREATE TABLE "ticket_labels" (
    "org_id" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_labels_pkey" PRIMARY KEY ("org_id", "ticket_id", "label_id")
);

-- Quantos tickets usam cada etiqueta (configurações) e a cascata ao apagar a etiqueta.
CREATE INDEX "ticket_labels_label_idx" ON "ticket_labels"("org_id", "label_id");
-- As etiquetas de todos os tickets de um projeto numa consulta (a lista da tela).
CREATE INDEX "ticket_labels_project_idx" ON "ticket_labels"("org_id", "project_id");

ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- O projeto do vínculo é o do ticket (ON UPDATE CASCADE como as outras ligações ao ticket: se um dia o ticket mudar de projeto, a chave da
-- etiqueta abaixo faz a mudança FALHAR enquanto houver etiqueta, em vez de deixar uma etiqueta de outro projeto pendurada).
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_ticket_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_label_fkey" FOREIGN KEY ("org_id", "project_id", "label_id") REFERENCES "project_labels"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE ticket_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_labels
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Põe e tira; não há o que atualizar num vínculo.
GRANT SELECT, INSERT, DELETE ON TABLE ticket_labels TO treepm_app;

-- ---- project_label_origins ----

CREATE TABLE "project_label_origins" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "label_id" UUID,
    "applied_name" TEXT NOT NULL,
    "applied_color" TEXT NOT NULL,
    "removed_here_at" TIMESTAMPTZ(3),
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_label_origins_pkey" PRIMARY KEY ("org_id", "id"),
    CONSTRAINT "project_label_origins_provider_check" CHECK ("provider" IN ('linear')),
    CONSTRAINT "project_label_origins_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 100),
    CONSTRAINT "project_label_origins_applied_name_check" CHECK (char_length("applied_name") BETWEEN 1 AND 60),
    CONSTRAINT "project_label_origins_applied_color_check" CHECK ("applied_color" IN ('gray', 'brown', 'orange', 'olive', 'cyan', 'indigo', 'violet', 'rose')),
    CONSTRAINT "project_label_origins_removed_check" CHECK ("removed_here_at" IS NULL OR "label_id" IS NULL)
);

CREATE UNIQUE INDEX "project_label_origins_external_key" ON "project_label_origins"("org_id", "project_id", "provider", "external_id");
CREATE INDEX "project_label_origins_label_idx" ON "project_label_origins"("org_id", "label_id");

ALTER TABLE "project_label_origins" ADD CONSTRAINT "project_label_origins_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_label_origins" ADD CONSTRAINT "project_label_origins_project_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Apagar a etiqueta zera SÓ `label_id` (lista de colunas do SET NULL, Postgres 15+); a origem fica para lembrar.
ALTER TABLE "project_label_origins" ADD CONSTRAINT "project_label_origins_label_fkey" FOREIGN KEY ("org_id", "project_id", "label_id") REFERENCES "project_labels"("org_id", "project_id", "id") ON DELETE SET NULL ("label_id") ON UPDATE RESTRICT;

ALTER TABLE project_label_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_label_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_label_origins
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Sem DELETE (some com o projeto); o UPDATE só no estado, nunca no id externo nem no projeto.
GRANT SELECT, INSERT ON TABLE project_label_origins TO treepm_app;
GRANT UPDATE ("label_id", "applied_name", "applied_color", "removed_here_at", "last_imported_at") ON TABLE project_label_origins TO treepm_app;

-- ---- external_item_refs ----

ALTER TABLE "external_item_refs" DROP CONSTRAINT "external_item_refs_kind_check";
ALTER TABLE "external_item_refs" ADD CONSTRAINT "external_item_refs_kind_check" CHECK ("kind" IN ('comment', 'relation', 'label'));
