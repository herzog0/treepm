import { execFileSync } from "node:child_process";
import pg from "pg";
import { APP_PASSWORD, OWNER_URL } from "./env.js";

export default async function setup(): Promise<void> {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  try {
    await owner.connect();
  } catch (error) {
    throw new Error(
      "PostgreSQL de teste indisponível em 127.0.0.1:54329. " +
        "Suba o contêiner com `pnpm --filter @treepm/db db:test:up`. " +
        `Causa: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    // Banco limpo a cada execução, sem tocar no papel treepm_app (nível de cluster).
    await owner.query("drop schema if exists public cascade");
    await owner.query("create schema public");
  } finally {
    await owner.end();
  }

  // Migrações reais (nunca `db push`), pela conexão do papel dono.
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
  });

  // Em produção o papel é NOLOGIN; o setup de teste habilita login com senha.
  const after = new pg.Client({ connectionString: OWNER_URL });
  await after.connect();
  try {
    await after.query(`alter role treepm_app login password '${APP_PASSWORD}'`);
  } finally {
    await after.end();
  }
}
