/**
 * Medição da escrita concorrente no mesmo projeto (TREEPM-249, parte de concorrência). Para cada tamanho de projeto, cenário e
 * número de escritores simultâneos, recarrega o projeto grande (`big-project/`), sobe a aplicação Nest de teste numa porta local
 * e dispara requisições HTTP de verdade, em laço fechado (cada escritor manda a próxima assim que a anterior volta), durante
 * `--duration` segundos. Mede vazão (escritas confirmadas por segundo), latência p50/p95/p99, contagem por código de resposta,
 * espera por trava (`pg_stat_activity` amostrado), deadlocks do banco, atraso do laço de eventos do Node, e termina cada rodada
 * com a conferência de integridade (`concurrent-writes/integrity.ts`).
 *
 *   TEST_DATABASE_MIGRATION_URL=…/treepm_p2 TEST_DATABASE_URL=…/treepm_p2 \
 *     pnpm --filter @treepm/api measure:concurrent-writes [--sizes 5000] [--levels 1,4,16,64] [--duration 30] [--seed 7]
 *       [--scenarios edits,structure,mixed,import,branch,mcp,mcp-unlimited] [--readers 2] [--out <pasta>] [--setup-db]
 *
 * Cenários: `edits` (só edições fora da estrutura), `structure` (mover, criar com pai, remover), `mixed` (70% edições, 20%
 * criações, 10% movimentos, mais leitores com `If-None-Match`), `import` (a mistura e, no meio, uma importação de 500 tickets),
 * `branch` (todos no mesmo ramo, com propagação de situação aos mesmos ancestrais), `mcp` (agentes pelo endpoint do MCP com os
 * limites por minuto valendo e o agente esperando o `Retry-After`) e `mcp-unlimited` (o mesmo, com os limites zerados a cada 100 ms).
 *
 * Escreve em `--out` (padrão `<repositório>/.measure/concurrent-writes`, fora do Git) `results-<N>.json`. Só roda em bancos
 * `treepm_p<N>`/`treepm_test` e APAGA todas as organizações do banco a cada rodada. Servidor e gerador de carga dividem o mesmo
 * processo Node (e a mesma CPU): a vazão é um piso, não o teto da aplicação.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { assertMeasurementDatabase, loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "./big-project/load.js";
import { planBigProject } from "./big-project/plan.js";
import type { BigProjectPlan } from "./big-project/plan.js";
import { checkIntegrity, compareListWithDatabase } from "./concurrent-writes/integrity.js";
import type { ListedTicket } from "./concurrent-writes/integrity.js";
import { buildPools, BUMPS_VERSION, createWriterPlan, importItems, SCENARIOS } from "./concurrent-writes/plan.js";
import type { Op, Pools, Scenario } from "./concurrent-writes/plan.js";
import { codeOf, summarize } from "./concurrent-writes/stats.js";
import type { Sample, Summary } from "./concurrent-writes/stats.js";

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
    sizes: { type: "string", default: "5000" },
    levels: { type: "string", default: "1,4,16,64" },
    scenarios: { type: "string", default: SCENARIOS.join(",") },
    duration: { type: "string", default: "30" },
    seed: { type: "string", default: "7" },
    readers: { type: "string", default: "2" },
    "reader-interval": { type: "string", default: "3" },
    out: { type: "string", default: resolve(here, "../../../.measure/concurrent-writes") },
    "setup-db": { type: "boolean", default: false },
    "log-errors": { type: "boolean", default: false },
  },
});
const sizes = (values.sizes ?? "").split(",").map(Number);
const levels = (values.levels ?? "").split(",").map(Number);
const scenarios = (values.scenarios ?? "").split(",") as Scenario[];
const duration = Number(values.duration);
const seed = Number(values.seed);
const readerCount = Number(values.readers);
const readerIntervalMs = Number(values["reader-interval"]) * 1000;
const outDir = resolve(values.out as string);
const usage = "Uso: measure:concurrent-writes [--sizes 5000] [--levels 1,4,16,64] [--scenarios …] [--duration 30] [--seed 7] [--readers 2] [--out <pasta>] [--setup-db]";
if (
  sizes.some((n) => !Number.isInteger(n) || n < 500) ||
  levels.some((n) => !Number.isInteger(n) || n < 1 || n > 200) ||
  scenarios.some((s) => !SCENARIOS.includes(s)) ||
  !(duration > 0) || !Number.isInteger(seed) || !Number.isInteger(readerCount)
) {
  console.error(usage);
  process.exit(2);
}

/** O histograma do laço de eventos inclui o período do temporizador (10 ms); o atraso de verdade é o que passa disso. */
const lag = (ns: number): number => Math.max(0, r1(ns / 1e6 - 10));
const loads = (): string => os.loadavg().map((x) => x.toFixed(2)).join(" / ");
const r1 = (x: number): number => Math.round(x * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const { createTestApp, sessionHeader } = await import("../test/helpers.js");
const { McpGateway } = await import("../src/mcp/mcp-gateway.js");
const { AccessTokenService } = await import("../src/access-tokens/access-token.service.js");
const { createPrismaClient } = await import("@treepm/db");
const { readBranchOf } = await import("../src/tickets/ticket-reads.js");

const owner = new pg.Pool({ connectionString: ownerUrl, max: 4 });
const prisma = createPrismaClient(ownerUrl);
if (values["setup-db"]) {
  const { setupTestDatabase } = await import("@treepm/db/testing");
  await setupTestDatabase();
}
const { app } = await createTestApp();
await app.listen(0, "127.0.0.1");
const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
if (values["log-errors"]) {
  // Mostra as primeiras causas de erro 5xx do servidor (a aplicação de teste sobe sem logger).
  const { Logger } = await import("@nestjs/common");
  let shown = 0;
  Logger.overrideLogger({ log() {}, warn() {}, debug() {}, verbose() {}, error: (...a: unknown[]) => { if (shown++ < 6) console.log("  [erro do servidor]", ...a.map((x) => String(x).slice(0, 600))); } });
}
const resetLimits = (): void => {
  app.get(McpGateway).resetMemory();
  app.get(AccessTokenService).resetMemory();
};

// Todas as sessões são de administrador da organização (a remoção exige administrador ou gerente do projeto); o que se mede é a
// concorrência, não a permissão. Cada escritor é uma pessoa diferente, para limites por pessoa não mascararem o resultado.
const sessionOf = (clerkUserId: string): string => sessionHeader({ userId: clerkUserId, orgId: PERF_ORG, orgRole: "org:admin" });
const REQUEST_TIMEOUT_MS = 30_000;

interface Shot { ms: number; status: number; body: string; etag: string | null }
async function http(method: string, path: string, session: string, body?: unknown, headers: Record<string, string> = {}): Promise<Shot> {
  const started = performance.now();
  try {
    const res = await fetch(base + path, {
      method,
      headers: { "x-test-session": session, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    return { ms: performance.now() - started, status: res.status, body: text, etag: res.headers.get("etag") };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, body: error instanceof Error ? error.name : "erro", etag: null };
  }
}

const MODERN = "2026-07-28";
const envelope = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "medicao", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
interface McpShot extends Shot { toolError: string | null; data: Record<string, unknown> | null; retryAfterS: number | null }
async function mcpCall(token: string, key: string, name: string, args: Record<string, unknown>): Promise<McpShot> {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/api/mcp/${key}`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: envelope } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let toolError: string | null = null;
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { message?: string } };
      data = parsed.result?.structuredContent ?? null;
      if (parsed.result?.isError) toolError = (parsed.result.content?.[0]?.text ?? "erro da ferramenta").slice(0, 80);
      else if (parsed.error) toolError = (parsed.error.message ?? "erro JSON-RPC").slice(0, 80);
    } catch {
      /* corpo que não é JSON (429 do gateway, por exemplo): o código HTTP basta */
    }
    const retry = Number(res.headers.get("retry-after"));
    return { ms: performance.now() - started, status: res.status, body: text, etag: null, toolError, data, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : null };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, body: error instanceof Error ? error.name : "erro", etag: null, toolError: null, data: null, retryAfterS: null };
  }
}

/** Código de resposta de uma operação: HTTP; no MCP, 200 com `isError` vira `tool_error`. */
const classify = (shot: Shot | McpShot): string => {
  if (shot.status === 0) return shot.body === "TimeoutError" ? "timeout" : "erro de rede";
  if ("toolError" in shot && shot.toolError !== null && shot.status === 200) return "tool_error";
  if (shot.status === 304) return "304";
  return codeOf(shot.status, shot.body);
};

interface Done { body?: string; kind: string; sample: Sample; at: number; bump: boolean; note?: string }
interface WriterState { index: number; person: number; session: string; token: string; created: string[]; done: Done[] }

// ---- Amostragem do banco (esperas por trava, conexões) ----
interface WaitStats { samples: number; maxConnections: number; maxActive: number; maxIdleInTx: number; waitSamples: Record<string, number>; maxWaiting: Record<string, number>; lockWaitersSum: number }
async function startSampler(): Promise<{ stop: () => Promise<WaitStats> }> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const stats: WaitStats = { samples: 0, maxConnections: 0, maxActive: 0, maxIdleInTx: 0, waitSamples: {}, maxWaiting: {}, lockWaitersSum: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const res = await client.query<{ wait_event_type: string | null; wait_event: string | null; state: string | null; n: number }>(
          "select wait_event_type, wait_event, state, count(*)::int n from pg_stat_activity where datname = current_database() and usename = 'treepm_app' group by 1, 2, 3",
        );
        stats.samples += 1;
        let total = 0;
        let active = 0;
        let idleTx = 0;
        for (const row of res.rows) {
          total += row.n;
          if (row.state === "active") active += row.n;
          if (row.state?.startsWith("idle in transaction")) idleTx += row.n;
          if (row.state === "active" && row.wait_event_type !== null && row.wait_event_type !== "Client") {
            const label = `${row.wait_event_type}:${row.wait_event}`;
            stats.waitSamples[label] = (stats.waitSamples[label] ?? 0) + row.n;
            stats.maxWaiting[label] = Math.max(stats.maxWaiting[label] ?? 0, row.n);
            if (row.wait_event_type === "Lock") stats.lockWaitersSum += row.n;
          }
        }
        stats.maxConnections = Math.max(stats.maxConnections, total);
        stats.maxActive = Math.max(stats.maxActive, active);
        stats.maxIdleInTx = Math.max(stats.maxIdleInTx, idleTx);
      } catch {
        /* amostra perdida */
      }
      await sleep(200);
    }
  })();
  return { stop: async () => ((running = false), await loop, await client.end(), stats) };
}

const dbCounters = async (): Promise<{ commits: number; rollbacks: number; deadlocks: number }> => {
  const r = await owner.query<{ c: string; r: string; d: string }>("select xact_commit::text c, xact_rollback::text r, deadlocks::text d from pg_stat_database where datname = current_database()");
  const row = r.rows[0] as { c: string; r: string; d: string };
  return { commits: Number(row.c), rollbacks: Number(row.r), deadlocks: Number(row.d) };
};

const planCache = new Map<number, { plan: BigProjectPlan; pools: Pools }>();
function planFor(n: number): { plan: BigProjectPlan; pools: Pools } {
  let cached = planCache.get(n);
  if (!cached) {
    // 80 pessoas: até 64 escritores + leitores + o importador, cada um com a sua pessoa.
    const plan = planBigProject({ n, seed, key: "BG", now: Date.now(), people: 80 });
    cached = { plan, pools: buildPools(plan) };
    planCache.set(n, cached);
  }
  return cached;
}

interface CellResult {
  n: number;
  scenario: Scenario;
  writers: number;
  seconds: number;
  loadAvgStart: string;
  loadAvgEnd: string;
  writes: Summary;
  byKind: Record<string, Summary>;
  reads: Summary | null;
  readCodes?: Record<string, number>;
  importResult: { ms: number; code: string; during: { count: number; maxMs: number; busy: number } } | null;
  locks: WaitStats & { estimatedLockWaitMsPerWrite: number | null; sampleIntervalMs: number };
  db: { commits: number; rollbacks: number; deadlocks: number };
  node: { eventLoopMeanMs: number; eventLoopP99Ms: number; eventLoopMaxMs: number; cpuPercent: number };
  toolErrors: Record<string, number>;
  /** Até 3 corpos por código de resposta que não é sucesso nem 429 (para entender 5xx, timeout e 409). */
  errorSamples: Record<string, string[]>;
  integrity: {
    ok: boolean;
    tickets: number;
    cycle: number;
    orphan: number;
    selfParent: number;
    doneWithOpenChild: number;
    progressMismatch: number;
    ideaRootMismatch: number;
    version: { before: number; after: number; delta: number; expected: number; difference: number };
    list: { etagMatchesVersion: boolean; diffs: string[]; listedTickets: number };
    sample: string[];
  };
}

async function runCell(n: number, scenario: Scenario, writers: number): Promise<CellResult> {
  const { plan, pools } = planFor(n);
  const pid = plan.projectId;
  const mcp = scenario === "mcp" || scenario === "mcp-unlimited";
  await loadBigProject(owner, plan);
  await owner.query("update organizations set mcp_write_enabled = true where org_id = $1", [PERF_ORG]);
  resetLimits();
  // Pessoa de organização sem papel no projeto só lê: quem escreve pelo MCP precisa ser colaborador do projeto (as sessões HTTP são de administrador).
  if (mcp) {
    await owner.query(
      "insert into project_memberships (org_id, project_id, person_id, role) select $1, $2, p, 'contributor' from unnest($3::uuid[]) as p",
      [PERF_ORG, pid, Array.from({ length: writers }, (_, w) => plan.people[1 + w]!.id)],
    );
  }

  const adminSession = sessionOf(PERF_ADMIN_USER);
  const states: WriterState[] = [];
  for (let w = 0; w < writers; w += 1) {
    const person = 1 + w; // a pessoa 0 é o administrador
    const clerk = plan.people[person]!.clerkUserId;
    states.push({ index: w, person, session: sessionOf(clerk), token: "", created: [], done: [] });
  }
  if (mcp) {
    for (const st of states) {
      const res = await http("POST", "/api/access-tokens", st.session, { projectId: pid, name: `Medição ${st.index}`, expiresInDays: 30, scope: "write" });
      if (res.status !== 201) throw new Error(`token de escrita não criado (${res.status}): ${res.body.slice(0, 200)}`);
      st.token = (JSON.parse(res.body) as { token: string }).token;
    }
  }
  const before = await owner.query<{ v: string }>("select tickets_version::text v from projects where id = $1", [pid]);
  const versionBefore = Number(before.rows[0]!.v);
  const db0 = await dbCounters();
  const sampler = await startSampler();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpu0 = process.cpuUsage();
  const loadStart = loads();
  const t0 = performance.now();
  const deadline = t0 + duration * 1000;
  let limitTimer: NodeJS.Timeout | null = null;
  if (scenario === "mcp-unlimited") limitTimer = setInterval(resetLimits, 100);

  const T = (i: number): { id: string; key: string } => ({ id: plan.tickets[i]!.id, key: `BG-${plan.tickets[i]!.number}` });
  async function exec(st: WriterState, op: Op): Promise<{ kind: string; shot: Shot | McpShot; bump: boolean; note?: string }> {
    switch (op.kind) {
      case "status": return { kind: op.kind, shot: await http("PATCH", `/api/tickets/${T(op.ticket).id}`, st.session, { status: op.status }), bump: true };
      case "title": return { kind: op.kind, shot: await http("PATCH", `/api/tickets/${T(op.ticket).id}`, st.session, { title: op.title }), bump: true };
      case "priority": return { kind: op.kind, shot: await http("PATCH", `/api/tickets/${T(op.ticket).id}`, st.session, { priority: op.priority }), bump: true };
      case "assignee": {
        const path = `/api/tickets/${T(op.ticket).id}/assignees/${plan.people[op.person]!.id}`;
        return { kind: op.kind, shot: await http(op.add ? "PUT" : "DELETE", path, st.session), bump: true };
      }
      case "move": return { kind: op.kind, shot: await http("PATCH", `/api/tickets/${T(op.ticket).id}`, st.session, { parentId: T(op.parent).id }), bump: true };
      case "create": {
        const shot = await http("POST", `/api/projects/${pid}/tickets`, st.session, { title: op.title, parentId: T(op.parent ?? 0).id });
        if (shot.status === 201 || shot.status === 200) st.created.push((JSON.parse(shot.body) as { id: string }).id);
        return { kind: op.kind, shot, bump: true };
      }
      case "remove-own": {
        const id = st.created.shift();
        if (id === undefined) return exec(st, { kind: "create", parent: pools.inner[st.index % pools.inner.length]!, title: `Medição w${st.index} (para remover)` });
        return { kind: op.kind, shot: await http("DELETE", `/api/tickets/${id}`, st.session), bump: true };
      }
      case "mcp-status": return { kind: op.kind, shot: await mcpCall(st.token, "BG", "update_ticket_status", { key: T(op.ticket).key, status: op.status }), bump: true };
      case "mcp-agent-work": return { kind: op.kind, shot: await mcpCall(st.token, "BG", "set_agent_work", { key: T(op.ticket).key, working: op.working, ...(op.working ? { minutes: 30, note: "Medição" } : {}) }), bump: true };
      case "mcp-comment": return { kind: op.kind, shot: await mcpCall(st.token, "BG", "add_comment", { key: T(op.ticket).key, body: op.body }), bump: false };
      case "mcp-create": return { kind: op.kind, shot: await mcpCall(st.token, "BG", "create_ticket", { title: op.title, parent: T(op.parent ?? 0).key }), bump: true };
      case "mcp-queue": return { kind: op.kind, shot: await mcpCall(st.token, "BG", "get_work_queue", {}), bump: false };
    }
  }

  const writerLoops = states.map(async (st) => {
    const next = createWriterPlan({ plan, pools, scenario, writer: st.index, writers, seed });
    while (performance.now() < deadline) {
      const op = next();
      const { kind, shot, bump } = await exec(st, op);
      const code = classify(shot);
      const note = "toolError" in shot && shot.toolError ? shot.toolError : undefined;
      st.done.push({ kind, sample: { ms: shot.ms, code }, at: performance.now() - t0, bump, ...(note ? { note } : {}), ...(code !== "2xx" && code !== "429" && code !== "tool_error" ? { body: shot.body.slice(0, 300) } : {}) });
      // Cenário `mcp`: o agente respeita o limite e espera o `Retry-After` antes de tentar de novo (a espera conta no tempo da rodada).
      if (scenario === "mcp" && "retryAfterS" in shot && shot.status === 429) await sleep(Math.min((shot.retryAfterS ?? 1) * 1000, Math.max(0, deadline - performance.now())));
    }
  });

  // Leitores do mapa: atualização condicional a cada poucos segundos (ADR 0046).
  const readerSamples: Sample[] = [];
  const readerLoops: Promise<void>[] = [];
  if (scenario === "mixed" || scenario === "import" || scenario === "branch") {
    for (let r = 0; r < readerCount; r += 1) {
      const session = sessionOf(plan.people[79 - r]!.clerkUserId);
      readerLoops.push(
        (async () => {
          let etag: string | null = null;
          await sleep((r * readerIntervalMs) / Math.max(1, readerCount));
          while (performance.now() < deadline) {
            const shot = await http("GET", `/api/projects/${pid}/tickets`, session, undefined, etag ? { "if-none-match": etag } : {});
            if (shot.status === 200 && shot.etag) etag = shot.etag;
            readerSamples.push({ ms: shot.ms, code: shot.status === 304 ? "304" : classify(shot) });
            await sleep(readerIntervalMs);
          }
        })(),
      );
    }
  }

  // Importação de 500 tickets no meio da rodada (pessoa própria, fora da conta dos escritores).
  let importResult: CellResult["importResult"] = null;
  const importLoop = (async () => {
    if (scenario !== "import") return;
    await sleep(Math.max(0, t0 + (duration * 1000) / 2 - performance.now()));
    const startedAt = performance.now() - t0;
    const shot = await http("POST", `/api/projects/${pid}/tickets/import`, sessionOf(plan.people[78]!.clerkUserId), { items: importItems(`c${writers}`) });
    importResult = { ms: r1(shot.ms), code: classify(shot), during: { count: 0, maxMs: 0, busy: 0 } };
    const endedAt = startedAt + shot.ms;
    for (const st of states) {
      for (const d of st.done) {
        // Escritas de estrutura que começaram durante a importação (início = fim − duração).
        if (d.at >= startedAt && d.at - d.sample.ms <= endedAt && d.at - d.sample.ms >= startedAt - 1) {
          importResult.during.count += 1;
          importResult.during.maxMs = Math.max(importResult.during.maxMs, d.sample.ms);
          if (d.sample.code === "409 structure_busy") importResult.during.busy += 1;
        }
      }
    }
  })();

  await Promise.all([...writerLoops, ...readerLoops, importLoop]);
  const seconds = (performance.now() - t0) / 1000;
  if (limitTimer) clearInterval(limitTimer);
  loop.disable();
  const cpu = process.cpuUsage(cpu0);
  const locks = await sampler.stop();
  const db1 = await dbCounters();
  const loadEnd = loads();

  // Integridade: depois da última escrita (todos os laços acabaram).
  const done = states.flatMap((s) => s.done);
  const writeDone = done.filter((d) => d.kind !== "mcp-queue");
  const confirmed = writeDone.filter((d) => d.sample.code === "2xx");
  let expected = confirmed.filter((d) => d.bump && BUMPS_VERSION.has(d.kind as never)).length;
  if (importResult !== null && (importResult as { code: string }).code === "2xx") expected += 1;
  const after = Number(((await owner.query<{ v: string }>("select tickets_version::text v from projects where id = $1", [pid])).rows[0] as { v: string }).v);
  const scope = { orgId: PERF_ORG, projectId: pid };
  const report = await checkIntegrity(owner, pid, (ids) => prisma.$transaction((tx) => readBranchOf(tx as never, scope, ids), { timeout: 120_000 }) as never);
  const listShot = await http("GET", `/api/projects/${pid}/tickets`, adminSession);
  const listed = listShot.status === 200 ? (JSON.parse(listShot.body) as ListedTicket[]) : [];
  const diffs = listShot.status === 200 ? await compareListWithDatabase(owner, pid, listed) : [`lista: HTTP ${listShot.status}`];
  const etagMatches = listShot.etag === `W/"v2.${after}"`;

  const toolErrors: Record<string, number> = {};
  for (const d of writeDone) if (d.note) toolErrors[d.note] = (toolErrors[d.note] ?? 0) + 1;
  const errorSamples: Record<string, string[]> = {};
  for (const d of writeDone) {
    if (d.body === undefined) continue;
    const list = (errorSamples[d.sample.code] ??= []);
    if (list.length < 3) list.push(d.body);
  }
  const byKind: Record<string, Summary> = {};
  for (const kind of new Set(done.map((d) => d.kind))) byKind[kind] = summarize(done.filter((d) => d.kind === kind).map((d) => d.sample), seconds);
  const lockMs = locks.samples > 0 ? (locks.lockWaitersSum * (seconds * 1000)) / locks.samples : 0;
  const result: CellResult = {
    n,
    scenario,
    writers,
    seconds: r1(seconds),
    loadAvgStart: loadStart,
    loadAvgEnd: loadEnd,
    writes: summarize(writeDone.map((d) => d.sample), seconds),
    byKind,
    reads: scenario === "mcp" || scenario === "mcp-unlimited" ? summarize(done.filter((d) => d.kind === "mcp-queue").map((d) => d.sample), seconds) : readerSamples.length ? summarize(readerSamples, seconds) : null,
    importResult,
    locks: { ...locks, estimatedLockWaitMsPerWrite: confirmed.length ? r1(lockMs / confirmed.length) : null, sampleIntervalMs: locks.samples ? r1((seconds * 1000) / locks.samples) : 0 },
    db: { commits: db1.commits - db0.commits, rollbacks: db1.rollbacks - db0.rollbacks, deadlocks: db1.deadlocks - db0.deadlocks },
    node: { eventLoopMeanMs: lag(loop.mean), eventLoopP99Ms: lag(loop.percentile(99)), eventLoopMaxMs: lag(loop.max), cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 100) },
    toolErrors,
    errorSamples,
    integrity: {
      ok: report.ok && diffs.length === 0 && etagMatches,
      tickets: report.tickets,
      cycle: report.shape.cycle.length,
      orphan: report.shape.orphan.length,
      selfParent: report.shape.selfParent.length,
      doneWithOpenChild: report.doneWithOpenChild.length,
      progressMismatch: report.progressMismatch.length,
      ideaRootMismatch: report.ideaRootMismatch.length,
      version: { before: versionBefore, after, delta: after - versionBefore, expected, difference: expected - (after - versionBefore) },
      list: { etagMatchesVersion: etagMatches, diffs, listedTickets: listed.length },
      sample: [...report.shape.cycle.slice(0, 3), ...report.progressMismatch.slice(0, 3), ...report.doneWithOpenChild.slice(0, 3)],
    },
  };
  if (readerSamples.length) result.readCodes = summarize(readerSamples, seconds).codes;
  return result;
}

function line(c: CellResult): string {
  const w = c.writes;
  const codes = Object.entries(w.codes).map(([k, v]) => `${k}=${v}`).join(" ");
  return `  ${c.scenario.padEnd(13)} ${String(c.writers).padStart(2)} esc  ${String(w.throughput).padStart(6)} ok/s  p50 ${String(w.p50).padStart(7)}  p95 ${String(w.p95).padStart(7)}  p99 ${String(w.p99).padStart(7)} ms  [${codes}]  deadlocks ${c.db.deadlocks}  versão ${c.integrity.version.delta}/${c.integrity.version.expected}  integridade ${c.integrity.ok ? "ok" : "FALHOU"}`;
}

mkdirSync(outDir, { recursive: true });
const system = {
  node: process.version,
  cpu: `${os.cpus()[0]?.model ?? "?"} × ${os.cpus().length}`,
  memoryGb: Math.round(os.totalmem() / 2 ** 30),
  platform: `${os.platform()} ${os.release()}`,
  postgres: ((await owner.query("select version() as v")).rows[0] as { v: string }).v,
  poolSizeApi: 10,
};
console.log(JSON.stringify(system));

for (const n of sizes) {
  const file = resolve(outDir, `results-${n}.json`);
  const previous: CellResult[] = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { cells?: CellResult[] }).cells ?? []) : [];
  const cells = new Map(previous.map((c) => [`${c.scenario}|${c.writers}`, c] as const));
  console.log(`\n=== N = ${n}, ${duration} s por rodada (carga média ${loads()}) ===`);
  for (const scenario of scenarios) {
    for (const writers of levels) {
      const cell = await runCell(n, scenario, writers);
      console.log(line(cell));
      cells.set(`${scenario}|${writers}`, cell);
      writeFileSync(file, JSON.stringify({ n, seed, duration, system, cells: [...cells.values()] }, null, 2));
    }
  }
}

await app.close();
await prisma.$disconnect();
await owner.end();
console.log(`\nResultados em ${outDir}`);
