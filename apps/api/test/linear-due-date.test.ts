import { describe, expect, it, vi } from "vitest";
import { LinearImportService } from "../src/linear/linear-import.service.js";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeProject, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Prazo no ticket, fatia 1 (ADR 0064; TREEPM-467): `dueDate` da issue e `targetDate` do projeto viram o prazo, pela regra por campo
// (ADR 0060) e pela regra do campo sem retrato (ADR 0061, seção 2). Ponta a ponta com o Linear falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

async function sync(): Promise<RunBody> {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  let last = run.body as RunBody;
  for (let i = 0; i < 120 && last.done !== true; i += 1) {
    const res = await post(`/${last.id ?? run.body.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    last = res.body;
  }
  expect(last.done).toBe(true);
  return last;
}

type World = { project: FakeProject; issues: FakeIssue[]; data: Record<string, FakeTeamData> };
const world = (): World => {
  const project: FakeProject = { id: "lp1", name: "Alfa", targetDate: "2027-01-31" };
  const issues: FakeIssue[] = [
    { id: "a", identifier: "ENG-1", title: "Com prazo", project: "lp1", dueDate: "2026-12-12" },
    { id: "b", identifier: "ENG-2", title: "Sem prazo", project: "lp1", dueDate: null },
    { id: "c", identifier: "ENG-3", title: "Outra com prazo", dueDate: "2026-12-20" },
  ];
  return { project, issues, data: { [TEAM_ENG.id]: { projects: [project], issues } } };
};
async function firstImport(w: World = world()): Promise<{ w: World; run: RunBody }> {
  await linkWithData(h, put, open(), w.data);
  return { w, run: await sync() };
}
const issue = (w: World, id: string): FakeIssue => w.issues.find((item) => item.id === id) as FakeIssue;
/** O prazo de cada ticket importado, pela origem (`lp1` é o projeto do Linear). */
async function dueDates(): Promise<Record<string, string | null>> {
  const rows = await q("select r.external_id, t.due_date::text as due from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid", [open()]);
  return Object.fromEntries(rows.map((row) => [row["external_id"] as string, (row["due"] as string | null) ?? null]));
}
const origin = async (externalId: string): Promise<Row> => (await q("select source_snapshot, applied_snapshot from ticket_external_refs where external_id = $1", [externalId]))[0] as Row;
const ticketId = async (externalId: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [externalId]))[0]!["ticket_id"] as string;
/** Uma pessoa muda o prazo aqui, pela API (grava o evento dela). */
async function setHere(externalId: string, dueDate: string | null): Promise<void> {
  const res = await h.call("PATCH", `/api/tickets/${await ticketId(externalId)}`, as("admin"), { dueDate });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const automaticEvents = async (externalId: string): Promise<Row[]> =>
  (await q("select payload from activity_events where kind = 'ticket.updated' and subject_id = $1 and payload->>'source' = 'linear_reimport' order by occurred_at, id", [await ticketId(externalId)])).map((row) => row["payload"] as Row);
const updatedCount = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]!["n"] as number;
/** Como se a origem tivesse sido importada antes desta fatia: sem a chave `dueDate` nos dois retratos e sem prazo no ticket. */
async function ageToBeforeDueDate(): Promise<void> {
  await q("update ticket_external_refs set source_snapshot = source_snapshot - 'dueDate', applied_snapshot = applied_snapshot - 'dueDate'");
  await q("update tickets set due_date = null where id in (select ticket_id from ticket_external_refs)");
}

describe("a primeira importação traz o prazo", () => {
  it("issue com dueDate, issue sem, projeto com targetDate; retratos com o texto ou nulo", async () => {
    const { run } = await firstImport();
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: null, c: "2026-12-20" });
    for (const [id, value] of [["lp1", "2027-01-31"], ["a", "2026-12-12"], ["b", null]] as const) {
      const ref = await origin(id);
      expect((ref["source_snapshot"] as Row)["dueDate"], id).toBe(value);
      expect((ref["applied_snapshot"] as Row)["dueDate"], id).toBe(value);
    }
    expect(run.counts?.["dueDatesInvalid"]).toBe(0);
  });

  it("sincronização sem mudança fica quieta: zero eventos, todos em `unchanged`", async () => {
    await firstImport();
    const before = await updatedCount();
    const run = await sync();
    expect(await updatedCount()).toBe(before);
    expect(run.counts).toMatchObject({ updated: 0, filled: 0, keptTouched: 0, unchanged: 4, dueDatesInvalid: 0 });
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: null, c: "2026-12-20" });
  });
});

describe("a regra do campo sem retrato (importado antes desta fatia)", () => {
  it("prazo vazio aqui recebe o do Linear (projeto e issue), num evento automático; preenchido aqui fica e vira `mantido daqui`", async () => {
    const { w } = await firstImport();
    await ageToBeforeDueDate();
    // Alguém pôs um prazo aqui em `c` antes de o campo ser sincronizado.
    await q("update tickets set due_date = '2026-10-01' where id = (select ticket_id from ticket_external_refs where external_id = 'c')");
    const before = await updatedCount();
    const run = await sync();
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: null, c: "2026-10-01" });
    expect(run.counts).toMatchObject({ filled: 2, keptTouched: 1, updated: 2 });
    expect(await updatedCount()).toBe(before + 2);
    expect(await automaticEvents("lp1")).toEqual([expect.objectContaining({ fields: ["dueDate"], dueDate: { from: null, to: "2027-01-31" }, automatic: true, source: "linear_reimport" })]);
    expect(await automaticEvents("a")).toEqual([expect.objectContaining({ fields: ["dueDate"], dueDate: { from: null, to: "2026-12-12" } })]);
    expect(await automaticEvents("b")).toEqual([]);
    const c = await origin("c");
    expect(c["applied_snapshot"]).toMatchObject({ dueDate: "2026-10-01", heldHere: ["dueDate"] });
    expect((c["source_snapshot"] as Row)["dueDate"]).toBe("2026-12-20");
    // Mantido daqui: o Linear muda e o prazo daqui continua.
    issue(w, "c").dueDate = "2026-12-31";
    await sync();
    expect((await dueDates())["c"]).toBe("2026-10-01");
    // A próxima rodada sem mudança fica quieta.
    const quiet = await updatedCount();
    await sync();
    expect(await updatedCount()).toBe(quiet);
  });
});

describe("com retrato: só muda o que mudou lá e não foi mexido aqui", () => {
  it("mudado lá atualiza; mudado aqui não é sobrescrito; tirado lá tira aqui; tudo no evento único do ticket", async () => {
    const { w } = await firstImport();
    await setHere("c", "2026-11-30");
    issue(w, "a").dueDate = "2027-02-14";
    issue(w, "a").title = "Com prazo (renomeada)";
    issue(w, "a").updatedAt = "2026-11-20T10:00:00.000Z";
    issue(w, "c").dueDate = "2027-03-01";
    w.project.targetDate = null;
    const run = await sync();
    expect(await dueDates()).toEqual({ lp1: null, a: "2027-02-14", b: null, c: "2026-11-30" });
    expect(run.counts).toMatchObject({ updated: 2, keptTouched: 1 });
    expect(await automaticEvents("a")).toEqual([expect.objectContaining({ fields: ["title", "dueDate"], dueDate: { from: "2026-12-12", to: "2027-02-14" } })]);
    expect(await automaticEvents("lp1")).toEqual([expect.objectContaining({ fields: ["dueDate"], dueDate: { from: "2027-01-31", to: null } })]);
    expect(await automaticEvents("c")).toEqual([]);
    expect((await origin("a"))["applied_snapshot"]).toMatchObject({ dueDate: "2027-02-14" });
    expect((await origin("lp1"))["applied_snapshot"]).toMatchObject({ dueDate: null });
    // O Linear volta a pôr um prazo no projeto: aplica de novo (o retrato tem o nulo de lá e o nulo daqui).
    w.project.targetDate = "2027-04-01";
    await sync();
    expect((await dueDates())["lp1"]).toBe("2027-04-01");
  });
});

describe("prazo malformado no Linear", () => {
  it("não derruba a issue nem o projeto, não toca o prazo nem o retrato, e é contado", async () => {
    const w = world();
    issue(w, "b").dueDate = "2026-02-30";
    const { run } = await firstImport(w);
    expect(run.counts).toMatchObject({ issuesCreated: 3, dueDatesInvalid: 1, skippedInvalid: 0 });
    expect((await dueDates())["b"]).toBeNull();
    expect("dueDate" in ((await origin("b"))["source_snapshot"] as Row)).toBe(false);

    issue(w, "a").dueDate = "12/12/2026";
    w.project.targetDate = 20270131;
    const before = await updatedCount();
    const next = await sync();
    expect(next.counts).toMatchObject({ dueDatesInvalid: 3, skippedInvalid: 0, updated: 0 });
    expect(await updatedCount()).toBe(before);
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: null, c: "2026-12-20" });
    expect((await origin("a"))["source_snapshot"]).toMatchObject({ dueDate: "2026-12-12" });
    expect((await origin("lp1"))["source_snapshot"]).toMatchObject({ dueDate: "2027-01-31" });

    // Corrigido no Linear: entra pela regra de sempre (`b` não tinha retrato: vazio aqui, preenche).
    issue(w, "b").dueDate = "2026-12-01";
    issue(w, "a").dueDate = "2026-12-12";
    w.project.targetDate = "2027-01-31";
    await sync();
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: "2026-12-01", c: "2026-12-20" });
  });
});

describe("vazio nos dois lados, importado antes da fatia (revisão P2)", () => {
  // A chave ausente no retrato era lida como igual a nulo: a primeira sincronização decidia "sincronizado" sem gravar `dueDate: null`
  // nos retratos, um prazo posto aqui virava "mantido daqui" para sempre e o prazo que nascesse no Linear nunca chegava.
  type Parts = { source: Row; applied: Row };
  const snapshotWrites = () => {
    const service = h.app().get(LinearImportService) as unknown as { mergeSnapshots: (tx: unknown, orgId: string, ticketId: string, parts: Parts) => Promise<void> };
    const spy = vi.spyOn(service, "mergeSnapshots");
    return {
      /** As gravações de retrato que de fato mudam alguma chave, por ticket. */
      written: () => spy.mock.calls.filter(([, , , parts]) => Object.keys(parts.source).length + Object.keys(parts.applied).length > 0).map(([, , ticket, parts]) => ({ ticket, parts })),
      clear: () => spy.mockClear(),
      restore: () => spy.mockRestore(),
    };
  };

  async function scenario(aged: boolean, externalId: "b" | "lp1"): Promise<Row> {
    const w = world();
    w.project.targetDate = null;
    await firstImport(w);
    if (aged) await q("update ticket_external_refs set source_snapshot = source_snapshot - 'dueDate', applied_snapshot = applied_snapshot - 'dueDate' where external_id in ('b', 'lp1')");
    const writes = snapshotWrites();
    try {
      const before = await updatedCount();
      const first = await sync();
      // A primeira sincronização grava a chave nula nos dois retratos, sem evento e sem contar como mudança de ticket.
      expect(await updatedCount()).toBe(before);
      expect(first.counts).toMatchObject({ updated: 0, filled: 0, keptTouched: 0, unchanged: 4 });
      for (const id of ["b", "lp1"]) {
        const ref = await origin(id);
        expect(ref["source_snapshot"], id).toHaveProperty("dueDate", null);
        expect(ref["applied_snapshot"], id).toHaveProperty("dueDate", null);
      }
      const ids = new Set([await ticketId("b"), await ticketId("lp1")]);
      const written = writes.written();
      if (aged) {
        expect(written.filter((entry) => ids.has(entry.ticket)).map((entry) => [entry.parts.source["dueDate"], entry.parts.applied["dueDate"]])).toEqual([
          [null, null],
          [null, null],
        ]);
      }
      // A rodada seguinte não grava retrato de novo.
      writes.clear();
      await sync();
      expect(writes.written()).toEqual([]);
    } finally {
      writes.restore();
    }
    await setHere(externalId, "2026-11-11");
    await sync();
    await setHere(externalId, null);
    if (externalId === "lp1") w.project.targetDate = "2026-12-25";
    else issue(w, "b").dueDate = "2026-12-25";
    await sync();
    return { due: (await dueDates())[externalId], held: ((await origin(externalId))["applied_snapshot"] as Row)["heldHere"] ?? null };
  }

  for (const externalId of ["b", "lp1"] as const) {
    it(`${externalId}: importado depois da fatia (controle), o prazo que nasce no Linear chega`, async () => {
      expect(await scenario(false, externalId)).toEqual({ due: "2026-12-25", held: null });
    });
    it(`${externalId}: importado antes da fatia, a mesma sequência dá o mesmo resultado`, async () => {
      expect(await scenario(true, externalId)).toEqual({ due: "2026-12-25", held: null });
    });
  }
});

describe("chave do prazo ausente na resposta do Linear (revisão P2)", () => {
  it("vale 'não lido': não mexe no prazo daqui nem no retrato e não conta como inválido; nulo explícito tira pela regra", async () => {
    const { w } = await firstImport();
    delete issue(w, "a").dueDate;
    delete w.project.targetDate;
    const before = await updatedCount();
    const run = await sync();
    expect(run.counts).toMatchObject({ updated: 0, dueDatesInvalid: 0 });
    expect(await updatedCount()).toBe(before);
    expect(await dueDates()).toEqual({ lp1: "2027-01-31", a: "2026-12-12", b: null, c: "2026-12-20" });
    expect((await origin("a"))["source_snapshot"]).toMatchObject({ dueDate: "2026-12-12" });
    expect((await origin("lp1"))["source_snapshot"]).toMatchObject({ dueDate: "2027-01-31" });
    issue(w, "a").dueDate = null;
    w.project.targetDate = null;
    await sync();
    expect(await dueDates()).toEqual({ lp1: null, a: null, b: null, c: "2026-12-20" });
  });
});

describe("data válida fora da faixa no Linear (revisão P2)", () => {
  it("2150 é ignorada e contada com os malformados; o prazo daqui fica", async () => {
    const { w } = await firstImport();
    issue(w, "a").dueDate = "2150-01-01";
    const run = await sync();
    expect(run.counts).toMatchObject({ updated: 0, dueDatesInvalid: 1 });
    expect((await dueDates())["a"]).toBe("2026-12-12");
    expect((await origin("a"))["source_snapshot"]).toMatchObject({ dueDate: "2026-12-12" });
  });
});
