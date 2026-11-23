/**
 * Custo por caminho das mudanças de estrutura (TREEPM-261): para cada caminho (mover, criar com pai, remover, aceitar, descartar,
 * transformar em ideia e mudar a situação), quantas consultas faz, quantas linhas devolve, quanto tempo dura a transação e quanto
 * tempo a trava de estrutura fica segura (do fim do `pg_advisory_xact_lock` ao fim do COMMIT), com projetos de 5 000 e 20 000
 * tickets. Também refaz as leituras com `EXPLAIN (ANALYZE, BUFFERS)` e soma quantas linhas o executor leu e quantas varreduras
 * sequenciais de `tickets` houve, que é onde um custo proporcional ao projeto aparece mesmo sem voltar como linha.
 *
 *   TEST_DATABASE_MIGRATION_URL=…/treepm_p2 TEST_DATABASE_URL=…/treepm_p2 \
 *     pnpm --filter @treepm/api measure:structure-paths [--sizes 5000,20000] [--reps 15] [--seed 7] [--out <arquivo.json>]
 *
 * Uma requisição por vez, sem concorrência: mede o custo de um caminho, não a vazão. Só roda em `treepm_p<N>`/`treepm_test` (apaga as
 * organizações do banco a cada tamanho).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { assertMeasurementDatabase, loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "./big-project/load.js";
import { planBigProject } from "./big-project/plan.js";
import { buildPools } from "./concurrent-writes/plan.js";

const ownerUrl = process.env["TEST_DATABASE_MIGRATION_URL"];
const appUrl = process.env["TEST_DATABASE_URL"];
if (!ownerUrl || !appUrl) {
  console.error("Defina TEST_DATABASE_MIGRATION_URL e TEST_DATABASE_URL (o banco de medição). Recusando rodar sem elas.");
  process.exit(2);
}
assertMeasurementDatabase(ownerUrl);
assertMeasurementDatabase(appUrl);
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "5000,20000" },
    reps: { type: "string", default: "15" },
    seed: { type: "string", default: "7" },
    out: { type: "string", default: resolve(here, "../../../.measure/structure-paths/result.json") },
  },
});
const sizes = (values.sizes ?? "").split(",").map(Number);
const reps = Number(values.reps);
const seed = Number(values.seed);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const r1 = (x: number): number => Math.round(x * 10) / 10;

const { createTestApp, sessionHeader } = await import("../test/helpers.js");
const { recordTimed, lockTimes } = await import("../test/query-recorder.js");
const { explainReads } = await import("../test/explain-reads.js");
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const { app } = await createTestApp();
await app.listen(0, "127.0.0.1");
const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
const session = sessionHeader({ userId: PERF_ADMIN_USER, orgId: PERF_ORG, orgRole: "org:admin" });

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(base + path, { method, headers: { "x-test-session": session, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.text() };
}

const reader = new pg.Pool({ connectionString: appUrl, max: 1 });

type Sample = { status: number; requestMs: number; txMs: number; lockHeldMs: number | null; queries: number; rows: number; queryMs: number; scanned: number; seqTickets: number };
async function measure(run: () => Promise<{ status: number }>): Promise<Sample> {
  const started = performance.now();
  const { result, queries } = await recordTimed(run);
  const requestMs = performance.now() - started;
  const t = lockTimes(queries);
  const work = queries.filter((q) => !/^\s*(begin|commit|rollback)/i.test(q.text));
  const explained = await explainReads(reader, { orgId: PERF_ORG, userId: PERF_ADMIN_USER }, work);
  return { status: result.status, requestMs, txMs: t.txMs, lockHeldMs: t.lockHeldMs, queries: t.queryCount, rows: t.rows, queryMs: t.queryMs, scanned: explained.scanned, seqTickets: explained.seqScansOfTickets };
}

const results: Record<string, unknown> = {};
for (const n of sizes) {
  const plan = planBigProject({ n, seed, key: "BG", now: Date.now(), people: 80 });
  const pools = buildPools(plan);
  const pid = plan.projectId;
  await loadBigProject(owner, plan);
  await owner.query("analyze");
  const T = (i: number): string => plan.tickets[i]!.id;
  const parents = pools.inner.filter((_, i) => i % 3 === 0);
  const leaves = pools.leaves;
  const ideaRoots = plan.tickets.filter((t) => t.ideaStage !== null && t.ideaStage !== "discarded" && (t.parent === null || !plan.tickets[t.parent]!.ideaStage));
  let li = 0;
  const nextLeaf = (): number => leaves[li++ % leaves.length]!;
  const paths: Record<string, () => Promise<{ status: number }>> = {
    "mover folha": async () => { const leaf = nextLeaf(); return http("PATCH", `/api/tickets/${T(leaf)}`, { parentId: T(parents[(li * 7) % parents.length]!) }); },
    "criar com pai": async () => http("POST", `/api/projects/${pid}/tickets`, { title: `Medição ${li++}`, description: "Texto curto de medição.", parentId: T(parents[(li * 5) % parents.length]!) }),
    "mudar situação": async () => { const leaf = nextLeaf(); return http("PATCH", `/api/tickets/${T(leaf)}`, { status: "in_progress" }); },
  };
  const rows: Record<string, Sample[]> = {};
  for (const [name, run] of Object.entries(paths)) {
    rows[name] = [];
    for (let i = 0; i < reps; i += 1) rows[name]!.push(await measure(run));
  }
  // Remover: cria uma folha (fora da medição) e remove.
  rows["remover folha"] = [];
  for (let i = 0; i < reps; i += 1) {
    const made = await http("POST", `/api/projects/${pid}/tickets`, { title: `Para remover ${i}`, parentId: T(parents[i % parents.length]!) });
    const id = (JSON.parse(made.body) as { id: string }).id;
    rows["remover folha"]!.push(await measure(() => http("DELETE", `/api/tickets/${id}`)));
  }
  // Ideias: aceitar e descartar raízes (cada uma uma vez), transformar folhas em ideia.
  rows["aceitar ideia"] = [];
  rows["descartar ideia"] = [];
  const pool = [...ideaRoots];
  for (let i = 0; i < reps && pool.length > 1; i += 1) rows["aceitar ideia"]!.push(await measure(() => http("POST", `/api/tickets/${pool.shift()!.id}/idea/accept`)));
  for (let i = 0; i < reps && pool.length > 0; i += 1) rows["descartar ideia"]!.push(await measure(() => http("POST", `/api/tickets/${pool.shift()!.id}/idea/discard`)));
  rows["transformar em ideia"] = [];
  for (let i = 0; i < reps; i += 1) rows["transformar em ideia"]!.push(await measure(() => http("POST", `/api/tickets/${T(nextLeaf())}/idea`)));

  const table: Record<string, Record<string, number | null>> = {};
  for (const [name, samples] of Object.entries(rows)) {
    const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
    const bad = samples.filter((s) => s.status >= 300).map((s) => s.status);
    const lock = ok.map((s) => s.lockHeldMs).filter((x): x is number => x !== null);
    table[name] = {
      ok: ok.length, naoOk: bad.length,
      consultas: median(ok.map((s) => s.queries)), linhasDevolvidas: median(ok.map((s) => s.rows)),
      linhasLidas: median(ok.map((s) => s.scanned)), varreduras_seq_tickets: median(ok.map((s) => s.seqTickets)),
      transacaoMs: r1(median(ok.map((s) => s.txMs))), travaMs: lock.length ? r1(median(lock)) : null, consultasMs: r1(median(ok.map((s) => s.queryMs))),
    };
    console.log(`${n}\t${name}\t${JSON.stringify(table[name])}${bad.length ? `\t status ${[...new Set(bad)].join(",")}` : ""}`);
  }
  results[String(n)] = table;
}
mkdirSync(dirname(resolve(values.out as string)), { recursive: true });
writeFileSync(resolve(values.out as string), `${JSON.stringify(results, null, 2)}\n`);
await app.close();
await owner.end();
await reader.end();
