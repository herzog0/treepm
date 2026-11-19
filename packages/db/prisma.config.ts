import { defineConfig } from "prisma/config";

// O CLI (migrate, generate) usa a conexão direta do papel dono.
// O cliente em tempo de execução usa DATABASE_URL (papel treepm_app).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_MIGRATION_URL"] ?? "" },
});
