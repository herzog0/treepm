import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// L14: a situação converge (uma regra só: desejada = a do Linear mapeada; mexida aqui = atual ≠ aplicada; só uma invariante impede e
// então o ticket fica em desvio e é reavaliado em toda reimportação) e os lotes encolhem quando a transação estoura. `fetch` falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; mode?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}, who: Parameters<typeof as>[0] = "admin") => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const patch = (id: unknown, body: unknown) => h.call("PATCH", `/api/tickets/${String(id)}`, as("admin"), body);
afterEach(() => vi.restoreAllMocks());

async function finish(run: RunBody, max = 400): Promise<RunBody> {
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
/** Passos até a rodada ESTAR na fase dada (a próxima a executar). */
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
const byExt = async (): Promise<Map<string, Row>> =>
  new Map(
    (
      await q(
        `select r.external_id, r.kind, r.hierarchy_pending, r.status_pending, r.last_seen_run_id, r.source_snapshot, r.applied_snapshot, t.id, t.number, t.title, t.status, t.parent_id
           from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid`,
        [open()],
      )
    ).map((row) => [row["external_id"] as string, row]),
  );
/** Todos os eventos, por tipo, menos os do resumo da própria rodada (um por rodada, sobre o projeto, não sobre tickets). */
const eventCount = async (): Promise<string> =>
  JSON.stringify(await q("select kind, count(*)::int n from activity_events where kind not in ('ticket.imported_from_linear', 'ticket.import_abandoned_from_linear') group by kind order by kind"));
const snapshots = async (): Promise<string> => JSON.stringify(await q("select external_id, source_snapshot, applied_snapshot, status_pending, hierarchy_pending from ticket_external_refs order by external_id"));
/** Situação, pai e título de todos os tickets. */
const ticketState = async (): Promise<string> => JSON.stringify(await q("select id, title, status, parent_id from tickets order by id"));

type World = { data: Record<string, FakeTeamData>; list: FakeIssue[] };
const world = (list: FakeIssue[], projectStatus = "started"): World => ({ list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa", status: projectStatus }], issues: list } } });
const issue = (w: World, id: string): FakeIssue => w.list.find((item) => item.id === id) as FakeIssue;
async function firstImport(w: World, body: unknown = {}): Promise<RunBody> {
  await linkWithData(h, put, open(), w.data);
  return runAll(body);
}
const status = (rows: Map<string, Row>, id: string) => rows.get(id)!["status"];
const appliedStatus = (rows: Map<string, Row>, id: string) => (rows.get(id)!["applied_snapshot"] as Row)["status"];
/** Duas rodadas sem mudança: zero atualizações, zero eventos e retratos idênticos, mesmo com ticket em desvio ou pendente. */
async function expectQuiet(): Promise<void> {
  const before = await eventCount();
  const snaps = await snapshots();
  const tickets = await ticketState();
  for (let i = 0; i < 2; i += 1) expect((await runAll()).counts).toMatchObject({ updated: 0, keptTouched: 0, issuesCreated: 0, keptMoved: 0 });
  expect(await eventCount()).toBe(before);
  expect(await snapshots()).toBe(snaps);
  expect(await ticketState()).toBe(tickets);
}
const one = (id: string, state: string, extra: Partial<FakeIssue> = {}): FakeIssue => ({ id, identifier: `ENG-${id.replace(/\D/g, "") || "9"}${id.length}`, title: `Issue ${id}`, state, ...extra });

describe("item 1: a hierarquia só move; a situação é da fase statuses", () => {
  it("pai concluído e filho em andamento na raiz; o Linear põe o filho dentro do pai e o conclui na mesma rodada: os dois ficam concluídos", async () => {
    const w = world([one("p", "completed"), one("c", "started")]);
    await firstImport(w);
    expect(status(await byExt(), "p")).toBe("done");
    issue(w, "c").parent = "p";
    issue(w, "c").state = "completed";
    const second = await runAll();
    const rows = await byExt();
    expect(rows.get("c")!["parent_id"]).toBe(rows.get("p")!["id"]);
    expect(status(rows, "p")).toBe("done");
    expect(status(rows, "c")).toBe("done");
    expect(appliedStatus(rows, "p")).toBe("done");
    expect(second.counts).toMatchObject({ updated: 1 });
    await expectQuiet();
  });

  it("filho aberto movido para baixo de um pai concluído (sem mudar de situação): o pai segue o filho (ADR 0068)", async () => {
    const w = world([one("p", "completed"), one("c", "started")]);
    await firstImport(w);
    issue(w, "c").parent = "p";
    const second = await runAll();
    const rows = await byExt();
    expect(status(rows, "c")).toBe("in_progress");
    expect(status(rows, "p")).toBe("in_progress");
    expect(appliedStatus(rows, "p")).toBe("in_progress");
    expect(second.counts).toMatchObject({ updated: 0, keptTouched: 0 });
    await expectQuiet();
  });

  it("rodada abandonada entre hierarchy e statuses: as marcas sobrevivem e a seguinte aplica a situação do filho, e o pai o segue", async () => {
    const w = world([one("p", "completed"), one("c", "completed")]);
    await firstImport(w);
    issue(w, "c").parent = "p";
    issue(w, "c").state = "started";
    const run = await stepUntil(await begin(), "statuses");
    const mid = await byExt();
    expect(mid.get("c")!["parent_id"]).toBe(mid.get("p")!["id"]); // a hierarquia só moveu
    expect(status(mid, "p")).toBe("done"); // e não decidiu a situação
    expect(mid.get("c")!["status_pending"]).toBe(true);
    expect(mid.get("p")!["status_pending"]).toBe(true);
    expect((await post(`/${run.id}/abandon`)).body.phase).toBe("failed");
    await runAll();
    const rows = await byExt();
    expect(status(rows, "c")).toBe("in_progress");
    expect(status(rows, "p")).toBe("in_progress");
    await expectQuiet();
  });
});

describe("itens 2 e 4: convergência", () => {
  it("P e C concluídos; C reabre (P segue C); C conclui de novo: P volta a concluído na mesma rodada", async () => {
    const w = world([one("p", "completed"), one("c", "completed", { parent: "p" })]);
    await firstImport(w);
    issue(w, "c").state = "started";
    await runAll();
    let rows = await byExt();
    expect(status(rows, "p")).toBe("in_progress");
    expect(rows.get("p")!["status_pending"]).toBe(false); // pai: a situação sai dos filhos, não há desvio (ADR 0068)
    await expectQuiet();
    issue(w, "c").state = "completed";
    const third = await runAll();
    rows = await byExt();
    expect(status(rows, "c")).toBe("done");
    expect(status(rows, "p")).toBe("done");
    expect(appliedStatus(rows, "p")).toBe("done");
    expect(rows.get("p")!["status_pending"]).toBe(false);
    expect(third.counts).toMatchObject({ updated: 1 }); // só C: P conclui pela conta
    await expectQuiet();
  });

  it("primeira importação: P concluído com filho aberto nasce a fazer; o filho conclui no Linear: na reimportação P conclui", async () => {
    const w = world([one("p", "completed"), one("c", "unstarted", { parent: "p" })]);
    await firstImport(w);
    expect(status(await byExt(), "p")).toBe("todo");
    await expectQuiet(); // em desvio e quieto
    issue(w, "c").state = "completed";
    await runAll();
    const rows = await byExt();
    expect(status(rows, "c")).toBe("done");
    expect(status(rows, "p")).toBe("done");
    await expectQuiet();
  });

  it("dados no formato da fatia 2 (sem nenhuma das colunas novas preenchidas): o desvio sai da comparação dos retratos", async () => {
    const w = world([one("p", "completed"), one("c", "unstarted", { parent: "p" })]);
    await firstImport(w);
    await q("update ticket_external_refs set status_pending = false, status_run_id = null, status_run_flags = 0, last_seen_run_id = null, hierarchy_pending = false");
    issue(w, "c").state = "completed";
    await runAll();
    const rows = await byExt();
    expect(status(rows, "p")).toBe("done");
    expect(status(rows, "c")).toBe("done");
    await expectQuiet();
  });

  it("origem de projeto do Linear com issue embaixo converge: nada se repete nas rodadas seguintes", async () => {
    const w = world([one("a", "started", { project: "lp1" }), one("b", "unstarted", { project: "lp1", parent: "a" })]);
    await firstImport(w);
    const rows = await byExt();
    expect(rows.get("lp1")!["kind"]).toBe("project");
    expect(rows.get("a")!["parent_id"]).toBe(rows.get("lp1")!["id"]);
    expect(rows.get("b")!["parent_id"]).toBe(rows.get("a")!["id"]);
    await expectQuiet();
  });

  it("cadeia de três níveis, todos concluídos no Linear numa rodada só: os três concluem nessa rodada (a folha pelo Linear, os pais pela conta)", async () => {
    const w = world([one("a", "started"), one("b", "started", { parent: "a" }), one("c", "started", { parent: "b" })]);
    await firstImport(w);
    for (const id of ["a", "b", "c"]) issue(w, id).state = "completed";
    const second = await runAll();
    const rows = await byExt();
    for (const id of ["a", "b", "c"]) expect(status(rows, id), id).toBe("done");
    expect(second.counts).toMatchObject({ updated: 1 });
    await expectQuiet();
  });

  it("pai concluído no Linear com filho aberto: a situação sai do filho, sem desvio, e continua quieto nas rodadas seguintes", async () => {
    const w = world([one("p", "started"), one("c", "unstarted", { parent: "p" })]);
    await firstImport(w);
    expect(status(await byExt(), "p")).toBe("todo");
    issue(w, "p").state = "completed";
    await runAll();
    const rows = await byExt();
    expect(status(rows, "p")).toBe("todo");
    expect(rows.get("p")!["status_pending"]).toBe(false);
    await expectQuiet();
  });
});

describe("item 3: a situação de um pai não é marcada à mão nem copiada do Linear", () => {
  it("pai: a pessoa não marca P à mão, e o Linear cancelar P e reabrir o filho deixa P seguindo o filho (ADR 0068)", async () => {
    const w = world([one("p", "started"), one("c", "completed", { parent: "p" })]);
    await firstImport(w);
    const before = await byExt();
    expect(status(before, "p")).toBe("done"); // sai do filho concluído
    expect((await patch(before.get("p")!["id"], { status: "in_progress" })).status).toBe(409);
    issue(w, "p").state = "canceled";
    issue(w, "c").state = "started";
    const second = await runAll();
    const rows = await byExt();
    expect(status(rows, "c")).toBe("in_progress");
    expect(status(rows, "p")).toBe("in_progress"); // o cancelado do Linear não é copiado para o pai
    expect(second.counts).toMatchObject({ updated: 1, keptTouched: 0 });
    await expectQuiet();
    expect(status(await byExt(), "p")).toBe("in_progress");
  });
});

describe("item 2: a lista de trabalho", () => {
  it("lote acima de 100: todos os pendentes são decididos em vários passos", async () => {
    const list = Array.from({ length: 250 }, (_, i) => one(`x${i + 1}`, "started", { identifier: `ENG-${i + 1}` }));
    const w = world(list);
    await firstImport(w);
    for (const item of list) item.state = "completed";
    const run = await stepUntil(await begin(), "statuses");
    let statusSteps = 0;
    let body = run;
    while (body.phase === "statuses") {
      body = (await post(`/${run.id}/step`)).body;
      statusSteps += 1;
    }
    expect(statusSteps).toBeGreaterThanOrEqual(3);
    const done = await finish(body);
    expect(done.counts).toMatchObject({ updated: 250 });
    expect((await q("select count(*)::int n from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.kind = 'issue' and t.status = 'done'"))[0]!["n"]).toBe(250);
  });

  it("a pessoa mexe na situação entre a fase issues e a statuses: a edição vale e conta mexido aqui", async () => {
    const w = world([one("a", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await stepUntil(await begin(), "hierarchy");
    expect((await patch((await byExt()).get("a")!["id"], { status: "in_progress" })).status).toBe(200);
    const done = await finish(run);
    expect(status(await byExt(), "a")).toBe("in_progress");
    expect(done.counts).toMatchObject({ keptTouched: 1, updated: 0 });
    await expectQuiet();
  });

  it("ticket que desce de nível entre dois passos não é pulado", async () => {
    const list = Array.from({ length: 150 }, (_, i) => one(`x${i + 1}`, "started", { identifier: `ENG-${i + 1}` }));
    const w = world(list);
    await firstImport(w);
    for (const item of list) item.state = "completed";
    const run = await stepUntil(await begin(), "statuses");
    expect((await post(`/${run.id}/step`)).body.phase).toBe("statuses"); // 100 dos 150
    const left = await q("select ticket_id from ticket_external_refs where kind = 'issue' and status_pending and (status_run_flags & 4) = 0 order by ticket_id");
    expect(left.length).toBeGreaterThan(1);
    // um dos que faltam passa a ser filho de outro que também falta: desce de nível (e o plano antigo, por cursor, o pularia)
    expect((await patch(left[0]!["ticket_id"], { parentId: left[1]!["ticket_id"] })).status).toBe(200);
    await finish(run);
    expect((await q("select count(*)::int n from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.kind = 'issue' and t.status <> 'done'"))[0]!["n"]).toBe(0);
  });

  it("origem que sumiu do Linear com pendência antiga não é tocada; ao reaparecer, aplica", async () => {
    const w = world([one("a", "unstarted"), one("b", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const abandoned = await stepUntil(await begin(), "hierarchy");
    expect((await post(`/${abandoned.id}/abandon`)).body.phase).toBe("failed");
    const gone = w.list.splice(w.list.findIndex((item) => item.id === "a"), 1)[0] as FakeIssue;
    const second = await runAll();
    let rows = await byExt();
    expect(status(rows, "a")).toBe("todo");
    expect(rows.get("a")!["status_pending"]).toBe(true);
    expect(second.counts).toMatchObject({ missing: 1, updated: 0 });
    w.list.push(gone);
    await runAll();
    rows = await byExt();
    expect(status(rows, "a")).toBe("done");
    await expectQuiet();
  });

  it("origem de outro projeto do TreePM não é marcada nem tocada", async () => {
    const w = world([one("a", "unstarted")]);
    await firstImport(w);
    const rows = await byExt();
    const other = h.world().projects.priv;
    await q("update tickets set project_id = $2::uuid, parent_id = null where id = $1::uuid", [rows.get("a")!["id"], other]);
    await q("update ticket_external_refs set project_id = $2::uuid where ticket_id = $1::uuid", [rows.get("a")!["id"], other]);
    issue(w, "a").state = "completed";
    const second = await runAll();
    expect(second.counts).toMatchObject({ elsewhere: 1, updated: 0 });
    const ref = (await q("select status_pending from ticket_external_refs where external_id = 'a'"))[0]!;
    expect(ref["status_pending"]).toBe(false);
    expect((await q("select status from tickets where id = $1::uuid", [rows.get("a")!["id"]]))[0]!["status"]).toBe("todo");
  });
});

describe("item 6: menores", () => {
  it("destino apagado DE VERDADE (ticket excluído): só o item que precisava dele conta em skipped e a marca de hierarquia dele fica", async () => {
    const dest = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    const w = world([one("p", "unstarted"), one("q", "unstarted"), one("h", "unstarted", { parent: "p" }), one("k", "unstarted", { parent: "p" })]);
    await firstImport(w);
    issue(w, "h").parent = null; // iria ao destino
    issue(w, "k").parent = "q"; // não precisa do destino
    const run = await stepUntil(await begin({ destinationTicketId: dest }), "hierarchy");
    expect((await h.call("DELETE", `/api/tickets/${dest}`, as("admin"))).status).toBe(204);
    const done = await finish(run);
    const rows = await byExt();
    expect(rows.get("h")!["parent_id"]).toBe(rows.get("p")!["id"]); // ficou onde estava
    expect(rows.get("h")!["hierarchy_pending"]).toBe(true);
    expect(rows.get("k")!["parent_id"]).toBe(rows.get("q")!["id"]);
    expect(rows.get("k")!["hierarchy_pending"]).toBe(false);
    expect(done.counts).toMatchObject({ skipped: 1, parentsLinked: 1 });
  });
});

describe("item 5: lotes e erros", () => {
  const expired = () => Object.assign(new Error("Transaction API error: A query cannot be executed on an expired transaction."), { code: "P2028" });
  const waiting = () => Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" });
  const runRow = async (id: unknown) => (await q("select batch_size, page_size, size_streak, error_streak, last_error_code from external_import_runs where id = $1::uuid", [id]))[0]!;
  const NORMAL: Record<string, number> = { hierarchy: 200, statuses: 25, mentions: 200, missing: 500 };

  it.each(["hierarchy", "statuses", "mentions", "missing"])("fase %s: transação estourada reduz o lote à metade e guarda na rodada; com 1 e ainda estourando, conta na sequência de erros", async (phase) => {
    const w = world([one("a", "unstarted"), one("b", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await stepUntil(await begin(), phase);
    const spy = vi.spyOn(TicketsService.prototype, "lockStructure").mockRejectedValue(expired());
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ batch_size: Math.floor(NORMAL[phase]! / 2), error_streak: 0, size_streak: 0 });
    await q("update external_import_runs set batch_size = 1 where id = $1::uuid", [run.id]);
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ batch_size: 1, error_streak: 1 });
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ error_streak: 2 });
    spy.mockRestore();
    await finish(run);
  });

  it("espera por uma conexão do pool que estourou só se repete: não reduz nem conta", async () => {
    const w = world([one("a", "unstarted")]);
    await firstImport(w);
    issue(w, "a").state = "completed";
    const run = await stepUntil(await begin(), "statuses");
    const spy = vi.spyOn(TicketsService.prototype, "lockStructure").mockRejectedValue(waiting());
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    expect(await runRow(run.id)).toMatchObject({ batch_size: null, error_streak: 0 });
    spy.mockRestore();
    await finish(run);
  });

  it("o lote reduzido só volta a crescer depois de três passos seguidos bem-sucedidos", async () => {
    const w = world(Array.from({ length: 8 }, (_, i) => one(`m${i + 1}`, "unstarted", { identifier: `ENG-${i + 1}` })));
    await firstImport(w);
    const run = await stepUntil(await begin(), "mentions");
    await q("update external_import_runs set batch_size = 1, size_streak = 0 where id = $1::uuid", [run.id]);
    for (let i = 1; i <= 2; i += 1) {
      expect((await post(`/${run.id}/step`)).body.phase).toBe("mentions");
      expect(await runRow(run.id)).toMatchObject({ batch_size: 1, size_streak: i });
    }
    expect((await post(`/${run.id}/step`)).body.phase).toBe("mentions");
    expect(await runRow(run.id)).toMatchObject({ batch_size: 2, size_streak: 0 });
    await finish(run);
  });

  it("página de issues: o estouro de transação reduz e ela só volta ao dobro depois de três passos bons", async () => {
    const list = Array.from({ length: 200 }, (_, i) => one(`g${i + 1}`, "unstarted", { identifier: `ENG-${i + 1}` }));
    const w = world(list);
    await firstImport(w);
    for (const item of list) item.title = `${item.title} novo`;
    const run = await stepUntil(await begin(), "issues");
    const spy = vi.spyOn(TicketsService.prototype, "lockStructure").mockRejectedValueOnce(expired());
    expect((await post(`/${run.id}/step`)).status).toBeGreaterThanOrEqual(400);
    spy.mockRestore();
    expect(await runRow(run.id)).toMatchObject({ page_size: 25, error_streak: 0 });
    for (let i = 1; i <= 2; i += 1) {
      expect((await post(`/${run.id}/step`)).status).toBe(200);
      expect(await runRow(run.id)).toMatchObject({ page_size: 25, size_streak: i });
    }
    expect((await post(`/${run.id}/step`)).status).toBe(200);
    expect(await runRow(run.id)).toMatchObject({ page_size: 50, size_streak: 0 });
    await finish(run);
  });
});
