-- Tokens de acesso por pessoa e projeto (ADR 0038, fatia 1) e a chave "Permitir acesso por MCP" da organização.
-- Só o resumo SHA-256 do token é guardado; o token inteiro existe apenas na resposta da criação.

-- AlterTable (desligada por padrão; só um administrador liga)
ALTER TABLE "organizations" ADD COLUMN "mcp_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "access_tokens" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "person_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_tokens_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "access_tokens_name_check" CHECK (char_length("name") BETWEEN 1 AND 80)
);

-- CreateIndex (a busca pelo resumo; único no banco inteiro)
CREATE UNIQUE INDEX "access_tokens_token_hash_key" ON "access_tokens"("token_hash");

-- CreateIndex (tokens de uma pessoa e de um projeto)
CREATE INDEX "access_tokens_org_id_person_id_idx" ON "access_tokens"("org_id", "person_id");
CREATE INDEX "access_tokens_org_id_project_id_idx" ON "access_tokens"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (remover a pessoa remove os tokens dela)
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (remover o projeto remove os tokens dele)
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_tokens
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE access_tokens TO treepm_app;
