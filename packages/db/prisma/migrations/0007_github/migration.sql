-- Ligação com o GitHub (ADR 0032). Uma migration para os três passos da entrega: a instalação da organização,
-- os repositórios ligados a cada projeto, os vínculos de código dos tickets (passo 2) e as marcas de
-- sincronização por página (passo 2). Nenhum token e nenhum conteúdo de arquivo é guardado em tabela nenhuma.

-- CreateTable
CREATE TABLE "github_installations" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    -- O identificador da instalação no GitHub (inteiro de 64 bits).
    "installation_id" BIGINT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "repository_selection" TEXT NOT NULL,
    "connected_by_person_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "github_installations_account_login_check" CHECK (char_length("account_login") > 0),
    CONSTRAINT "github_installations_account_type_check" CHECK (char_length("account_type") > 0),
    CONSTRAINT "github_installations_repository_selection_check" CHECK ("repository_selection" IN ('all', 'selected'))
);

-- CreateTable
CREATE TABLE "project_repositories" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "installation_row_id" UUID NOT NULL,
    -- O identificador do repositório no GitHub e o retrato dele no momento da ligação.
    "repo_id" BIGINT NOT NULL,
    "full_name" TEXT NOT NULL,
    "html_url" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "default_branch" TEXT NOT NULL,
    "linked_by_person_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("org_id","id")
);

-- CreateTable
CREATE TABLE "ticket_code_links" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "project_repository_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    -- Nome do branch; para pull request, o branch de origem.
    "ref" TEXT NOT NULL,
    -- Número do pull request (nulo no branch).
    "number" INTEGER,
    "title" TEXT,
    "state" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "provider_updated_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ticket_code_links_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "ticket_code_links_kind_check" CHECK ("kind" IN ('branch', 'pull_request')),
    CONSTRAINT "ticket_code_links_ref_check" CHECK (char_length("ref") > 0),
    -- Só o pull request tem número, título e data do provedor.
    CONSTRAINT "ticket_code_links_number_check" CHECK (
        ("kind" = 'branch' AND "number" IS NULL AND "title" IS NULL AND "provider_updated_at" IS NULL)
        OR ("kind" = 'pull_request' AND "number" IS NOT NULL AND "number" >= 1 AND "provider_updated_at" IS NOT NULL)
    ),
    -- Branch só existe ativo (branch removido some); pull request é aberto, mesclado ou fechado.
    CONSTRAINT "ticket_code_links_state_check" CHECK (
        ("kind" = 'branch' AND "state" = 'active')
        OR ("kind" = 'pull_request' AND "state" IN ('open', 'merged', 'closed'))
    )
);

-- CreateTable
CREATE TABLE "repository_sync_pages" (
    "org_id" TEXT NOT NULL,
    "project_repository_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "etag" TEXT,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_sync_pages_pkey" PRIMARY KEY ("org_id","project_repository_id","resource","page"),
    CONSTRAINT "repository_sync_pages_resource_check" CHECK ("resource" IN ('branches', 'pulls')),
    CONSTRAINT "repository_sync_pages_page_check" CHECK ("page" >= 1)
);

-- CreateIndex: uma organização do TreePM tem no máximo uma instalação.
CREATE UNIQUE INDEX "github_installations_org_id_key" ON "github_installations"("org_id");

-- CreateIndex: uma instalação do GitHub pertence a no máximo uma organização do TreePM. A unicidade é GLOBAL:
-- o índice enxerga as linhas de todas as organizações, mesmo com a RLS escondendo-as da que tenta gravar.
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_org_id_project_id_repo_id_key" ON "project_repositories"("org_id", "project_id", "repo_id");

-- CreateIndex (alvo da chave estrangeira do vínculo: o repositório é do projeto do ticket)
CREATE UNIQUE INDEX "project_repositories_org_id_project_id_id_key" ON "project_repositories"("org_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "project_repositories_org_id_installation_row_id_idx" ON "project_repositories"("org_id", "installation_row_id");

-- CreateIndex: um branch se liga uma vez a um ticket em cada repositório.
CREATE UNIQUE INDEX "ticket_code_links_branch_key" ON "ticket_code_links"("org_id", "project_repository_id", "ticket_id", "kind", "ref") WHERE "kind" = 'branch';

-- CreateIndex: um pull request se liga uma vez a um ticket em cada repositório.
CREATE UNIQUE INDEX "ticket_code_links_pull_request_key" ON "ticket_code_links"("org_id", "project_repository_id", "ticket_id", "number") WHERE "kind" = 'pull_request';

-- CreateIndex
CREATE INDEX "ticket_code_links_org_id_ticket_id_idx" ON "ticket_code_links"("org_id", "ticket_id");

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (remover quem conectou só desfaz a referência; a lista de colunas em SET NULL exige PostgreSQL 15+
-- e o Prisma não a modela, então a ação vive só aqui, como na migration 0005)
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_connected_by_person_id_fkey" FOREIGN KEY ("org_id", "connected_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE SET NULL ("connected_by_person_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_org_id_installation_row_id_fkey" FOREIGN KEY ("org_id", "installation_row_id") REFERENCES "github_installations"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_org_id_linked_by_person_id_fkey" FOREIGN KEY ("org_id", "linked_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE SET NULL ("linked_by_person_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_code_links" ADD CONSTRAINT "ticket_code_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (o ticket é do projeto informado; remover o ticket remove o vínculo)
ALTER TABLE "ticket_code_links" ADD CONSTRAINT "ticket_code_links_org_id_project_id_ticket_id_fkey" FOREIGN KEY ("org_id", "project_id", "ticket_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (o repositório é do mesmo projeto do ticket; desligar o repositório remove o vínculo)
ALTER TABLE "ticket_code_links" ADD CONSTRAINT "ticket_code_links_org_id_project_id_project_repository_id_fkey" FOREIGN KEY ("org_id", "project_id", "project_repository_id") REFERENCES "project_repositories"("org_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_sync_pages" ADD CONSTRAINT "repository_sync_pages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_sync_pages" ADD CONSTRAINT "repository_sync_pages_org_id_project_repository_id_fkey" FOREIGN KEY ("org_id", "project_repository_id") REFERENCES "project_repositories"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON github_installations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE project_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_repositories
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_code_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_code_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_code_links
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE repository_sync_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_sync_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repository_sync_pages
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE github_installations, project_repositories, ticket_code_links, repository_sync_pages TO treepm_app;
