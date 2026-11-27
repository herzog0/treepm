import { tenantTransaction } from "@treepm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { structureLock } from "../src/tickets/structure-lock.js";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// L15: o estouro REAL da transação (prazo curto de verdade, não um Error montado) reduz o lote e conta erro; a trava ocupada por
// outra transação só se repete; a hierarquia só age sobre origem vista nesta rodada. `fetch` falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const savedTx = tenantTransaction.timeoutMs;
const savedWait = structureLock.timeoutMs;
afterEach(() => {
  vi.restoreAllMocks();
  tenantTransaction.timeoutMs = savedTx;
  structureLock.timeoutMs = savedWait;
});

async function finish(run: RunBody, max = 400): Promise<RunBody> {
  for (let i = 0; i < max; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
async function begin(): Promise<RunBody> {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body;
}
const runAll = async (): Promise<RunBody> => finish(await begin());
async function stepUntil(run: RunBody, phase: string, max = 400): Promise<RunBody> {
  let body = run;
  for (let i = 0; i < max && body.phase !== phase; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    body = res.body;
  }
  expect(body.phase).toBe(phase);
  return body;
}
type World = { data: Record<string, FakeTeamData>; list: FakeIssue[] };
const world = (list: FakeIssue[]): World => ({ list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa", status: "started" }], issues: list } } });
const issue = (w: World, id: string): FakeIssue => w.list.find((item) => item.id === id) as FakeIssue;
async function firstImport(w: World): Promise<RunBody> {
  await linkWithData(h, put, open(), w.data);
  return runAll();
}
const one = (id: string, state: string, extra: Partial<FakeIssue> = {}): FakeIssue => ({ id, identifier: `ENG-${id.replace(/\D/g, "") || "9"}${id.length}`, title: `Issue ${id}`, state, ...extra });
const runRow = async (id: unknown) => (await q("select batch_size, page_size, size_streak, error_streak, last_error_code from external_import_runs where id = $1::uuid", [id]))[0]!;
const rowsByExt = async (): Promise<Map<string, Row>> =>
  new Map((await q("select r.external_id, r.hierarchy_pending, t.id, t.status, t.parent_id from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid", [open()])).map((row) => [row["external_id"] as string, row]));

/** A transação de gravação que de fato trabalha por mais tempo que o prazo REAL (curto): depois de pegar a trava, demora. */
function slowAfterLock(): void {
  tenantTransaction.timeoutMs = 40;
  const original = TicketsService.prototype.lockStructure;
  vi.spyOn(TicketsService.prototype, "lockStructure").mockImplementation(async function (this: TicketsService, ...args: Parameters<TicketsService["lockStructure"]>) {
    await original.apply(this, args);
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}
const NORMAL: Record<string, number> = { hierarchy: 200, statuses: 25, mentions: 200, missing: 500 };

describe("item 1: o estouro real da transação reduz o lote e conta erro", () => {
  it.each(["hierarchy", "statuses", "mentions", "missing"])("fase %s: prazo real estourado depois da trava reduz o lote à metade e não é structure_busy 'a repetir'; com 1, conta erro próprio", async (phase) => {
    const w = world([one("a", "unstarted"), one("b", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await stepUntil(await begin(), phase);
    slowAfterLock();
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ batch_size: Math.floor(NORMAL[phase]! / 2), error_streak: 0, size_streak: 0 });
    tenantTransaction.timeoutMs = savedTx;
    await q("update external_import_runs set batch_size = 1 where id = $1::uuid", [run.id]);
    tenantTransaction.timeoutMs = 40;
    for (const streak of [1, 2]) {
      expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
      expect(await runRow(run.id)).toMatchObject({ batch_size: 1, error_streak: streak, last_error_code: "step_too_slow" });
    }
    vi.restoreAllMocks();
    tenantTransaction.timeoutMs = savedTx;
    expect((await finish(run)).done).toBe(true);
  });

  it("fase issues: prazo real estourado reduz a página; com 1, conta erro", async () => {
    const w = world([one("a", "unstarted"), one("b", "unstarted")]);
    await firstImport(w);
    issue(w, "a").title = "A novo";
    const run = await stepUntil(await begin(), "issues");
    const before = (await runRow(run.id))["page_size"] as number;
    slowAfterLock();
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect((await runRow(run.id))["page_size"] as number).toBeLessThan(before);
    expect((await runRow(run.id))["error_streak"]).toBe(0);
    tenantTransaction.timeoutMs = savedTx;
    await q("update external_import_runs set page_size = 1 where id = $1::uuid", [run.id]);
    tenantTransaction.timeoutMs = 40;
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ page_size: 1, error_streak: 1, last_error_code: "step_too_slow" });
    vi.restoreAllMocks();
    tenantTransaction.timeoutMs = savedTx;
    expect((await finish(run)).done).toBe(true);
  });

  it("trava ocupada de verdade por outra transação: só se repete (409 structure_busy), sem reduzir e sem contar erro", async () => {
    const w = world([one("a", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await stepUntil(await begin(), "statuses");
    structureLock.timeoutMs = 150;
    const client = await h.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${open()}`]);
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await post(`/${run.id}/step`);
        expect(res.status).toBe(409);
        expect(JSON.stringify(res.body)).toContain("structure_busy");
        expect(await runRow(run.id)).toMatchObject({ batch_size: null, error_streak: 0, last_error_code: null });
      }
    } finally {
      await client.query("commit");
      client.release();
    }
    structureLock.timeoutMs = savedWait;
    expect((await finish(run)).done).toBe(true);
  });
});

describe("item 2: a hierarquia só age sobre origem vista nesta rodada", () => {
  const scenario = async (vanish: (w: World) => void, back: (w: World) => void) => {
    const w = world([one("p", "completed"), one("c", "started")]);
    await firstImport(w);
    issue(w, "c").parent = "p";
    const run = await stepUntil(await begin(), "hierarchy"); // a rodada é abandonada antes de `hierarchy`
    await post(`/${run.id}/abandon`);
    expect((await rowsByExt()).get("c")!["hierarchy_pending"]).toBe(true);
    vanish(w);
    const second = await runAll();
    const rows = await rowsByExt();
    expect(rows.get("c")!["parent_id"]).toBeNull();
    expect(rows.get("p")!["status"]).toBe("done");
    expect(rows.get("c")!["hierarchy_pending"]).toBe(true);
    expect(second.counts).toMatchObject({ parentsLinked: 0, missing: 1 });
    back(w);
    await runAll();
    const final = await rowsByExt();
    expect(final.get("c")!["parent_id"]).toBe(final.get("p")!["id"]);
    expect(final.get("p")!["status"]).toBe("in_progress"); // o pai segue o filho em andamento (ADR 0068)
    const quiet = await runAll();
    expect(quiet.counts).toMatchObject({ updated: 0, parentsLinked: 0 });
  };

  it("C some do Linear: não é movido para baixo de P; ao reaparecer, desce e as situações convergem", async () => {
    let removed: FakeIssue | undefined;
    await scenario(
      (w) => {
        removed = w.list.splice(w.list.indexOf(issue(w, "c")), 1)[0];
      },
      (w) => {
        w.list.push(removed as FakeIssue);
      },
    );
  });

  it("C vai para a lixeira: idem", async () => {
    await scenario(
      (w) => {
        issue(w, "c").trashed = true;
      },
      (w) => {
        issue(w, "c").trashed = false;
      },
    );
  });
});
