// Subpath `@treepm/db/testing`: utilitários de teste (contêiner Docker de teste).
// Só testes importam este arquivo; ele não faz parte do build de produção.
export { APP_PASSWORD, APP_URL, OWNER_URL } from "./env.js";
export { setupTestDatabase } from "./setup-database.js";
export { ORG_A, ORG_B, appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
export type { Ids } from "./helpers.js";
