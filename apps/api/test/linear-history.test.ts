import { mapLinearPriority } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { LINEAR_ERROR_SENTINEL, TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeHistoryEntry, FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 4: histórico das issues (ADR 0061, "Decisão da fatia 4"; TREEPM-482), fase `history`, com `fetch` falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean>; waitUntil?: string | null };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

const SENTINEL = "zed.sentinela@linear.test";
const ANA = "ana.depois@exemplo.test";
const ADMIN = { id: "u-admin", name: "Admin no Linear", email: "admin@exemplo.test" };
const ZED = { id: "u-zed", name: "Zed Externo", email: SENTINEL };
const LETTERS = "abcdefghijkl".split("");
const ISSUES = (): FakeIssue[] => LETTERS.map((id, i) => ({ id, identifier: `ENG-${i + 1}`, title: id.toUpperCase() }));
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 3, day, 10, minute)).toISOString();
const many = (issue: string, n: number): FakeHistoryEntry[] => Array.from({ length: n }, (_, i) => ({ id: `h-${issue}-${n - i}`, createdAt: at(1, n - i), updatedDescription: true }));
/** a: 4 entradas (uma só com mudança fora da lista); b: autor de fora; c: 230 (teto 200); d: datas inválidas. */
const HISTORY = (): Record<string, FakeHistoryEntry[]> => ({
  a: [
    { id: "h-a3", createdAt: at(3), actor: ADMIN, fromState: { id: "s1", name: "Todo", type: "unstarted" }, toState: { id: "s2", name: "Em andamento", type: "started" }, toAssignee: ADMIN, fromPriority: 3, toPriority: 1 },
    { id: "h-a2", createdAt: at(2), bot: "GitHub", fromTitle: "Velho", toTitle: "Novo", updatedDescription: true },
    { id: "h-a1", createdAt: at(1), fromParentId: "x-fora", toParentId: "b" },
    { id: "h-a0", createdAt: at(1), actor: ZED },
  ],
  b: [{ id: "h-b0", createdAt: at(2), actor: { id: "u-ana", name: "Ana no Linear", email: ANA }, toState: { id: "s2", name: "Em andamento", type: "started" }, toAssignee: ZED }],
  c: many("c", 230),
  d: [
    { id: "h-d1", createdAt: "nope", updatedDescription: true },
    { id: "h-d0", createdAt: "1990-01-01T00:00:00.000Z", updatedDescription: true },
  ],
});

async function finish(run: RunBody, steps = 300): Promise<RunBody> {
  for (let i = 0; i < steps; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
const sync = async (): Promise<RunBody> => {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return finish(run.body);
};
const ticketOf = async (letter: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [letter]))[0]!["ticket_id"] as string;
const entry = async (id: string): Promise<Row> => (await q("select * from external_history_entries where external_id = $1", [id]))[0] as Row;
const historyEvents = async (): Promise<Row[]> => q("select subject_id, payload from activity_events where kind = 'ticket.history_imported_from_linear' order by created_at, id");
const historyCalls = () => h.linear().calls.filter((call) => call.query.includes("TeamHistory"));
/** Importa sem histórico. `legacy`: como um projeto importado ANTES desta fatia (nenhuma rodada com a fase `history` inteira). */
async function importWithoutHistory(issues = ISSUES(), legacy = true): Promise<FakeTeamData> {
  const team: FakeTeamData = { projects: [], issues };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  expect((await sync()).phase).toBe("done");
  if (legacy) await q("update external_import_runs set history_since = null, history_complete = false");
  return team;
}

describe("a fase history", () => {
  it("projeto importado antes desta fatia: a primeira sincronização traz o histórico inteiro, normalizado, sem e-mail", async () => {
    const team = await importWithoutHistory();
    team.history = HISTORY();
    h.linear().calls.length = 0;
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ historyCreated: 204, historyIgnored: 3, historyTruncated: 1, historySkipped: 0 });
    expect(done.counts?.["historyIncomplete"]).toBeUndefined();
    // Sem marca anterior: o time inteiro, sem filtro; 12 issues em páginas de 10.
    expect(historyCalls().map((call) => [call.variables["first"], call.variables["since"]])).toEqual([[10, undefined], [10, undefined]]);
    const admin = h.world().people.admin;
    expect(await entry("h-a3")).toMatchObject({
      ticket_id: await ticketOf("a"),
      project_id: open(),
      provider: "linear",
      actor_person_id: admin,
      external_actor_name: null,
      changes: [
        { field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "Em andamento", type: "started" } },
        { field: "assignee", from: null, to: { personId: admin } },
        { field: "priority", from: mapLinearPriority(3), to: mapLinearPriority(1) },
      ],
    });
    expect(((await entry("h-a3"))["occurred_at"] as Date).toISOString()).toBe(at(3));
    expect(await entry("h-a2")).toMatchObject({ actor_person_id: null, external_actor_name: "GitHub", changes: [{ field: "title", from: "Velho", to: "Novo" }, { field: "description" }] });
    expect(await entry("h-a1")).toMatchObject({ actor_person_id: null, external_actor_name: null, changes: [{ field: "parent", from: { ticketId: null }, to: { ticketId: await ticketOf("b") } }] });
    expect(await entry("h-b0")).toMatchObject({ actor_person_id: null, external_actor_name: "Ana no Linear", changes: [{ field: "status", from: null }, { field: "assignee", from: null, to: { name: "Zed Externo" } }] });
    expect(await entry("h-a0")).toBeUndefined();
    expect(await entry("h-d1")).toBeUndefined();
    // As 200 MAIS RECENTES de c.
    expect((await q("select count(*)::int n, min(external_id) lo from external_history_entries where ticket_id = $1", [await ticketOf("c")]))[0]).toEqual({ n: 200, lo: "h-c-100" });
    // Um evento resumido por ticket por página, automático, com a rodada.
    const events = await historyEvents();
    expect(events.map((event) => (event["payload"] as Row)["count"]).sort((x, y) => Number(x) - Number(y))).toEqual([1, 3, 200]);
    expect((events[0]!["payload"] as Row)).toMatchObject({ automatic: true, source: "linear_sync", runId: done.id });
    // Marca d'água: a fase terminou inteira.
    expect((await q("select history_since, history_complete from external_import_runs where id = $1", [done.id]))[0]).toEqual({ history_since: null, history_complete: true });
    // E-mail nunca guardado.
    const dump = JSON.stringify([await q("select * from external_history_entries"), await q("select * from activity_events"), await q("select * from external_import_runs")]);
    for (const email of [SENTINEL, ANA, ADMIN.email]) expect(dump).not.toContain(email);
  });

  it("incremental: a seguinte filtra por updatedAt (início da rodada anterior − 10 min) e lê zero issues; issue alterada traz só o novo, e o autor acompanha o casamento", async () => {
    const team = await importWithoutHistory();
    team.history = HISTORY();
    const first = await sync();
    const startedAt = (await q("select started_at from external_import_runs where id = $1", [first.id]))[0]!["started_at"] as Date;
    const events = (await historyEvents()).length;
    h.linear().calls.length = 0;
    const quiet = await sync();
    expect(quiet.counts).toMatchObject({ historyCreated: 0, historyIgnored: 0, historyTruncated: 0, historySkipped: 0 });
    expect(historyCalls().map((call) => call.variables["since"])).toEqual([new Date(startedAt.getTime() - 10 * 60_000).toISOString()]);
    expect((await historyEvents()).length).toBe(events);

    // Ana passa a existir aqui; b muda no Linear (entrada nova) e é relida: a entrada antiga passa à pessoa.
    const org = (await q("select org_id from people where id = $1", [h.world().people.admin]))[0]!["org_id"];
    const ana = (await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_ana', 'Ana', $2, 'admin') returning id", [org, ANA]))[0]!["id"];
    team.issues = team.issues.map((issue) => (issue.id === "b" ? { ...issue, updatedAt: new Date().toISOString() } : issue));
    team.history.b = [{ id: "h-b1", createdAt: at(5), bot: "Zapier", updatedDescription: true }, ...(team.history.b ?? [])];
    const later = await sync();
    expect(later.counts).toMatchObject({ historyCreated: 1 });
    expect(await entry("h-b0")).toMatchObject({ actor_person_id: ana, external_actor_name: null });
    expect((await historyEvents()).length).toBe(events + 1);
    // Nos dois sentidos: Ana sai, b é relida, a entrada volta ao nome do Linear.
    await q("update people set active = false where id = $1", [ana]);
    team.issues = team.issues.map((issue) => (issue.id === "b" ? { ...issue, updatedAt: new Date(Date.now() + 1000).toISOString() } : issue));
    await sync();
    expect(await entry("h-b0")).toMatchObject({ actor_person_id: null, external_actor_name: "Ana no Linear" });
  });

  it("issue criada no Linear durante uma rodada longa (depois da fase issues, mais de 10 min antes da fase history): a seguinte traz o histórico", async () => {
    const team = await importWithoutHistory(ISSUES().slice(0, 3));
    team.history = { a: [{ id: "h-a1", createdAt: at(1), updatedDescription: true }] };
    const started = await post("", {});
    expect(started.status).toBe(201);
    // A rodada começou há meia hora (limite de taxa, time grande): o começo dela fica bem antes da fase history.
    await q("update external_import_runs set started_at = now() - interval '30 minutes' where id = $1", [started.body.id]);
    let body = started.body as RunBody;
    for (let i = 0; i < 60 && ["projects", "issues"].includes(String(body.phase)); i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as RunBody;
    expect(body.phase).not.toBe("issues");
    // A issue x nasce no Linear depois da fase issues, com duas mudanças; a fase history começa 11 minutos depois.
    const eleven = new Date(Date.now() - 11 * 60_000).toISOString();
    team.issues = [...team.issues, { id: "x", identifier: "ENG-99", title: "Nova", createdAt: eleven, updatedAt: eleven }];
    team.history.x = [
      { id: "h-x2", createdAt: eleven, toAssignee: { id: "u-q", name: "Quem", email: null } },
      { id: "h-x1", createdAt: eleven, fromState: { id: "s0", name: "Backlog", type: "backlog" }, toState: { id: "s1", name: "In Progress", type: "started" } },
    ];
    const first = await finish(body);
    expect(first.counts).toMatchObject({ historySkipped: 1 });
    expect((await q("select history_complete from external_import_runs where id = $1", [first.id]))[0]).toEqual({ history_complete: true });
    // A seguinte: x vira ticket e, como nasceu depois do começo da rodada anterior, é relida.
    await sync();
    expect((await q("select external_id from external_history_entries where external_id like 'h-x%' order by 1")).map((row) => row["external_id"])).toEqual(["h-x1", "h-x2"]);
  });

  it("nada além da linha do histórico muda: tickets, relações, menções, responsáveis, contribuições e eventos ficam iguais (pai concluído incluído)", async () => {
    const issues: FakeIssue[] = [
      { id: "p", identifier: "ENG-1", title: "Pai", state: "completed" },
      { id: "f", identifier: "ENG-2", title: "Filho", parent: "p", state: "completed" },
    ];
    const team = await importWithoutHistory(issues);
    await sync();
    team.issues = team.issues.map((issue) => ({ ...issue, updatedAt: new Date().toISOString() }));
    const snapshot = async () =>
      JSON.stringify([
        await q("select * from tickets order by id"),
        await q("select * from ticket_relations order by id"),
        await q("select * from ticket_assignees order by ticket_id, person_id"),
        await q("select * from ticket_contributions order by id"),
        await q("select * from ticket_contribution_people order by contribution_id, person_id"),
        await q("select * from ticket_comments order by id"),
        await q("select id, kind, subject_id, payload from activity_events where subject_type = 'ticket' and kind <> 'ticket.history_imported_from_linear' order by id"),
        // Notificação = conversa, participante ou mensagem nova (ADR 0055); nenhuma pode aparecer.
        await q("select * from conversations order by id"),
        await q("select * from conversation_participants order by conversation_id, person_id"),
        await q("select * from conversation_messages order by id"),
        await q("select * from ticket_conversations order by id"),
        await q("select * from ticket_conversation_messages order by id"),
      ]);
    const before = await snapshot();
    team.history = {
      f: [
        { id: "h-f2", createdAt: at(4), actor: ADMIN, fromState: { id: "s3", name: "Feito", type: "completed" }, toState: { id: "s2", name: "Em andamento", type: "started" }, toAssignee: ADMIN },
        { id: "h-f1", createdAt: at(3), actor: ADMIN, fromTitle: "[@Admin](person:00000000-0000-7000-8000-000000000001) ENG-1", toTitle: "Filho ENG-1 [@x](person:abc)", fromParentId: null, toParentId: "p" },
      ],
    };
    const done = await sync();
    expect(done.counts).toMatchObject({ historyCreated: 2 });
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify((await entry("h-f1"))["changes"])).not.toMatch(/person:/);
  });

  it("rodada abandonada no meio da fase não avança a marca; truncamento por erro também não", async () => {
    const team = await importWithoutHistory(ISSUES(), false);
    const mark = (await q("select started_at from external_import_runs where history_complete order by started_at desc limit 1"))[0]!["started_at"] as Date;
    team.issues = team.issues.map((issue) => ({ ...issue, updatedAt: new Date().toISOString() }));
    const started = await post("", {});
    let body = started.body as RunBody;
    for (let i = 0; i < 60 && !(body.phase === "history" && (await q("select cursor from external_import_runs where id = $1", [started.body.id]))[0]!["cursor"] !== null); i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as RunBody;
    expect(body.phase).toBe("history");
    expect((await post(`/${String(started.body.id)}/abandon`)).status).toBeLessThan(300);
    const since = async (id: unknown) => ((await q("select history_since from external_import_runs where id = $1", [id]))[0]!["history_since"] as Date).toISOString();
    const expected = new Date(mark.getTime() - 10 * 60_000).toISOString();
    // A página extra de c vem com `errors`: c fica truncada por erro e a marca não anda.
    team.history = { c: many("c", 30) };
    team.poisonedHistoryExtra = ["c"];
    const broken = await sync();
    expect(broken.counts).toMatchObject({ historyCreated: 20, historyTruncated: 1, historyIncomplete: true });
    expect(await since(broken.id)).toBe(expected);
    expect((await q("select history_complete from external_import_runs where id = $1", [broken.id]))[0]).toEqual({ history_complete: false });
    team.poisonedHistoryExtra = [];
    const fixed = await sync();
    expect(await since(fixed.id)).toBe(expected);
    expect(fixed.counts).toMatchObject({ historyCreated: 10 });
  });

  it("rodada abandonada no meio da fase SEM marca anterior: a seguinte lê o time inteiro, sem filtro, e completa só o que faltou", async () => {
    const team = await importWithoutHistory();
    team.history = Object.fromEntries(LETTERS.map((id) => [id, many(id, 2)]));
    const started = await post("", {});
    let body = started.body as RunBody;
    for (let i = 0; i < 60 && !(body.phase === "history" && (await q("select cursor from external_import_runs where id = $1", [started.body.id]))[0]!["cursor"] !== null); i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as RunBody;
    expect(body.phase).toBe("history");
    // Só a primeira página (10 issues × 2) foi gravada antes do abandono.
    expect(await q("select count(*)::int n from external_history_entries")).toEqual([{ n: 20 }]);
    expect((await post(`/${String(started.body.id)}/abandon`)).status).toBeLessThan(300);
    expect((await q("select history_since, history_complete from external_import_runs where id = $1", [started.body.id]))[0]).toEqual({ history_since: null, history_complete: false });
    h.linear().calls.length = 0;
    const next = await sync();
    expect(historyCalls().map((call) => call.variables["since"])).toEqual([undefined, undefined]);
    expect(next.counts).toMatchObject({ historyCreated: 4, historyTruncated: 0 });
    expect(await q("select count(*)::int n, count(distinct external_id)::int d from external_history_entries")).toEqual([{ n: 24, d: 24 }]);
    expect((await q("select history_since, history_complete from external_import_runs where id = $1", [next.id]))[0]).toEqual({ history_since: null, history_complete: true });
  });

  it("counts.historyIncomplete sobrevive a vários passos: marcado na página de c, continua na página seguinte e no fim", async () => {
    const team = await importWithoutHistory();
    team.history = { c: many("c", 30), k: many("k", 2), l: many("l", 2) };
    team.poisonedHistoryExtra = ["c"];
    const started = await post("", {});
    let body = started.body as RunBody;
    const afterHistoryPages: Array<{ created: unknown; incomplete: unknown }> = [];
    let last = 0;
    for (let i = 0; i < 300 && body.done !== true; i += 1) {
      const res = await post(`/${String(started.body.id)}/step`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      body = res.body as RunBody;
      const created = Number(body.counts?.["historyCreated"] ?? 0);
      if (created !== last) afterHistoryPages.push({ created, incomplete: body.counts?.["historyIncomplete"] });
      last = created;
    }
    expect(body.done).toBe(true);
    // Vários passos de página (a extra de c é reduzida antes de truncar e a página encolhe), cada um lendo as contagens do anterior.
    expect(afterHistoryPages.length).toBeGreaterThanOrEqual(2);
    expect(afterHistoryPages[0]).toEqual({ created: 20, incomplete: true });
    expect(afterHistoryPages.every((page) => page.incomplete === true)).toBe(true);
    expect(afterHistoryPages.at(-1)).toEqual({ created: 24, incomplete: true });
    expect(body.counts).toMatchObject({ historyCreated: 24, historyTruncated: 1, historyIncomplete: true });
    expect((await q("select history_complete from external_import_runs where id = $1", [started.body.id]))[0]).toEqual({ history_complete: false });
  });
});

describe("limites e erros do Linear na fase history", () => {
  it("extras que não cabem: a página encolhe sem gravar nada pela metade e tudo chega, sem truncamento", async () => {
    const team = await importWithoutHistory();
    team.history = Object.fromEntries(LETTERS.map((id) => [id, many(id, 30)]));
    const done = await sync();
    expect(done.counts).toMatchObject({ historyCreated: 360, historyTruncated: 0 });
    expect(done.counts?.["historyIncomplete"]).toBeUndefined();
    expect((await q("select history_complete from external_import_runs where id = $1", [done.id]))[0]).toEqual({ history_complete: true });
  });

  it("issue ilegível: relida só pelo id, conta como truncada e a marca não avança; `errors` sem caminho: nada é gravado e a marca não avança", async () => {
    const team = await importWithoutHistory();
    team.history = { a: many("a", 2), e: many("e", 3) };
    team.poisonedHistory = ["e"];
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ historyCreated: 2, historyTruncated: 1, historyIncomplete: true });
    team.poisonedHistory = [];
    team.historyOverride = (_call, ask) => {
      if (ask.issueId !== null || !ask.withHistory) return undefined;
      const start = ask.after === null ? 0 : Number(ask.after);
      const nodes = team.issues.slice(start, start + ask.first).map((issue) => ({ id: issue.id, history: { nodes: (team.history?.[issue.id] ?? []).map((e) => ({ id: e.id, createdAt: e.createdAt, actor: null, botActor: null, updatedDescription: true })), pageInfo: { hasNextPage: false, endCursor: null } } }));
      const end = start + ask.first;
      return { body: { data: { team: { issues: { nodes, pageInfo: { hasNextPage: end < team.issues.length, endCursor: end < team.issues.length ? String(end) : null } } } }, errors: [{ message: "x", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } };
    };
    // Sem caminho, o erro pode estar em qualquer nó: a página é relida menor até uma issue, e cada uma fica sem ler (nada gravado pela metade).
    const used = await sync();
    expect(used.counts).toMatchObject({ historyCreated: 0, historyIncomplete: true });
    expect((await q("select history_complete from external_import_runs where id = $1", [used.id]))[0]).toEqual({ history_complete: false });
    expect(await q("select external_id from external_history_entries where external_id like 'h-e%'")).toEqual([]);
  });

  it("`errors` apontando um campo de um nó do histórico (vem nulo): esse nó não é gravado e segura a marca; os outros entram; a seguinte o grava certo", async () => {
    const team = await importWithoutHistory(ISSUES().slice(0, 2));
    const good: FakeHistoryEntry = { id: "h-a1", createdAt: at(1), actor: ZED, fromState: { id: "s1", name: "Todo", type: "unstarted" }, toState: { id: "s2", name: "In Progress", type: "started" } };
    team.history = { a: [good, { id: "h-a0", createdAt: at(1), updatedDescription: true }], b: [{ id: "h-b1", createdAt: at(1), updatedDescription: true }] };
    let broken = true;
    team.historyOverride = (_call, ask) => {
      if (!broken || ask.issueId !== null || !ask.withHistory) return undefined;
      // O Linear não resolveu `toState` nem `actor` de h-a1: vêm nulos, com `toStateId` preenchido.
      const node = { id: "h-a1", createdAt: good.createdAt, actor: null, botActor: null, fromStateId: "s1", toStateId: "s2", fromState: { name: "Todo", type: "unstarted" }, toState: null, updatedDescription: null };
      const other = { id: "h-a0", createdAt: at(1), actor: null, botActor: null, updatedDescription: true };
      const b = { id: "h-b1", createdAt: at(1), actor: null, botActor: null, updatedDescription: true };
      const conn = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      const error = (...path: (string | number)[]) => ({ message: `Internal error ${LINEAR_ERROR_SENTINEL}`, path, extensions: { code: "INTERNAL_SERVER_ERROR", userPresentableMessage: LINEAR_ERROR_SENTINEL } });
      return {
        body: {
          data: { team: { issues: { nodes: [{ id: "a", history: conn([node, other]) }, { id: "b", history: conn([b]) }], pageInfo: { hasNextPage: false, endCursor: null } } } },
          errors: [error("team", "issues", "nodes", 0, "history", "nodes", 0, "toState"), error("team", "issues", "nodes", 0, "history", "nodes", 0, "actor")],
        },
      };
    };
    const first = await sync();
    expect(first.counts).toMatchObject({ historyCreated: 2, historyIncomplete: true });
    expect(await entry("h-a1")).toBeUndefined();
    expect((await q("select external_id from external_history_entries order by 1")).map((row) => row["external_id"])).toEqual(["h-a0", "h-b1"]);
    expect((await q("select history_complete from external_import_runs where id = $1", [first.id]))[0]).toEqual({ history_complete: false });
    expect(JSON.stringify([first, await q("select * from external_import_runs"), await q("select payload from activity_events")])).not.toContain(LINEAR_ERROR_SENTINEL);
    // O Linear volta ao normal; nada mudou nas issues: a marca não avançou, então a issue é relida e a entrada entra certa.
    broken = false;
    const second = await sync();
    expect(second.counts).toMatchObject({ historyCreated: 1 });
    expect(second.counts?.["historyIncomplete"]).toBeUndefined();
    expect(await entry("h-a1")).toMatchObject({ external_actor_name: "Zed Externo", changes: [{ field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "In Progress", type: "started" } }] });
  });

  it("`errors` apontando a issue (o histórico dela veio nulo): nada dela é gravado e a marca não avança; as outras entram; a seguinte a lê", async () => {
    const team = await importWithoutHistory(ISSUES().slice(0, 3));
    team.history = { a: [{ id: "h-a1", createdAt: at(1), updatedDescription: true }], b: [{ id: "h-b1", createdAt: at(1), updatedDescription: true }], c: [{ id: "h-c1", createdAt: at(1), updatedDescription: true }] };
    let broken = true;
    team.historyOverride = (_call, ask) => {
      if (!broken || ask.issueId !== null || !ask.withHistory) return undefined;
      const node = (id: string) => ({ id, history: { nodes: [{ id: `h-${id}1`, createdAt: at(1), actor: null, botActor: null, updatedDescription: true }], pageInfo: { hasNextPage: false, endCursor: null } } });
      return { body: { data: { team: { issues: { nodes: [node("a"), { id: "b", history: null }, node("c")], pageInfo: { hasNextPage: false, endCursor: null } } } }, errors: [{ message: "Internal error", path: ["team", "issues", "nodes", 1, "history"], extensions: { code: "INTERNAL_SERVER_ERROR" } }] } };
    };
    const first = await sync();
    expect(first.counts).toMatchObject({ historyCreated: 2, historyIncomplete: true });
    expect((await q("select history_complete from external_import_runs where id = $1", [first.id]))[0]).toEqual({ history_complete: false });
    broken = false;
    await sync();
    expect((await q("select external_id from external_history_entries order by 1")).map((row) => row["external_id"])).toEqual(["h-a1", "h-b1", "h-c1"]);
  });

  it("página extra em que a issue volta nula (sumiu ou deixou de ser visível): conta como incompleta, sem derrubar o passo; a seguinte lê o resto", async () => {
    const team = await importWithoutHistory(ISSUES().slice(0, 3));
    team.history = { a: many("a", 30) };
    let broken = true;
    team.historyOverride = (_call, ask) => (broken && ask.issueId !== null ? { body: { data: { issue: null } } } : undefined);
    const first = await sync();
    expect(first.counts).toMatchObject({ historyCreated: 20, historyTruncated: 1, historyIncomplete: true });
    expect((await q("select history_complete from external_import_runs where id = $1", [first.id]))[0]).toEqual({ history_complete: false });
    broken = false;
    const second = await sync();
    expect(second.counts).toMatchObject({ historyCreated: 10 });
    expect(await q("select count(*)::int n from external_history_entries")).toEqual([{ n: 30 }]);
  });

  it("página extra que estoura (complexidade): é pedida pela metade e a leitura continua no tamanho menor até as 200; só no mínimo fica incompleta", async () => {
    const team = await importWithoutHistory(ISSUES().slice(0, 3));
    team.history = { a: many("a", 230), b: many("b", 110) };
    let limit = 90;
    const complexity = { body: { data: null, errors: [{ message: `Query too complex ${LINEAR_ERROR_SENTINEL}`, extensions: { code: "QUERY_COMPLEXITY" } }] } };
    team.historyOverride = (_call, ask) => (ask.issueId !== null && ask.first > limit ? complexity : undefined);
    const extraFirsts = () => h.linear().calls.filter((call) => call.query.includes("IssueHistory")).map((call) => [call.variables["id"], call.variables["first"]]);
    h.linear().calls.length = 0;
    const done = await sync();
    // a: 20 + 90 + 90 = 200 (o teto; não segura a marca); b: 20 + 90 = 110 (a issue inteira).
    expect(done.counts).toMatchObject({ historyCreated: 310, historyTruncated: 1 });
    expect(done.counts?.["historyIncomplete"]).toBeUndefined();
    expect((await q("select history_complete from external_import_runs where id = $1", [done.id]))[0]).toEqual({ history_complete: true });
    // (Quando a de b não cabe no passo, a página encolhe e a de a é relida: o começo é o que importa.)
    expect(extraFirsts().filter(([id]) => id === "a").slice(0, 3)).toEqual([["a", 180], ["a", 90], ["a", 90]]);
    // Estoura em qualquer tamanho: reduz até o mínimo e só então a issue conta como incompleta; o passo não falha.
    await q("delete from external_history_entries");
    await q("update external_import_runs set history_since = null, history_complete = false");
    limit = 0;
    h.linear().calls.length = 0;
    const broken = await sync();
    expect(broken.counts).toMatchObject({ historyCreated: 40, historyIncomplete: true });
    const sizes = extraFirsts().filter(([id]) => id === "a").map(([, first]) => Number(first));
    expect(sizes[0]).toBe(180);
    // Cada pedido é a metade do anterior (mínimo 20), ou recomeça em 180 quando a página encolheu e a issue é relida noutro passo. O
    // teto de 6 chamadas do passo pode acabar antes do 20: aí a issue também fica incompleta.
    expect(sizes.every((size, i) => i === 0 || size === 180 || size === Math.max(20, Math.floor((sizes[i - 1] as number) / 2)))).toBe(true);
    expect(sizes).toContain(45);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(broken)).not.toContain(LINEAR_ERROR_SENTINEL);
  });

  it("limite de taxa na página extra: a rodada espera (waitUntil) sem gravar a página; issue de fora do projeto conta em historySkipped", async () => {
    const team = await importWithoutHistory();
    team.history = { a: many("a", 25) };
    let limited = true;
    team.historyOverride = (_call, ask) => {
      if (ask.issueId !== null && limited) return { status: 429, headers: { "Retry-After": "30" }, body: {} };
      if (ask.issueId === null && ask.withHistory && ask.after === null) {
        return { body: { data: { team: { issues: { nodes: [{ id: "x-fora", history: { nodes: [{ id: "h-x", createdAt: at(1), updatedDescription: true }], pageInfo: { hasNextPage: false, endCursor: null } } }], pageInfo: { hasNextPage: true, endCursor: "0" } } } } } };
      }
      return undefined;
    };
    const started = await post("", {});
    let body = started.body as RunBody;
    for (let i = 0; i < 80 && !body.waitUntil; i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as RunBody;
    expect(body).toMatchObject({ phase: "history" });
    expect(body.waitUntil).not.toBeNull();
    expect(await q("select count(*)::int n from external_history_entries")).toEqual([{ n: 0 }]);
    limited = false;
    await q("update external_import_runs set wait_until = null where id = $1", [started.body.id]);
    const done = await finish(started.body as RunBody);
    expect(done.counts).toMatchObject({ historyCreated: 25, historySkipped: 1 });
  });
});
