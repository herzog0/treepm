import { describe, expect, it } from "vitest";
import { TEAM_ENG, fakeHistoryNode, historyIssues, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeHistoryAsk, FakeHistoryEntry, FakeIssue, FakeTeamData } from "./linear-support.js";
import type { LinearReply } from "./linear-fake-fetch.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 4 (ADR 0061; TREEPM-482), etapa 7: ponta a ponta com `fetch` falso num time de 35 issues, e a
// idempotência da fase `history` (duas abas, outra instância repetindo o passo, limite de taxa na página do time).
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean>; waitUntil?: string | null };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

const ADMIN = { id: "u-admin", name: "Admin no Linear", email: "admin@exemplo.test" };
const DUP_EMAIL = "dup.historico@exemplo.test";
const TESTER_EMAIL = "teste.historico@exemplo.test";
const DUP = { id: "u-dup", name: "Duplicado no Linear", email: DUP_EMAIL };
const TESTER = { id: "u-tester", name: "Testador no Linear", email: TESTER_EMAIL };
const NO_EMAIL = { id: "u-sem", name: "Sem E-mail no Linear", email: null };
const IDS = Array.from({ length: 35 }, (_, i) => `i${String(i + 1).padStart(2, "0")}`);
const ISSUES = (): FakeIssue[] => IDS.map((id, i) => ({ id, identifier: `ENG-${i + 1}`, title: `Issue ${i + 1}` }));
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 3, day, 10, minute)).toISOString();
const many = (issue: string, n: number): FakeHistoryEntry[] => Array.from({ length: n }, (_, i) => ({ id: `h-${issue}-${n - i}`, createdAt: at(1, n - i), updatedDescription: true }));

/**
 * i01: 230 entradas (teto 200); i02..i06: nenhuma; i07: um autor de cada tipo; i08: só mudanças fora da lista; i09: pai e projeto de
 * outro time (não importados aqui); i10..i35: 3 entradas cada (i35 tem o ticket apagado aqui durante a rodada).
 */
const HISTORY = (): Record<string, FakeHistoryEntry[]> => ({
  i01: many("i01", 230),
  i07: [
    { id: "h-i07-casado", createdAt: at(6), actor: ADMIN, toState: { id: "s2", name: "Em andamento", type: "started" }, fromAssignee: DUP, toAssignee: ADMIN },
    { id: "h-i07-dup", createdAt: at(5), actor: DUP, fromPriority: 0, toPriority: 2 },
    { id: "h-i07-teste", createdAt: at(4), actor: TESTER, fromTitle: "Antes", toTitle: "Depois" },
    { id: "h-i07-sem", createdAt: at(3), actor: NO_EMAIL, toAssignee: NO_EMAIL },
    { id: "h-i07-robo", createdAt: at(2), bot: "GitHub", updatedDescription: true },
    { id: "h-i07-apagado", createdAt: at(1), actor: null, fromState: null, fromStateId: "s-apagada", toState: { id: "s3", name: "Feito", type: "completed" } },
  ],
  i08: [
    { id: "h-i08-1", createdAt: at(2), actor: ADMIN },
    { id: "h-i08-2", createdAt: at(1), bot: "Zapier", fromPriority: 2, toPriority: 2 },
  ],
  i09: [{ id: "h-i09", createdAt: at(1), actor: ADMIN, fromParentId: null, toParentId: "ops-1", fromProjectId: null, toProjectId: "ops-proj" }],
  ...Object.fromEntries(IDS.slice(9).map((id) => [id, many(id, 3)])),
});

async function finish(run: RunBody, steps = 400): Promise<RunBody> {
  for (let i = 0; i < steps; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
const start = async (): Promise<RunBody> => {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body as RunBody;
};
const sync = async (): Promise<RunBody> => finish(await start());
const ticketOf = async (id: string): Promise<string | undefined> => (await q("select ticket_id from ticket_external_refs where external_id = $1 and kind = 'issue'", [id]))[0]?.["ticket_id"] as string | undefined;
const entry = async (id: string): Promise<Row | undefined> => (await q("select * from external_history_entries where external_id = $1", [id]))[0];
const entriesOf = async (issue: string): Promise<number> => Number((await q("select count(*)::int n from external_history_entries h join ticket_external_refs r on r.ticket_id = h.ticket_id and r.kind = 'issue' where r.external_id = $1", [issue]))[0]!["n"]);
const totals = async (): Promise<{ rows: number; distinct: number; events: number; eventSum: number; groups: number }> => {
  const rows = (await q("select count(*)::int n, count(distinct external_id)::int d from external_history_entries"))[0] as Row;
  const events = (await q("select count(*)::int n, coalesce(sum((payload->>'count')::int), 0)::int s, count(distinct (subject_id, payload->>'runId'))::int g from activity_events where kind = 'ticket.history_imported_from_linear'"))[0] as Row;
  return { rows: rows["n"] as number, distinct: rows["d"] as number, events: events["n"] as number, eventSum: events["s"] as number, groups: events["g"] as number };
};
const historyCalls = () => h.linear().calls.filter((call) => call.query.includes("TeamHistory"));
const extraCalls = () => h.linear().calls.filter((call) => call.query.includes("IssueHistory"));

async function seedPeople(): Promise<{ dup: string[]; tester: string }> {
  const org = (await q("select org_id from people where id = $1", [h.world().people.admin]))[0]!["org_id"];
  const dup = (await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_hdup1', 'Dup 1', $2, 'admin'), ($1, 'u_hdup2', 'Dup 2', $2, 'admin') returning id", [org, DUP_EMAIL])).map((row) => row["id"] as string);
  const tester = (await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ($1, 'treepm_test_h1', 'Teste', $2, 'member', true) returning id", [org, TESTER_EMAIL]))[0]!["id"] as string;
  return { dup, tester };
}
/** Importa sem histórico e apaga a marca d'água, como num projeto importado ANTES desta fatia. */
async function legacyImport(issues = ISSUES()): Promise<FakeTeamData> {
  const team: FakeTeamData = { projects: [], issues };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  expect((await sync()).phase).toBe("done");
  await q("update external_import_runs set history_since = null, history_complete = false");
  return team;
}
/** A página do time como o mundo a daria, mais nós extras na primeira página (issue de outro time no meio da resposta). */
function pageWith(team: FakeTeamData, ask: FakeHistoryAsk, extra: Record<string, unknown>[]): LinearReply {
  const live = historyIssues(team, ask.since);
  const begin = ask.after === null ? 0 : Number(ask.after);
  const end = begin + ask.first;
  const nodes = live.slice(begin, end).map((issue) => {
    const all = team.history?.[issue.id] ?? [];
    return { id: issue.id, history: { nodes: all.slice(0, 20).map((e) => fakeHistoryNode(e, ask.withEmail)), pageInfo: { hasNextPage: all.length > 20, endCursor: all.length > 20 ? "20" : null } } };
  });
  return { body: { data: { team: { issues: { nodes: [...nodes, ...extra], pageInfo: { hasNextPage: end < live.length, endCursor: end < live.length ? String(end) : null } } } } } };
}

describe("ponta a ponta: time com 35 issues", () => {
  it("primeira sincronização traz tudo; a seguinte sem mudança lê zero issues; issue alterada traz só o novo; ticket apagado aqui fica de fora", async () => {
    const people = await seedPeople();
    const team = await legacyImport();
    team.history = HISTORY();
    // Uma issue de outro time aparece no meio da primeira página: ignorada (historySkipped), nada gravado.
    const OPS_NODE = { id: "ops-1", history: { nodes: [fakeHistoryNode({ id: "h-ops", createdAt: at(1), actor: ADMIN, updatedDescription: true }, true)], pageInfo: { hasNextPage: false, endCursor: null } } };
    team.historyOverride = (_call, ask) => (ask.issueId === null && ask.withHistory && ask.after === null && ask.since === null ? pageWith(team, ask, [OPS_NODE]) : undefined);
    h.linear().calls.length = 0;

    // A rodada entra na fase history; antes de chegar à página de i35, o ticket dela é apagado aqui.
    const run = await start();
    let body = run;
    for (let i = 0; i < 100 && body.phase !== "history"; i += 1) body = (await post(`/${run.id}/step`)).body as RunBody;
    expect(body.phase).toBe("history");
    expect(await entriesOf("i35")).toBe(0);
    const deleted = await ticketOf("i35");
    expect((await h.call("DELETE", `/api/tickets/${String(deleted)}`, as("admin"))).status).toBeLessThan(300);
    const first = await finish(run);
    expect(first.phase).toBe("done");
    // 200 (i01) + 6 (i07) + 1 (i09) + 25 × 3 (i10..i34) = 282; i08 ignoradas (2); i01 no teto; ops-1 e i35 puladas.
    expect(first.counts).toMatchObject({ historyCreated: 282, historyIgnored: 2, historyTruncated: 1, historySkipped: 2 });
    expect(first.counts?.["historyIncomplete"]).toBeUndefined();
    // A consulta pediu e-mail (os autores casam por ele) e, sem marca, o time inteiro (4 páginas de 10, sem filtro); i01 pediu uma extra.
    expect(historyCalls().every((call) => /actor \{ id name email \}/.test(call.query))).toBe(true);
    expect(historyCalls().map((call) => call.variables["since"])).toEqual([undefined, undefined, undefined, undefined]);
    expect(extraCalls().map((call) => call.variables["id"])).toEqual(["i01"]);
    expect(await entriesOf("i01")).toBe(200);
    expect(await entry("h-i01-30")).toBeUndefined(); // as 30 mais antigas ficam de fora
    expect(await entry("h-ops")).toBeUndefined();
    for (const id of ["i02", "i03", "i04", "i05", "i06", "i08"]) expect(await entriesOf(id), id).toBe(0);

    // Autores de todos os tipos (a regra dos comentários).
    const admin = h.world().people.admin;
    expect(await entry("h-i07-casado")).toMatchObject({ actor_person_id: admin, external_actor_name: null, changes: [{ field: "status", from: null, to: { name: "Em andamento", type: "started" } }, { field: "assignee", from: { name: "Duplicado no Linear" }, to: { personId: admin } }] });
    expect(await entry("h-i07-dup")).toMatchObject({ actor_person_id: null, external_actor_name: "Duplicado no Linear" });
    expect(await entry("h-i07-teste")).toMatchObject({ actor_person_id: null, external_actor_name: "Testador no Linear" });
    expect(await entry("h-i07-sem")).toMatchObject({ actor_person_id: null, external_actor_name: "Sem E-mail no Linear", changes: [{ field: "assignee", from: null, to: { name: "Sem E-mail no Linear" } }] });
    expect(await entry("h-i07-robo")).toMatchObject({ actor_person_id: null, external_actor_name: "GitHub" });
    expect(await entry("h-i07-apagado")).toMatchObject({ actor_person_id: null, external_actor_name: null, changes: [{ field: "status", from: null, to: { name: "Feito", type: "completed" } }] });
    expect(JSON.stringify(await q("select actor_person_id from external_history_entries"))).not.toMatch(new RegExp([...people.dup, people.tester].join("|")));
    // Pai e projeto de outro time: só "mudou".
    expect(await entry("h-i09")).toMatchObject({ changes: [{ field: "parent", from: null, to: { ticketId: null } }, { field: "project", from: null, to: { ticketId: null } }] });
    // Um evento por ticket com linhas; a soma bate com as linhas.
    expect(await totals()).toEqual({ rows: 282, distinct: 282, events: 28, eventSum: 282, groups: 28 });
    // Marca d'água gravada; nenhum e-mail no banco.
    expect((await q("select history_since, history_complete from external_import_runs where id = $1", [first.id]))[0]).toEqual({ history_since: null, history_complete: true });
    const dump = JSON.stringify([await q("select * from external_history_entries"), await q("select * from activity_events"), await q("select * from external_import_runs")]);
    for (const email of [ADMIN.email, DUP_EMAIL, TESTER_EMAIL]) expect(dump).not.toContain(email);

    // Segunda, sem mudança no Linear: a consulta sai com o filtro (início da primeira rodada − 10 min) e volta vazia; nenhuma extra, nada gravado.
    const startedAt = (await q("select started_at from external_import_runs where id = $1", [first.id]))[0]!["started_at"] as Date;
    const since = new Date(startedAt.getTime() - 10 * 60_000).toISOString();
    h.linear().calls.length = 0;
    const quiet = await sync();
    expect(quiet.counts).toMatchObject({ historyCreated: 0, historyIgnored: 0, historyTruncated: 0, historySkipped: 0 });
    expect(historyCalls().map((call) => [call.variables["since"], /\$since: DateTimeOrDuration!/.test(call.query)])).toEqual([[since, true]]);
    expect(historyIssues(team, since)).toEqual([]);
    expect(extraCalls()).toEqual([]);
    expect(await totals()).toMatchObject({ rows: 282, events: 28 });
    // O ticket de i35 voltou pela sincronização, mas sem histórico: a issue não mudou no Linear (limite conhecido do modo incremental).
    expect(await ticketOf("i35")).not.toBe(deleted);
    expect(await entriesOf("i35")).toBe(0);

    // i07 ganha uma entrada no Linear e i35 é alterada: só o novo de i07, e o histórico inteiro de i35 (que aqui não tinha nenhum).
    const now = new Date().toISOString();
    team.issues = team.issues.map((issue) => (issue.id === "i07" || issue.id === "i35" ? { ...issue, updatedAt: now } : issue));
    team.history.i07 = [{ id: "h-i07-novo", createdAt: at(7), actor: ADMIN, fromTitle: "Depois", toTitle: "Issue 7" }, ...(team.history.i07 ?? [])];
    h.linear().calls.length = 0;
    const later = await sync();
    expect(later.counts).toMatchObject({ historyCreated: 4, historyIgnored: 0, historySkipped: 0 });
    expect(historyCalls()).toHaveLength(1);
    expect(await entriesOf("i35")).toBe(3);
    expect(await entry("h-i07-novo")).toMatchObject({ actor_person_id: admin, changes: [{ field: "title", from: "Depois", to: "Issue 7" }] });
    expect(await totals()).toEqual({ rows: 286, distinct: 286, events: 30, eventSum: 286, groups: 30 });
  });
});

describe("idempotência da fase history", () => {
  /** 12 issues; 3 com 25 entradas (página extra), o resto com 4. Total: 3 × 25 + 9 × 4 = 111. */
  const IDEMPOTENT = (): Record<string, FakeHistoryEntry[]> => Object.fromEntries(IDS.slice(0, 12).map((id, i) => [id, many(id, i % 4 === 0 ? 25 : 4)]));
  const TOTAL = 111;

  it("duas abas no mesmo passo, o limite de taxa na página do time no meio e o passo repetido por outra instância não duplicam entrada nem evento", async () => {
    const team = await legacyImport(ISSUES().slice(0, 12));
    team.history = IDEMPOTENT();
    let limited = false;
    team.historyOverride = (_call, ask) => {
      if (limited || ask.issueId !== null || ask.after === null) return undefined;
      limited = true;
      return { status: 429, headers: { "Retry-After": "30" }, body: {} };
    };
    const run = await start();
    let waited = false;
    let rewound = false;
    let firstHistoryCursor: unknown = undefined;
    for (let i = 0; i < 300; i += 1) {
      const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
      for (const res of [one, two]) expect([200, 409], JSON.stringify(res.body)).toContain(res.status);
      const body = (one.status === 200 ? one.body : two.body) as RunBody;
      const state = (await q("select phase, cursor from external_import_runs where id = $1", [run.id]))[0] as Row;
      if (state["phase"] === "history" && state["cursor"] !== null && firstHistoryCursor === undefined) firstHistoryCursor = state["cursor"];
      if (body.waitUntil) {
        waited = true;
        // Antes de seguir, outra instância repete a primeira página (a trava em memória é por instância): a rodada volta ao começo da fase.
        await q("update external_import_runs set wait_until = null, cursor = null where id = $1", [run.id]);
        rewound = true;
      }
      if (body.done) break;
    }
    expect(waited).toBe(true);
    expect(rewound).toBe(true);
    expect(firstHistoryCursor).not.toBeUndefined();
    const done = (await q("select phase, counts from external_import_runs where id = $1", [run.id]))[0] as Row;
    expect(done["phase"]).toBe("done");
    expect(done["counts"]).toMatchObject({ historyCreated: TOTAL, historyTruncated: 0 });
    expect(await totals()).toEqual({ rows: TOTAL, distinct: TOTAL, events: 12, eventSum: TOTAL, groups: 12 });
  });

  it("o passo repetido depois de gravado (resposta perdida) não grava nem conta de novo", async () => {
    const team = await legacyImport(ISSUES().slice(0, 12));
    team.history = IDEMPOTENT();
    const run = await start();
    let body = run;
    for (let i = 0; i < 100 && body.phase !== "history"; i += 1) body = (await post(`/${run.id}/step`)).body as RunBody;
    const before = (await q("select cursor, counts from external_import_runs where id = $1", [run.id]))[0] as Row;
    await post(`/${run.id}/step`);
    const recorded = (await totals()).rows;
    expect(recorded).toBeGreaterThan(0);
    // Volta o cursor E as contagens ao estado de antes do passo gravado, como outra instância que não viu a resposta.
    await q("update external_import_runs set cursor = $2, counts = $3 where id = $1", [run.id, before["cursor"], before["counts"]]);
    const done = await finish(run);
    // O passo repetido não insere nada (o UNIQUE barra) e por isso não conta: a contagem fica só com o que entrou depois.
    expect(done.counts).toMatchObject({ historyCreated: TOTAL - recorded });
    expect(await totals()).toEqual({ rows: TOTAL, distinct: TOTAL, events: 12, eventSum: TOTAL, groups: 12 });
  });
});
