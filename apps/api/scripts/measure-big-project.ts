/**
 * Medição da API com um projeto grande (TREEPM-191). Para cada N, gera o projeto (`big-project/`), sobe a aplicação Nest de
 * teste (usuário falso das suítes, `x-test-session`) numa porta local e mede, pelo caminho HTTP de verdade, as operações do
 * mapa, do detalhe, da atividade, das ideias, das mudanças de situação e de pai e das leituras do MCP. Cada operação: um
 * aquecimento descartado e `--reps` repetições; mediana e pior caso em ms, bytes do corpo cru, consultas ao banco por requisição
 * (contadas no driver `pg`, sem tocar no produto) e, para as três mais lentas, `EXPLAIN (ANALYZE, BUFFERS)` das consultas
 * principais, rodado como `treepm_app` com o isolamento por organização.
 *
 *   TEST_DATABASE_MIGRATION_URL=…/treepm_p1 TEST_DATABASE_URL=…/treepm_p1 \
 *     pnpm --filter @treepm/api measure:big-project [--sizes 1000,5000,20000] [--reps 5] [--out <pasta>] [--seed 7] [--setup-db]
 *
 * Escreve em `--out` (padrão `<repositório>/.measure/big-project`, fora do Git): `results-<N>.json`, `explain-<N>.txt` e, para a
 * medição da web, `<N>/{projects,people,tickets}.json` (as respostas reais da API). Só roda em bancos `treepm_p<N>`/`treepm_test`.
 * Recusa rodar sem as duas variáveis de ambiente (sem elas os helpers cairiam em `treepm_test`, que as suítes recriam).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { assertMeasurementDatabase, loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "./big-project/load.js";
import { planBigProject } from "./big-project/plan.js";
import type { BigProjectPlan } from "./big-project/plan.js";

const ownerUrl = process.env["TEST_DATABASE_MIGRATION_URL"];
const appUrl = process.env["TEST_DATABASE_URL"];
if (!ownerUrl || !appUrl) {
  console.error("Defina TEST_DATABASE_MIGRATION_URL e TEST_DATABASE_URL (o banco de medição). Recusando rodar sem elas.");
  process.exit(2);
}
assertMeasurementDatabase(ownerUrl);
assertMeasurementDatabase(appUrl);
if (new URL(ownerUrl).pathname !== new URL(appUrl).pathname) {
  console.error("As duas URLs devem apontar para o mesmo banco.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "1000,5000,20000" },
    reps: { type: "string", default: "5" },
    out: { type: "string", default: resolve(here, "../../../.measure/big-project") },
    seed: { type: "string", default: "7" },
    "setup-db": { type: "boolean", default: false },
  },
});
const sizes = (values.sizes ?? "").split(",").map(Number);
const reps = Number(values.reps);
const seed = Number(values.seed);
const outDir = resolve(values.out as string);
if (sizes.some((n) => !Number.isInteger(n) || n < 100) || !Number.isInteger(reps) || reps < 1) {
  console.error("Uso: measure:big-project [--sizes 1000,5000,20000] [--reps 5] [--out <pasta>] [--seed 7] [--setup-db]");
  process.exit(2);
}

// ---- Contagem de consultas: o driver `pg` é o mesmo do adaptador do Prisma; só observamos, nada muda. ----
type Query = { text: string; values: unknown[]; ms: number };
let recording: Query[] | null = null;
{
  const original = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] };
    const text = typeof first === "string" ? first : (first?.text ?? "");
    const params = (typeof first === "string" ? args[1] : first?.values) as unknown[] | undefined;
    const started = performance.now();
    const result = original.apply(this, args) as Promise<unknown> | undefined;
    if (recording !== null && result && typeof result.then === "function") {
      const sink = recording;
      const done = () => sink.push({ text, values: params ?? [], ms: performance.now() - started });
      result.then(done, done);
    }
    return result;
  };
}

const isControl = (text: string): boolean => /^\s*(begin|commit|rollback|savepoint|release|start transaction)/i.test(text) || /set_config\('app\.org_id'/i.test(text);

interface Row {
  n: number;
  group: string;
  op: string;
  status: string;
  medianMs: number | null;
  worstMs: number | null;
  minMs: number | null;
  bytes: number | null;
  requests: number;
  queries: number | null;
  dbMs: number | null;
  note?: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const r1 = (x: number): number => Math.round(x * 10) / 10;
const loads = (): string => os.loadavg().map((x) => x.toFixed(2)).join(" / ");

const { createTestApp } = await import("../test/helpers.js");
const { sessionHeader } = await import("../test/helpers.js");
const { McpGateway } = await import("../src/mcp/mcp-gateway.js");
const { AccessTokenService } = await import("../src/access-tokens/access-token.service.js");

const session = sessionHeader({ userId: PERF_ADMIN_USER, orgId: PERF_ORG, orgRole: "org:admin" });
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const appPool = new pg.Pool({ connectionString: appUrl, max: 1 });
const { app } = await createTestApp();
await app.listen(0, "127.0.0.1");
const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");

interface Shot { ms: number; bytes: number; status: number; queries: Query[]; body: string }
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Shot> {
  const sink: Query[] = [];
  recording = sink;
  const started = performance.now();
  const res = await fetch(base + path, { method, headers: { "x-test-session": session, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const buffer = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - started;
  recording = null;
  return { ms, bytes: buffer.byteLength, status: res.status, queries: sink, body: buffer.toString("utf8") };
}

type Prepare = (rep: number) => Promise<void>;
const rows: Row[] = [];
const samples = new Map<string, Query[]>();

/** Aquecimento + `reps` repetições de `run`; `before` roda fora do cronômetro (restaura o estado das mutações). */
async function measure(n: number, group: string, op: string, run: (rep: number) => Promise<Shot | Shot[]>, before?: Prepare, okStatuses: number[] = [200]): Promise<Shot[]> {
  const shots: Shot[] = [];
  let failure: string | null = null;
  for (let rep = 0; rep <= reps; rep += 1) {
    await before?.(rep);
    app.get(McpGateway).resetMemory();
    app.get(AccessTokenService).resetMemory();
    const result = await run(rep);
    const group_ = Array.isArray(result) ? result : [result];
    const merged: Shot = {
      ms: group_.reduce((sum, s) => sum + s.ms, 0),
      bytes: group_.reduce((sum, s) => sum + s.bytes, 0),
      status: group_.find((s) => !okStatuses.includes(s.status))?.status ?? (group_[0] as Shot).status,
      queries: group_.flatMap((s) => s.queries),
      body: (group_[group_.length - 1] as Shot).body,
    };
    if (!okStatuses.includes(merged.status)) {
      failure = `HTTP ${merged.status}: ${merged.body.slice(0, 200)}`;
      break;
    }
    if (rep > 0) shots.push(merged);
  }
  if (failure !== null || shots.length === 0) {
    rows.push({ n, group, op, status: failure ?? "sem resposta", medianMs: null, worstMs: null, minMs: null, bytes: null, requests: 0, queries: null, dbMs: null });
    console.log(`  ✗ ${op}: ${failure}`);
    return shots;
  }
  const times = shots.map((s) => s.ms);
  const last = shots[shots.length - 1] as Shot;
  const data = last.queries.filter((q) => !isControl(q.text));
  rows.push({
    n, group, op, status: "ok",
    medianMs: r1(median(times)), worstMs: r1(Math.max(...times)), minMs: r1(Math.min(...times)),
    bytes: last.bytes, requests: 1,
    queries: data.length, dbMs: r1(data.reduce((sum, q) => sum + q.ms, 0)),
  });
  samples.set(`${n}|${op}`, last.queries);
  console.log(`  ${op.padEnd(46)} mediana ${String(r1(median(times))).padStart(8)} ms  pior ${String(r1(Math.max(...times))).padStart(8)} ms  ${String(last.bytes).padStart(9)} B  consultas ${data.length}`);
  return shots;
}

// ---- MCP ----
const MODERN = "2026-07-28";
const envelope = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "medicao", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
async function mcpTool(token: string, key: string, name: string, args: Record<string, unknown>): Promise<Shot & { data: Record<string, unknown> | null }> {
  const params = { name, arguments: args, _meta: envelope };
  const sink: Query[] = [];
  recording = sink;
  const started = performance.now();
  const res = await fetch(`${base}/api/mcp/${key}`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name, authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - started;
  recording = null;
  const text = buffer.toString("utf8");
  let data: Record<string, unknown> | null = null;
  let status = res.status;
  try {
    const parsed = JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean }; error?: unknown };
    data = parsed.result?.structuredContent ?? null;
    if (parsed.result?.isError || parsed.error) status = 599;
  } catch {
    status = 598;
  }
  return { ms, bytes: buffer.byteLength, status, queries: sink, body: text, data };
}

// ---- EXPLAIN ----
async function explain(query: Query): Promise<string> {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [PERF_ORG, PERF_ADMIN_USER]);
    const res = await c.query({ text: `EXPLAIN (ANALYZE, BUFFERS) ${query.text}`, values: query.values as never[] });
    return res.rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  } catch (error) {
    return `(sem plano: ${error instanceof Error ? error.message : String(error)})`;
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

mkdirSync(outDir, { recursive: true });
if (values["setup-db"]) {
  const { setupTestDatabase } = await import("@treepm/db/testing");
  await setupTestDatabase();
}
const system = {
  node: process.version,
  cpu: `${os.cpus()[0]?.model ?? "?"} × ${os.cpus().length}`,
  memoryGb: Math.round(os.totalmem() / 2 ** 30),
  freeMemoryGb: Math.round(os.freemem() / 2 ** 30),
  platform: `${os.platform()} ${os.release()}`,
  postgres: ((await owner.query("select version() as v")).rows[0] as { v: string }).v,
};
console.log(JSON.stringify(system));

for (const n of sizes) {
  rows.length = 0;
  samples.clear();
  const loadStart = loads();
  console.log(`\n=== N = ${n} (carga média no início: ${loadStart}) ===`);
  const plan: BigProjectPlan = planBigProject({ n, seed, key: "BG", now: Date.now() });
  const summary = await loadBigProject(owner, plan);
  console.log(`  projeto gravado em ${summary.seconds.toFixed(1)} s: ${JSON.stringify(summary.counts)}`);
  const f = plan.fixtures;
  const T = (i: number) => plan.tickets[i]!;
  const pid = plan.projectId;
  const depthHistogram = plan.tickets.reduce<number[]>((acc, t) => ((acc[t.depth] = (acc[t.depth] ?? 0) + 1), acc), []);
  const statusCounts = plan.tickets.reduce<Record<string, number>>((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {});

  // -- Mapa: o que `loadMapData` chama (projetos e pessoas em paralelo; depois a lista de cada projeto).
  const listShot = await http("GET", `/api/projects/${pid}/tickets`);
  const peopleShot = await http("GET", "/api/people");
  const projectsShot = await http("GET", "/api/projects");
  mkdirSync(resolve(outDir, String(n)), { recursive: true });
  writeFileSync(resolve(outDir, String(n), "tickets.json"), listShot.body);
  writeFileSync(resolve(outDir, String(n), "people.json"), peopleShot.body);
  writeFileSync(resolve(outDir, String(n), "projects.json"), projectsShot.body);
  const mapLoad = async (): Promise<Shot> => {
    const started = performance.now();
    const [p, q] = await Promise.all([http("GET", "/api/projects"), http("GET", "/api/people")]);
    const t = await http("GET", `/api/projects/${pid}/tickets`);
    return { ms: performance.now() - started, bytes: p.bytes + q.bytes + t.bytes, status: t.status, queries: [...p.queries, ...q.queries, ...t.queries], body: t.body };
  };
  console.log("  -- mapa");
  await measure(n, "mapa", "GET lista de tickets do projeto", () => http("GET", `/api/projects/${pid}/tickets`));
  await measure(n, "mapa", "carga do mapa (projetos+pessoas, depois a lista)", mapLoad);
  await measure(n, "mapa", "refresh de 30 s (mesma carga, useAutoRefresh)", mapLoad);

  console.log("  -- ticket");
  await measure(n, "ticket", "GET detalhe raso (raiz)", () => http("GET", `/api/tickets/${T(f.shallow).id}`));
  await measure(n, "ticket", `GET detalhe fundo (profundidade ${T(f.deep).depth})`, () => http("GET", `/api/tickets/${T(f.deep).id}`));
  await measure(n, "ticket", "GET atividade do ticket de muito histórico (30)", () => http("GET", `/api/tickets/${T(f.history).id}/activity`));
  await measure(n, "ticket", "GET atividade, página de 100", () => http("GET", `/api/tickets/${T(f.history).id}/activity?limit=100`));
  // Última página: segue o cursor até acabar (o custo de páginas fundas).
  {
    let before: string | null = null;
    let pages = 0;
    for (;;) {
      const shot = await http("GET", `/api/tickets/${T(f.history).id}/activity?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      if (shot.status !== 200) break;
      const page = JSON.parse(shot.body) as { before: string | null; entries: unknown[] };
      pages += 1;
      if (page.before === null || page.entries.length === 0) break;
      before = page.before;
    }
    let cursor = before;
    await measure(n, "ticket", `GET atividade, última página (a ${pages}ª, de 100 em 100)`, () => http("GET", `/api/tickets/${T(f.history).id}/activity?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`));
    cursor = null;
  }
  await measure(n, "ticket", "GET tela Ideias", () => http("GET", `/api/projects/${pid}/ideas`));

  console.log("  -- escritas");
  const chain = f.doneChain.map((i) => T(i).id);
  const restoreChain = async (): Promise<void> => {
    await owner.query("update tickets set status = 'done' where id = any($1::uuid[])", [chain]);
  };
  await measure(n, "escrita", "PATCH situação da folha funda → reabre 6 pais", () => http("PATCH", `/api/tickets/${T(f.doneLeaf).id}`, { status: "todo" }), restoreChain);
  const openLeaf = plan.tickets.filter((t) => t.status === "todo" && t.depth >= 6 && t.ideaStage === null && t.agentWork === null && !plan.tickets.some((c) => c.parent === t.index)).at(0) ?? T(f.move);
  await measure(n, "escrita", `PATCH situação de folha funda sem propagação (prof. ${openLeaf.depth})`, (rep) => http("PATCH", `/api/tickets/${openLeaf.id}`, { status: rep % 2 === 0 ? "in_progress" : "todo" }));
  await owner.query("update tickets set status = 'todo' where id = $1", [openLeaf.id]);
  await measure(n, "escrita", "PATCH mover ticket de pai (A→B→A)", (rep) => http("PATCH", `/api/tickets/${T(f.move).id}`, { parentId: rep % 2 === 0 ? T(f.moveTo).id : T(f.moveFrom).id }));

  console.log("  -- MCP");
  const tokenRes = await http("POST", "/api/access-tokens", { projectId: pid, name: "Medição", expiresInDays: 30 });
  const token = tokenRes.status === 201 ? (JSON.parse(tokenRes.body) as { token: string }).token : "";
  if (!token) console.log(`  ✗ token MCP não criado: HTTP ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`);
  else {
    const keyOf = (i: number) => `BG-${T(i).number}`;
    const wrap = async (args: Record<string, unknown>, tool: string): Promise<Shot> => {
      const shot = await mcpTool(token, "BG", tool, args);
      return { ...shot, status: shot.status === 200 ? 200 : shot.status };
    };
    await measure(n, "mcp", "list_tickets (50, 1ª página)", () => wrap({}, "list_tickets"));
    await measure(n, "mcp", "list_tickets (200, 1ª página)", () => wrap({ limit: 200 }, "list_tickets"));
    await measure(n, "mcp", "get_ticket (fundo)", () => wrap({ key: keyOf(f.deep) }, "get_ticket"));
    await measure(n, "mcp", "get_project_overview", () => wrap({}, "get_project_overview"));
    await measure(n, "mcp", "search_tickets (\"relatórios\")", () => wrap({ query: "relatórios" }, "search_tickets"));
    // Enumerar o projeto inteiro de 200 em 200 (com os limites do gateway zerados a cada repetição).
    await measure(n, "mcp", `list_tickets, projeto inteiro (${Math.ceil(n / 200)} chamadas de 200)`, async () => {
      const shots: Shot[] = [];
      let after: string | null = null;
      for (;;) {
        const shot: Shot & { data: Record<string, unknown> | null } = await mcpTool(token, "BG", "list_tickets", { limit: 200, ...(after ? { after } : {}) });
        shots.push(shot);
        after = (shot.data?.["after"] as string | null | undefined) ?? null;
        if (shot.status !== 200 || after === null) break;
        // O limite do gateway (120/min por IP) e o do token (60/min) valem de verdade; aqui medimos a vazão sem eles e o relatório cita o limite.
        if (shots.length % 20 === 0) {
          app.get(McpGateway).resetMemory();
          app.get(AccessTokenService).resetMemory();
        }
      }
      return shots;
    });
  }

  // -- Planos: as três operações mais lentas (mediana), consultas mais demoradas de cada uma.
  const slowest = rows.filter((r) => r.status === "ok" && !r.op.startsWith("carga do mapa") && !r.op.startsWith("refresh") && !r.op.includes("projeto inteiro")).sort((a, b) => (b.medianMs as number) - (a.medianMs as number)).slice(0, 3);
  const plans: string[] = [`# EXPLAIN (ANALYZE, BUFFERS), N = ${n}, como treepm_app com isolamento por organização\n`];
  for (const row of slowest) {
    const queries = (samples.get(`${n}|${row.op}`) ?? []).filter((q) => !isControl(q.text) && /^\s*(select|with)/i.test(q.text)).sort((a, b) => b.ms - a.ms).slice(0, 3);
    plans.push(`\n## ${row.op} — mediana ${row.medianMs} ms, ${row.queries} consultas\n`);
    for (const query of queries) plans.push(`\n-- ${r1(query.ms)} ms medidos na requisição\n${query.text}\n-- parâmetros: ${JSON.stringify(query.values).slice(0, 300)}\n${await explain(query)}\n`);
  }
  writeFileSync(resolve(outDir, `explain-${n}.txt`), plans.join("\n"));

  const indexes = (await owner.query("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('tickets','activity_events','ticket_comments','ticket_relations','ticket_contributions') order by 1, 2")).rows;
  const sizes_ = (await owner.query("select relname, pg_size_pretty(pg_total_relation_size(oid)) as size from pg_class where relname in ('tickets','activity_events','ticket_comments','ticket_relations','ticket_contributions') order by 1")).rows;
  const loadEnd = loads();
  console.log(`  carga média no fim: ${loadEnd}`);
  writeFileSync(
    resolve(outDir, `results-${n}.json`),
    JSON.stringify({ n, system, loadAvgStart: loadStart, loadAvgEnd: loadEnd, load: summary, fixtures: f, depthHistogram, statusCounts, rows, indexes, tableSizes: sizes_ }, null, 2),
  );
  writeFileSync(resolve(outDir, String(n), "fixtures.json"), JSON.stringify({ ...f, ids: { deep: T(f.deep).id, shallow: T(f.shallow).id, history: T(f.history).id, idea: T(f.idea).id, project: pid } }, null, 2));
}

await app.close();
await owner.end();
await appPool.end();
console.log(`\nResultados em ${outDir}`);
