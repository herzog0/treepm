/**
 * Gerador de projeto grande (TREEPM-191): cria, no PostgreSQL de teste de medição, uma organização com um projeto de N tickets
 * em árvore realista, determinístico pela semente. Parte pura em `big-project/plan.ts`, gravação em lote em `big-project/load.ts`.
 *
 *   TEST_DATABASE_MIGRATION_URL=postgresql://…/treepm_p1 pnpm --filter @treepm/api big-project:generate --n 5000 [--seed 7] [--key BG] [--setup-db]
 *
 * Só aceita bancos `treepm_p<N>` ou `treepm_test`, e APAGA todas as organizações do banco antes de gravar. `--setup-db` recria
 * o schema e aplica as migrações (como os testes de banco fazem), para um banco vazio. Sem a variável, recusa rodar.
 */
import pg from "pg";
import { parseArgs } from "node:util";
import { assertMeasurementDatabase, loadBigProject } from "./big-project/load.js";
import { planBigProject } from "./big-project/plan.js";

const { values } = parseArgs({ options: { n: { type: "string", default: "1000" }, seed: { type: "string", default: "7" }, key: { type: "string", default: "BG" }, "setup-db": { type: "boolean", default: false } } });
const url = process.env["TEST_DATABASE_MIGRATION_URL"];
if (!url) {
  console.error("Defina TEST_DATABASE_MIGRATION_URL (o banco de medição, papel dono). Recusando rodar sem ela.");
  process.exit(2);
}
assertMeasurementDatabase(url);
const n = Number(values.n);
const seed = Number(values.seed);
if (!Number.isInteger(n) || n < 100 || !Number.isInteger(seed)) {
  console.error("Uso: big-project:generate --n <inteiro ≥ 100> [--seed <inteiro>] [--key BG] [--setup-db]");
  process.exit(2);
}
if (values["setup-db"]) {
  const { setupTestDatabase } = await import("@treepm/db/testing");
  await setupTestDatabase();
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const plan = planBigProject({ n, seed, key: values.key ?? "BG", now: Date.now() });
  const summary = await loadBigProject(pool, plan);
  console.log(JSON.stringify({ ...summary, fixtures: plan.fixtures }, null, 2));
} finally {
  await pool.end();
}
