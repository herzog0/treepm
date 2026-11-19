// Defaults apontam para o contêiner de teste (docker-compose.test.yml).
// Só a configuração de teste os define; a aplicação lê DATABASE_URL.
export const OWNER_URL =
  process.env["TEST_DATABASE_MIGRATION_URL"] ??
  "postgresql://treepm_owner:treepm_owner_test@127.0.0.1:54329/treepm_test";
export const APP_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgresql://treepm_app:treepm_app_test@127.0.0.1:54329/treepm_test";
export const APP_PASSWORD = "treepm_app_test";
