import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// L12: a situação sai da leitura das páginas e vai para a fase `statuses`; reimportação abandonada; achados menores da revisão.
// `fetch` falso: nada chama o Linear nem provedor de IA.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; mode?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}, who: Parameters<typeof as>[0] = "admin") => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const patch = (id: unknown, body: unknown) => h.call("PATCH", `/api/tickets/${String(id)}`, as("admin"), body);
afterEach(() => vi.restoreAllMocks());

async function finish(run: RunBody, max = 200): Promise<RunBody> {
  for (let i = 0; i < max; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
async function begin(body: unknown = {}): Promise<RunBody> {
  const run = await post("", body);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body;
}
const runAll = async (body: unknown = {}): Promise<RunBody> => finish(await begin(body));
const byExt = async (): Promise<Map<string, Row>> =>
  new Map(
    (
      await q(
        `select r.external_id, r.kind, r.missing_since, r.hierarchy_pending, r.status_pending, r.source_snapshot, r.applied_snapshot, t.id, t.number, t.title, t.status, t.parent_id,
                coalesce((select array_agg(a.person_id::text order by a.person_id) from ticket_assignees a where a.ticket_id = t.id), '{}') as assignees
           from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid`,
        [open()],
      )
    ).map((row) => [row["external_id"] as string, row]),
  );
const eventsOf = async (kind = "ticket.updated") => q("select subject_id, payload from activity_events where kind = $1 order by occurred_at, id", [kind]);
const eventCount = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]!["n"] as number;

type World = { data: Record<string, FakeTeamData>; list: FakeIssue[] };
const world = (list: FakeIssue[], projectStatus = "started"): World => ({ list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa", status: projectStatus }], issues: list } } });
const issue = (w: World, id: string): FakeIssue => w.list.find((item) => item.id === id) as FakeIssue;
const setProject = (w: World, status: string): void => void (w.data[TEAM_ENG.id]!.projects[0]!.status = status);
async function firstImport(w: World): Promise<RunBody> {
  await linkWithData(h, put, open(), w.data);
  return runAll();
}
const status = (rows: Map<string, Row>, id: string) => rows.get(id)!["status"];
const appliedStatus = (rows: Map<string, Row>, id: string) => (rows.get(id)!["applied_snapshot"] as Row)["status"];
/** Duas rodadas sem mudança: zero atualizações, zero eventos novos e nenhum retrato regravado com outro valor. */
async function expectQuiet(): Promise<void> {
  const before = await eventCount();
  const snapshots = JSON.stringify((await q("select external_id, source_snapshot, applied_snapshot from ticket_external_refs order by external_id")));
  for (let i = 0; i < 2; i += 1) expect((await runAll()).counts).toMatchObject({ updated: 0, keptTouched: 0, issuesCreated: 0, reopened: 0 });
  expect(await eventCount()).toBe(before);
  expect(JSON.stringify(await q("select external_id, source_snapshot, applied_snapshot from ticket_external_refs order by external_id"))).toBe(snapshots);
  // Pode sobrar ticket em desvio (status_pending: uma invariante o impede); a marca da hierarquia, não.
  expect((await q("select count(*)::int n from ticket_external_refs where hierarchy_pending"))[0]!["n"]).toBe(0);
}

describe("item 1: a situação é decidida na fase statuses, com a árvore já no lugar", () => {
  it("o projeto do Linear e as issues dele concluídos juntos: tudo conclui (nada é rebaixado no meio)", async () => {
    const w = world([
      { id: "x", identifier: "ENG-1", title: "X", state: "started", project: "lp1" },
      { id: "y", identifier: "ENG-2", title: "Y", state: "started", project: "lp1" },
    ]);
    await firstImport(w);
    expect(status(await byExt(), "lp1")).toBe("in_progress");
    setProject(w, "completed");
    issue(w, "x").state = "completed";
    issue(w, "y").state = "completed";
    const second = await runAll();
    const rows = await byExt();
    for (const id of ["lp1", "x", "y"]) {
      expect(status(rows, id), id).toBe("done");
      expect(appliedStatus(rows, id), id).toBe("done");
      expect(((rows.get(id)!["source_snapshot"] as Row)["pendingStatus"]), id).toBeUndefined();
    }
    expect(second.counts).toMatchObject({ updated: 3 });
    // um evento de situação por ticket, e nenhum "a fazer" no meio do caminho
    const moves = (await eventsOf()).filter((e) => (e["payload"] as Row)["runId"] === second.id).map((e) => (e["payload"] as { status?: { to: string } }).status?.to);
    expect(moves.sort()).toEqual(["done", "done", "done"]);
    await expectQuiet();
  });

  it.each([
    ["pai antes da filha", ["p", "c"]],
    ["filha antes do pai", ["c", "p"]],
  ])("issue-pai e filha concluídas juntas, %s na lista", async (_label, order) => {
    const all: Record<string, FakeIssue> = {
      p: { id: "p", identifier: "ENG-1", title: "Pai", state: "started" },
      c: { id: "c", identifier: "ENG-2", title: "Filha", state: "started", parent: "p" },
    };
    const w = world(order.map((id) => all[id] as FakeIssue));
    await firstImport(w);
    issue(w, "p").state = "completed";
    issue(w, "c").state = "completed";
    const second = await runAll();
    const rows = await byExt();
    expect(status(rows, "p")).toBe("done");
    expect(status(rows, "c")).toBe("done");
    expect(appliedStatus(rows, "p")).toBe("done");
    expect(appliedStatus(rows, "c")).toBe("done");
    expect(second.counts).toMatchObject({ updated: 2 });
    await expectQuiet();
  });

  it.each([
    ["filho antes do pai", ["c", "p"]],
    ["pai antes do filho", ["p", "c"]],
  ])("filho reaberto com pai concluído, %s na lista: o pai reabre com evento e retrato; depois o Linear cancela o pai e aplica", async (_label, order) => {
    const all: Record<string, FakeIssue> = {
      p: { id: "p", identifier: "ENG-1", title: "Pai", state: "completed" },
      c: { id: "c", identifier: "ENG-2", title: "Filho", state: "completed", parent: "p" },
    };
    const w = world(order.map((id) => all[id] as FakeIssue));
    await firstImport(w);
    expect(status(await byExt(), "p")).toBe("done");
    issue(w, "c").state = "started";
    const second = await runAll();
    let rows = await byExt();
    expect(status(rows, "c")).toBe("in_progress");
    expect(status(rows, "p")).toBe("todo");
    expect(appliedStatus(rows, "p")).toBe("todo");
    expect(appliedStatus(rows, "c")).toBe("in_progress");
    // o pai reaberto tem UM evento automático de situação e o filho outro; nenhum outro
    const pEvents = (await eventsOf()).filter((e) => e["subject_id"] === rows.get("p")!["id"] && (e["payload"] as Row)["automatic"] === true);
    expect(pEvents).toHaveLength(1);
    expect(second.counts).toMatchObject({ updated: 1, reopened: 1, keptTouched: 0 });
    await expectQuiet();
    // o Linear cancela o pai: nada mexeu nele aqui (a reabertura foi anotada no retrato), então aplica
    issue(w, "p").state = "canceled";
    const third = await runAll();
    rows = await byExt();
    expect(status(rows, "p")).toBe("cancelled");
    expect(third.counts).toMatchObject({ updated: 1, keptTouched: 0 });
    await expectQuiet();
  });

  it("a pessoa conclui o pai à mão e o Linear muda o pai: fica o da pessoa (keptTouched), e a pendência acaba", async () => {
    const w = world([
      { id: "p", identifier: "ENG-1", title: "Pai", state: "unstarted" },
      { id: "c", identifier: "ENG-2", title: "Filho", state: "completed", parent: "p" },
    ]);
    await firstImport(w);
    const before = await byExt();
    expect((await patch(before.get("p")!["id"], { status: "done" })).status).toBe(200);
    issue(w, "p").state = "started";
    const second = await runAll();
    const rows = await byExt();
    expect(status(rows, "p")).toBe("done");
    expect(second.counts).toMatchObject({ keptTouched: 1, updated: 0 });
    expect((rows.get("p")!["source_snapshot"] as Row)["stateType"]).toBe("started");
    expect(rows.get("p")!["status_pending"]).toBe(false);
    await expectQuiet();
  });

  it("concluído com filho aberto não é aplicável agora: o ticket mantém a situação (em andamento NÃO vira a fazer), a pendência fica e a rodada seguinte tenta de novo sem contar como mexido aqui", async () => {
    const w = world([
      { id: "p", identifier: "ENG-1", title: "Pai", state: "started" },
      { id: "c", identifier: "ENG-2", title: "Filho", state: "unstarted", parent: "p" },
    ]);
    await firstImport(w);
    expect(status(await byExt(), "p")).toBe("in_progress");
    issue(w, "p").state = "completed";
    const second = await runAll();
    let rows = await byExt();
    expect(status(rows, "p")).toBe("in_progress");
    expect(rows.get("p")!["status_pending"]).toBe(true);
    expect(second.counts).toMatchObject({ updated: 0, keptTouched: 0 });
    // sem mudança no Linear, a pendência segue sem evento nem contagem
    const events = await eventCount();
    expect((await runAll()).counts).toMatchObject({ updated: 0, keptTouched: 0 });
    expect(await eventCount()).toBe(events);
    // o filho termina no Linear: a rodada seguinte aplica o concluído do pai
    issue(w, "c").state = "completed";
    const fourth = await runAll();
    rows = await byExt();
    expect(status(rows, "c")).toBe("done");
    expect(status(rows, "p")).toBe("done");
    expect(rows.get("p")!["status_pending"]).toBe(false);
    expect(fourth.counts).toMatchObject({ updated: 2, keptTouched: 0 });
    await expectQuiet();
  });

  it("rodada abandonada antes de statuses: a situação não foi aplicada (o retrato de origem avançou, o aplicado não: é desvio calculado) e a seguinte aplica", async () => {
    const w = world([{ id: "a", identifier: "ENG-1", title: "A", state: "unstarted" }]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await begin();
    for (let i = 0; i < 20; i += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.body.phase === "hierarchy" || res.body.phase === "statuses") break;
    }
    expect((await post(`/${run.id}/abandon`)).body.phase).toBe("failed");
    const rows = await byExt();
    expect(status(rows, "a")).toBe("todo");
    expect(rows.get("a")!["status_pending"]).toBe(true);
    expect((rows.get("a")!["source_snapshot"] as Row)["stateType"]).toBe("completed");
    expect(appliedStatus(rows, "a")).toBe("todo");
    const next = await runAll();
    expect(next.counts).toMatchObject({ updated: 1 });
    expect(status(await byExt(), "a")).toBe("done");
    await expectQuiet();
  });

  it("a primeira importação (hierarchy) não tem o mesmo defeito: projeto e issues concluídos, filha antes do pai", async () => {
    const w = world(
      [
        { id: "c", identifier: "ENG-2", title: "Filha", state: "completed", parent: "p", project: "lp1" },
        { id: "p", identifier: "ENG-1", title: "Pai", state: "completed", project: "lp1" },
      ],
      "completed",
    );
    await firstImport(w);
    const rows = await byExt();
    for (const id of ["lp1", "p", "c"]) {
      expect(status(rows, id), id).toBe("done");
      expect(appliedStatus(rows, id), id).toBe("done");
    }
  });
});

describe("item 2: o que a rodada abandonada criou desce para o pai na rodada seguinte", () => {
  it("origem nova nasce pendente e uma rodada abandonada antes de hierarchy não a perde", async () => {
    const w = world([{ id: "a", identifier: "ENG-1", title: "A" }]);
    await firstImport(w);
    w.list.push({ id: "g", identifier: "ENG-2", title: "G", parent: "a" });
    const run = await begin();
    for (let i = 0; i < 20; i += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.body.phase === "hierarchy") break;
    }
    expect((await post(`/${run.id}/abandon`)).body.phase).toBe("failed");
    let rows = await byExt();
    expect(rows.get("g")!["hierarchy_pending"]).toBe(true);
    expect(rows.get("g")!["parent_id"]).toBeNull();
    const next = await runAll();
    rows = await byExt();
    expect(rows.get("g")!["parent_id"]).toBe(rows.get("a")!["id"]);
    expect(rows.get("g")!["hierarchy_pending"]).toBe(false);
    expect(next.counts).toMatchObject({ issuesCreated: 0, parentsLinked: 1 });
    await expectQuiet();
  });

  it("issue nova que é o pai de uma já importada (o pai estava em outro time e chegou agora): a filha desce", async () => {
    const w = world([{ id: "z", identifier: "ENG-1", title: "Z", parent: "zp" }]);
    await firstImport(w);
    expect((await byExt()).get("z")!["parent_id"]).toBeNull();
    w.list.push({ id: "zp", identifier: "ENG-2", title: "ZP" });
    const second = await runAll();
    const rows = await byExt();
    expect(second.counts).toMatchObject({ issuesCreated: 1, parentsLinked: 1 });
    expect(rows.get("z")!["parent_id"]).toBe(rows.get("zp")!["id"]);
  });
});

describe("item 3: achados menores", () => {
  it("e-mail que passa a ser legível atribui o responsável (mesmo sem mudança do id no Linear)", async () => {
    const w = world([{ id: "d", identifier: "ENG-1", title: "D", assignee: { id: "u-admin", email: "admin@exemplo.test" } }]);
    const emailError = { body: { errors: [{ message: "no permission", path: ["team", "issues", "nodes", 0, "assignee", "email"], extensions: { code: "FORBIDDEN" } }], data: null } };
    await linkWithData(h, put, open(), w.data);
    w.data[TEAM_ENG.id]!.override = (_call, ask) => (ask.withEmail ? emailError : undefined);
    const first = await runAll();
    expect(first.counts).toMatchObject({ assigneeEmailUnavailable: true });
    expect((await byExt()).get("d")!["assignees"]).toEqual([]);
    delete w.data[TEAM_ENG.id]!.override;
    const second = await runAll();
    expect((await byExt()).get("d")!["assignees"]).toEqual([h.world().people.admin]);
    expect(second.counts).toMatchObject({ updated: 1 });
    expect(JSON.stringify(await q("select applied_snapshot from ticket_external_refs"))).toContain(h.world().people.admin);
    await expectQuiet();
  });

  it("mover ticket que já existia na hierarquia grava ticket.updated automático com parentId, e entrar em ideia encerra o marcador da IA", async () => {
    const w = world([
      { id: "p1", identifier: "ENG-1", title: "P1" },
      { id: "p2", identifier: "ENG-2", title: "P2" },
      { id: "h", identifier: "ENG-3", title: "H", parent: "p1" },
    ]);
    await firstImport(w);
    const rows0 = await byExt();
    // p2 vira ideia; h tem marcador de trabalho da IA
    expect((await h.call("POST", `/api/tickets/${rows0.get("p2")!["id"]}/idea`, as("admin"))).status).toBe(200);
    await q(
      "update tickets set agent_work_started_at = now(), agent_work_until = now() + interval '1 hour', agent_work_note = 'x', agent_work_person_id = $2::uuid where id = $1::uuid",
      [rows0.get("h")!["id"], h.world().people.admin],
    );
    issue(w, "h").parent = "p2";
    const second = await runAll();
    const rows = await byExt();
    expect(rows.get("h")!["parent_id"]).toBe(rows.get("p2")!["id"]);
    expect(second.counts).toMatchObject({ parentsLinked: 1 });
    const moved = (await eventsOf()).filter((e) => e["subject_id"] === rows.get("h")!["id"] && (e["payload"] as Row)["source"] === "linear_reimport");
    expect(moved).toHaveLength(1);
    expect(moved[0]!["payload"]).toMatchObject({ automatic: true, fields: ["parentId"], parentId: { from: rows0.get("p1")!["id"], to: rows.get("p2")!["id"] }, runId: second.id });
    expect((await q("select agent_work_until from tickets where id = $1::uuid", [rows.get("h")!["id"]]))[0]!["agent_work_until"]).toBeNull();
    expect((await eventsOf("ticket.agent_work_ended")).map((e) => (e["payload"] as Row)["reason"])).toEqual(["idea"]);
    // e o retrato aplicado acompanha o pai novo
    expect((rows.get("h")!["applied_snapshot"] as Row)["parentId"]).toBe(rows.get("p2")!["id"]);
  });

  it("a linha do tempo mostra o que a reimportação mudou como automático, inclusive a troca de responsável", async () => {
    const w = world([{ id: "d", identifier: "ENG-1", title: "D", assignee: { id: "u-admin", email: "admin@exemplo.test" } }]);
    await firstImport(w);
    issue(w, "d").assignee = { id: "u-manager", email: "manager@exemplo.test" };
    issue(w, "d").title = "D novo";
    issue(w, "d").state = "started";
    // título, responsável (fase issues) e situação (fase statuses) no mesmo ticket: conta UMA atualização (o ticket do projeto do Linear é o unchanged)
    expect((await runAll()).counts).toMatchObject({ updated: 1, keptTouched: 0, unchanged: 1 });
    const rows = await byExt();
    const feed = (await h.call("GET", `/api/tickets/${rows.get("d")!["id"]}/activity`, as("admin"))).body.entries as { type: string; automatic?: boolean; person?: { id: string } | null }[];
    const kinds = feed.map((entry) => entry.type);
    expect(kinds).toEqual(expect.arrayContaining(["title_changed", "status_changed", "assignee_added", "assignee_removed"]));
    for (const type of ["title_changed", "status_changed", "assignee_added", "assignee_removed"]) expect(feed.find((entry) => entry.type === type)?.automatic, type).toBe(true);
    expect(feed.find((entry) => entry.type === "assignee_added")?.person?.id).toBe(h.world().people.manager);
    expect(feed.find((entry) => entry.type === "assignee_removed")?.person?.id).toBe(h.world().people.admin);
    // a edição de uma pessoa continua sem a marca
    await patch(rows.get("d")!["id"], { title: "D da pessoa" });
    const again = (await h.call("GET", `/api/tickets/${rows.get("d")!["id"]}/activity`, as("admin"))).body.entries as { type: string; automatic?: boolean }[];
    expect(again.find((entry) => entry.type === "title_changed")?.automatic).not.toBe(true);
  });

  it("transação estourada (P2028) num passo de reimportação reduz a página em vez de repetir igual", async () => {
    const w = world([{ id: "a", identifier: "ENG-1", title: "A" }]);
    await firstImport(w);
    issue(w, "a").title = "A novo";
    const run = await begin();
    let guard = 0;
    for (; guard < 10; guard += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.body.phase === "issues") break;
    }
    const before = (await q("select page_size from external_import_runs where id = $1::uuid", [run.id]))[0]!["page_size"] as number;
    const spy = vi.spyOn(TicketsService.prototype, "lockStructure").mockRejectedValueOnce(Object.assign(new Error("Transaction already closed"), { code: "P2028" }));
    const failed = await post(`/${run.id}/step`);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    spy.mockRestore();
    const after = (await q("select page_size, error_streak from external_import_runs where id = $1::uuid", [run.id]))[0]!;
    expect(after["page_size"] as number).toBeLessThan(before);
    expect(after["error_streak"]).toBe(0);
    await finish(run);
  });

  it("guarda de sanidade: se a rodada não viu nenhuma issue e há origens no projeto, nada é marcado como não encontrado", async () => {
    const w = world([
      { id: "a", identifier: "ENG-1", title: "A" },
      { id: "b", identifier: "ENG-2", title: "B" },
    ]);
    await firstImport(w);
    w.list.length = 0;
    const second = await runAll();
    expect(second.counts).toMatchObject({ missing: 0, missingNotChecked: true });
    expect((await q("select count(*)::int n from ticket_external_refs where missing_since is not null"))[0]!["n"]).toBe(0);
  });

  it("destino apagado no meio da rodada: o item que iria ao destino fica onde está e conta em skipped (não vai à raiz em silêncio)", async () => {
    const dest = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    const w = world([
      { id: "p", identifier: "ENG-1", title: "P" },
      { id: "h", identifier: "ENG-2", title: "H", parent: "p" },
    ]);
    await linkWithData(h, put, open(), w.data);
    await runAll({ destinationTicketId: dest });
    issue(w, "h").parent = null;
    const run = await begin();
    for (let i = 0; i < 20; i += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.body.phase === "hierarchy") break;
    }
    await q("update external_import_runs set destination_ticket_id = null where id = $1::uuid", [run.id]);
    const done = await finish(run);
    const rows = await byExt();
    expect(rows.get("h")!["parent_id"]).toBe(rows.get("p")!["id"]);
    expect(done.counts).toMatchObject({ skipped: 1 });
  });

  it("o índice antigo saiu e há um que serve à varredura por projeto e ticket", async () => {
    const idx = (await q("select indexname from pg_indexes where tablename = 'ticket_external_refs'")).map((row) => row["indexname"]);
    expect(idx).not.toContain("ticket_external_refs_seen_idx");
    expect(idx).toContain("ticket_external_refs_project_ticket_idx");
  });
});

describe("item 3: testes antes fracos, agora de verdade", () => {
  it("descrição que não veio: página reduzida a 1 e sem descrição não toca o campo, e a mudança não se perde", async () => {
    const w = world([
      { id: "a", identifier: "ENG-1", title: "A", description: "Descrição A" },
      { id: "b", identifier: "ENG-2", title: "B", description: "Descrição B" },
    ]);
    await firstImport(w);
    issue(w, "b").description = "Descrição B nova";
    // o Linear estoura sempre que a descrição é pedida: a página cai para 1 e depois sem descrição
    w.data[TEAM_ENG.id]!.override = (_call, ask) => (ask.withDescription ? { raw: "x".repeat(4 * 1024 * 1024 + 16) } : undefined);
    const run = await begin();
    let second: RunBody = run;
    for (let i = 0; i < 60 && !second.done; i += 1) {
      const res = await post(`/${run.id}/step`); // um passo pode terminar em erro enquanto a página encolhe; o seguinte continua
      if (res.status === 200) second = res.body;
    }
    expect(second.done).toBe(true);
    const rows = await q("select t.description from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.external_id = 'b'");
    expect(rows[0]!["description"]).toBe("Descrição B");
    expect(second.counts).toMatchObject({ descriptionUnavailable: true });
    delete w.data[TEAM_ENG.id]!.override;
    await runAll();
    expect((await q("select t.description from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.external_id = 'b'"))[0]!["description"]).toBe("Descrição B nova");
  });
});
