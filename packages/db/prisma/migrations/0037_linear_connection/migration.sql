-- Conexão com o Linear (ADR 0060, fatia 1; TREEPM-428). Só cria tabelas novas: não toca nenhuma linha existente.
--
-- `external_credentials`: a chave de API de um provedor externo, UMA por pessoa e provedor. O segredo é guardado cifrado pela aplicação
-- (AES-256-GCM; nonce aleatório por gravação; organização, pessoa e provedor como dado autenticado, de modo que uma linha copiada para
-- outra pessoa não decifra). `key_version` diz com qual versão da chave de cifra a linha foi gravada. A pessoa pode substituir e remover
-- a própria chave, então a aplicação tem SELECT, INSERT, UPDATE e DELETE.
--
-- `project_external_sources`: a ligação PERMANENTE de um projeto com um time do provedor. O que não pode se perder é a correspondência
-- entre tickets e issues; por isso o papel da aplicação só recebe SELECT e INSERT (sem UPDATE e sem DELETE): corrigir uma ligação
-- errada exige intervenção no banco, de propósito. O mesmo time não se liga a dois projetos da organização.

CREATE TABLE "external_credentials" (
    "org_id" TEXT NOT NULL,
    "person_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_nonce" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "external_workspace_id" TEXT NOT NULL,
    "external_workspace_name" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_credentials_pkey" PRIMARY KEY ("org_id","person_id","provider"),
    CONSTRAINT "external_credentials_provider_check" CHECK ("provider" IN ('linear')),
    CONSTRAINT "external_credentials_nonce_check" CHECK (octet_length("secret_nonce") = 12),
    CONSTRAINT "external_credentials_key_version_check" CHECK ("key_version" >= 1),
    CONSTRAINT "external_credentials_hint_check" CHECK (char_length("secret_hint") BETWEEN 1 AND 4)
);

ALTER TABLE "external_credentials" ADD CONSTRAINT "external_credentials_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Remover a pessoa remove a credencial dela.
ALTER TABLE "external_credentials" ADD CONSTRAINT "external_credentials_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE external_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_credentials
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE external_credentials TO treepm_app;

CREATE TABLE "project_external_sources" (
    "org_id" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_workspace_id" TEXT NOT NULL,
    "external_workspace_name" TEXT NOT NULL,
    "external_team_id" TEXT NOT NULL,
    "external_team_key" TEXT NOT NULL,
    "external_team_name" TEXT NOT NULL,
    "linked_by_person_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_external_sources_pkey" PRIMARY KEY ("org_id","project_id"),
    CONSTRAINT "project_external_sources_provider_check" CHECK ("provider" IN ('linear'))
);

-- O mesmo time do provedor não entra em dois projetos da organização.
CREATE UNIQUE INDEX "project_external_sources_team_key" ON "project_external_sources"("org_id", "provider", "external_workspace_id", "external_team_id");

ALTER TABLE "project_external_sources" ADD CONSTRAINT "project_external_sources_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT: o papel da aplicação tem DELETE em `projects`; apagar um projeto ligado não pode levar o vínculo junto (permanência no banco).
ALTER TABLE "project_external_sources" ADD CONSTRAINT "project_external_sources_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_external_sources" ADD CONSTRAINT "project_external_sources_org_id_linked_by_person_id_fkey" FOREIGN KEY ("org_id", "linked_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE project_external_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_external_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_external_sources
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Permanência no banco (ADR 0060, seção 2): só ler e inserir.
GRANT SELECT, INSERT ON TABLE project_external_sources TO treepm_app;
