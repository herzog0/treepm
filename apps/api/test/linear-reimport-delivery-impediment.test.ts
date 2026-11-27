import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// ADR 0068 na fase `statuses` da sincronização com o Linear (revisão 1, itens 1 e 2):
// - concluir com dependência "para entregar" aberta não se aplica (fica como está, em desvio, como o concluído com filho aberto);
// - concluir ou cancelar pela sincronização limpa o impedimento, e o ticket reaberto depois não volta bloqueado.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

async function runAll(): Promise<RunBody> {
  const run = await post("");
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  for (let i = 0; i < 200; i += 1) {
    const res = await post(`/${(run.body as RunBody).id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body as RunBody;
  }
  throw new Error("não terminou");
}
type World = { data: Record<string, FakeTeamData>; list: FakeIssue[] };
const world = (list: FakeIssue[]): World => ({ list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa", status: "started" }], issues: list } } });
const issue = (w: World, id: string): FakeIssue => w.list.find((item) => item.id === id) as FakeIssue;
async function ticketOf(externalId: string): Promise<Row> {
  const rows = await q(
    `select t.id, t.status, t.impediment_reason, t.impediment_person_id, t.impediment_at, r.status_pending
       from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid and r.external_id = $2`,
    [open(), externalId],
  );
  return rows[0] as Row;
}
const summary = async (id: unknown) => ((await h.call("GET", `/api/tickets/${String(id)}`, as("admin"))).body as Row);

describe("sincronização com o Linear e a dependência para entregar", () => {
  it("o Linear conclui um ticket com dependência para entregar aberta: não se aplica, fica pendente; depois que a outra termina, aplica", async () => {
    const w = world([
      { id: "a", identifier: "ENG-1", title: "A", state: "started" },
      { id: "b", identifier: "ENG-2", title: "B", state: "unstarted" },
    ]);
    await linkWithData(h, put, open(), w.data);
    await runAll();
    const a = await ticketOf("a");
    const b = await ticketOf("b");
    expect((await h.call("POST", `/api/tickets/${String(a["id"])}/dependencies`, as("admin"), { ticketId: b["id"], need: "deliver" })).status).toBe(200);

    issue(w, "a").state = "completed";
    const second = await runAll();
    expect(await ticketOf("a")).toMatchObject({ status: "in_progress", status_pending: true });
    expect(second.counts).toMatchObject({ updated: 0, keptTouched: 0 });

    // B termina no Linear. Na mesma rodada A pode ser avaliado antes de B (mesma profundidade): então A fica pendente e a rodada
    // seguinte o conclui, como todo desvio por invariante (reavaliado em toda reimportação).
    issue(w, "b").state = "completed";
    await runAll();
    expect(await ticketOf("b")).toMatchObject({ status: "done" });
    await runAll();
    expect(await ticketOf("a")).toMatchObject({ status: "done", status_pending: false });
  });
});

describe("sincronização com o Linear e o impedimento", () => {
  it.each([
    ["completed", "done"],
    ["canceled", "cancelled"],
  ])("o Linear leva a %s: o impedimento é limpo (com o evento automático); reaberto depois, o ticket não volta bloqueado", async (state, finished) => {
    const w = world([{ id: "a", identifier: "ENG-1", title: "A", state: "started" }]);
    await linkWithData(h, put, open(), w.data);
    await runAll();
    const a = await ticketOf("a");
    expect((await h.call("PUT", `/api/tickets/${String(a["id"])}/impediment`, as("admin"), { reason: "Falta a chave" })).status).toBe(200);

    issue(w, "a").state = state;
    await runAll();
    expect(await ticketOf("a")).toMatchObject({ status: finished, impediment_reason: null, impediment_person_id: null, impediment_at: null });
    const [event] = await q("select payload from activity_events where kind = 'ticket.impediment_cleared' and subject_id = $1", [a["id"]]);
    expect(event?.["payload"]).toMatchObject({ automatic: true, cause: "finished" });

    issue(w, "a").state = "started";
    await runAll();
    expect(await ticketOf("a")).toMatchObject({ status: "in_progress" });
    expect(await summary(a["id"])).toMatchObject({ blocked: false, impediment: null });
  });
});
