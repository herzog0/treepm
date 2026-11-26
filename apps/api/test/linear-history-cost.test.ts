import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEAM_ENG, historyIssues, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeHistoryEntry, FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Custo da fase `history` (ADR 0061, fatia 4; TREEPM-482). Medição, não regra: só roda com `TREEPM_MEASURE_HISTORY=1` (leva minutos).
// Cenário: 2.000 issues × 20 entradas (a página do time traz tudo, sem página extra), num projeto importado antes desta fatia (a primeira
// sincronização lê o time inteiro); depois, uma sincronização sem mudança (o filtro incremental: começo da primeira rodada − 10 min). As
// issues foram alteradas no Linear em datas espalhadas pelos últimos 30 dias, até 1 min antes da primeira: `quietReread` conta quantas a
// segunda relê. Os números vão para o relatório.
const measure = process.env["TREEPM_MEASURE_HISTORY"] === "1";
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

async function run(): Promise<{ body: RunBody; historySteps: number[]; total: number; failures: number; teamCalls: number; extraCalls: number }> {
  h.linear().calls.length = 0;
  const t0 = Date.now();
  const started = await post("", {});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  let body = started.body as RunBody;
  const historySteps: number[] = [];
  let failures = 0;
  for (let i = 0; i < 5000 && !body.done; i += 1) {
    const before = body.phase;
    const s0 = Date.now();
    const res = await post(`/${String(started.body.id)}/step`);
    if (before === "history") historySteps.push(Date.now() - s0);
    if (res.status !== 200) {
      failures += 1;
      continue;
    }
    body = res.body as RunBody;
  }
  const calls = h.linear().calls;
  return { body, historySteps, total: Date.now() - t0, failures, teamCalls: calls.filter((c) => c.query.includes("TeamHistory")).length, extraCalls: calls.filter((c) => c.query.includes("IssueHistory")).length };
}
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return { steps: times.length, total: times.reduce((a, b) => a + b, 0), median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted[sorted.length - 1] };
};
const ADMIN = { id: "u-admin", name: "Admin no Linear", email: "admin@exemplo.test" };
const OTHER = { id: "u-fora", name: "Pessoa de Fora", email: "fora@linear.test" };
/** 20 entradas variadas por issue (situação, responsável, prioridade, título, descrição; autores casado, de fora e robô). */
const entries = (issue: string): FakeHistoryEntry[] =>
  Array.from({ length: 20 }, (_, k): FakeHistoryEntry => {
    const n = 20 - k;
    const base = { id: `h-${issue}-${n}`, createdAt: new Date(Date.UTC(2026, 3, 1, 10, n)).toISOString() };
    const actor = k % 3 === 0 ? { actor: ADMIN } : k % 3 === 1 ? { actor: OTHER } : { bot: "GitHub" };
    if (k % 5 === 0) return { ...base, ...actor, fromState: { id: "s1", name: "Todo", type: "unstarted" }, toState: { id: "s2", name: "Em andamento", type: "started" } };
    if (k % 5 === 1) return { ...base, ...actor, fromAssignee: OTHER, toAssignee: ADMIN };
    if (k % 5 === 2) return { ...base, ...actor, fromPriority: 3, toPriority: 1 };
    if (k % 5 === 3) return { ...base, ...actor, fromTitle: `Antes ${n}`, toTitle: `Depois ${n}` };
    return { ...base, ...actor, updatedDescription: true };
  });

describe("custo da fase history num time grande", () => {
  it.skipIf(!measure)("2.000 issues × 20 entradas: tempo por passo e total, passos e chamadas", async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `i${String(i).padStart(4, "0")}`);
    const team: FakeTeamData = { projects: [], issues: ids.map((id, i): FakeIssue => ({ id, identifier: `ENG-${i + 1}`, title: `T ${i + 1}` })) };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    expect((await run()).body.phase).toBe("done");
    await q("update external_import_runs set history_since = null, history_complete = false");
    team.history = Object.fromEntries(ids.map((id) => [id, entries(id)]));
    const now = Date.now();
    team.issues = team.issues.map((issue, i) => ({ ...issue, updatedAt: new Date(now - 60_000 - Math.floor((i / ids.length) * 30 * 86_400_000)).toISOString() }));
    const first = await run();
    const rows = (await q("select count(*)::int n from external_history_entries"))[0];
    const quiet = await run();
    const quietReread = h.linear().calls.filter((c) => c.query.includes("TeamHistory") && c.query.includes("history(first")).reduce((sum, c) => sum + historyIssues(team, typeof c.variables["since"] === "string" ? c.variables["since"] : null).length, 0);
    const line = `CUSTO histórico: ${JSON.stringify({
      issues: ids.length,
      entries: ids.length * 20,
      first: { ...stats(first.historySteps), runTotal: first.total, failures: first.failures, teamCalls: first.teamCalls, extraCalls: first.extraCalls, counts: { created: first.body.counts?.["historyCreated"], truncated: first.body.counts?.["historyTruncated"] } },
      rows,
      repeat: { ...stats(quiet.historySteps), runTotal: quiet.total, failures: quiet.failures, teamCalls: quiet.teamCalls, extraCalls: quiet.extraCalls, created: quiet.body.counts?.["historyCreated"], reread: quietReread },
    })}`;
    console.log(line);
    const out = process.env["TREEPM_MEASURE_OUT"];
    if (out !== undefined) appendFileSync(out, `${line}\n`);
    expect(first.body.phase).toBe("done");
    expect(first.body.counts).toMatchObject({ historyCreated: 40_000 });
    expect(quiet.body.counts).toMatchObject({ historyCreated: 0 });
    expect(quietReread).toBeLessThanOrEqual(5);
  }, 1_800_000);
});
