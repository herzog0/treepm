import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeRelation, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Custo do passo de relações num projeto muito ligado (ADR 0061, fatia 3; TREEPM-478). Medição, não regra: só roda com
// `TREEPM_MEASURE_RELATIONS=1` (leva minutos). Cenário da revisão: 2.000 issues, 20 mil dependências feitas aqui e 20 `blocks` por issue
// vindos do Linear (página de 50 issues × 20 relações). Os números vão para o relatório da fatia.
const measure = process.env["TREEPM_MEASURE_RELATIONS"] === "1";
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

async function run(): Promise<{ body: RunBody; relationSteps: number[]; failures: number }> {
  const started = await post("", {});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  let body = started.body as RunBody;
  const relationSteps: number[] = [];
  let failures = 0;
  for (let i = 0; i < 3000 && !body.done; i += 1) {
    const before = body.phase;
    const t0 = Date.now();
    const res = await post(`/${String(started.body.id)}/step`);
    if (before === "relations") relationSteps.push(Date.now() - t0);
    if (res.status !== 200) {
      failures += 1;
      continue;
    }
    body = res.body as RunBody;
  }
  return { body, relationSteps, failures };
}
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return { steps: times.length, total: times.reduce((a, b) => a + b, 0), median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted[sorted.length - 1] };
};

describe("custo do passo de relações num projeto muito ligado", () => {
  it.skipIf(!measure)("2.000 issues, 20 mil dependências aqui, 20 `blocks` por issue no Linear", async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `i${String(i).padStart(4, "0")}`);
    const team: FakeTeamData = { projects: [], issues: ids.map((id, i): FakeIssue => ({ id, identifier: `ENG-${i + 1}`, title: `T ${i + 1}` })), relations: [] };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    expect((await run()).body.phase).toBe("done");
    // 20 mil dependências feitas aqui, sem ciclo: o ticket de número maior depende dos 10 anteriores.
    await h.pool.query(
      `insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind)
       select a.org_id, a.project_id, a.id, b.id, 'depends_on' from tickets a join tickets b on b.project_id = a.project_id and b.number < a.number and b.number >= a.number - 10
       where a.project_id = $1::uuid`,
      [open()],
    );
    const relations: FakeRelation[] = [];
    for (let i = 0; i < 2000; i += 1) for (let k = 11; k <= 30; k += 1) if (i + k < 2000) relations.push({ id: `r-${i}-${k}`, type: "blocks", from: ids[i] as string, to: ids[i + k] as string });
    team.relations = relations;
    const first = await run();
    const pageSize = (await q("select page_size from external_import_runs where id = $1", [first.body.id]))[0];
    const quiet = await run();
    const line = `CUSTO relações: ${JSON.stringify({ relations: relations.length, first: stats(first.relationSteps), firstFailures: first.failures, created: first.body.counts?.["relationsCreated"], pageSize, repeat: stats(quiet.relationSteps), repeatFailures: quiet.failures })}`;
    console.log(line);
    const out = process.env["TREEPM_MEASURE_OUT"];
    if (out !== undefined) appendFileSync(out, `${line}\n`);
    expect(first.body.phase).toBe("done");
    expect(quiet.body.phase).toBe("done");
  }, 1_800_000);
});
