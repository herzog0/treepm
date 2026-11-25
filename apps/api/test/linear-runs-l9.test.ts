import { afterEach, describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { ORG, as } from "./world.js";

// L9: segunda revisão da fatia 2 (rodada que não desfaz o que foi arrumado à mão, erros repetíveis, e-mail ilegível, menores).
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const step = (runId: string) => post(`/${runId}/step`);
const abandon = (runId: string) => post(`/${runId}/abandon`);
const issues = (n: number, over: (i: number) => Partial<FakeIssue> = () => ({})): FakeIssue[] => Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, identifier: `ENG-${i + 1}`, ...over(i + 1) }));
const team = (list: FakeIssue[], extra: Partial<FakeTeamData> = {}): Record<string, FakeTeamData> => ({ [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }], issues: list, ...extra } });

async function begin(data: Record<string, FakeTeamData>, body: unknown = {}): Promise<string> {
  await linkWithData(h, put, open(), data);
  const run = await post("", "admin", body);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body.id as string;
}
async function finish(runId: string, max = 80): Promise<RunBody> {
  for (let i = 0; i < max; i += 1) {
    const res = await step(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
/** Passos até a rodada chegar à fase dada (sem dar o passo dessa fase). */
async function until(runId: string, phase: string, max = 40): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const res = await step(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.phase === phase) return;
  }
  throw new Error(`não chegou a ${phase}`);
}
const byExt = async (): Promise<Map<string, Row>> => new Map((await q("select r.external_id, t.* from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid", [open()])).map((row) => [row["external_id"] as string, row]));

afterEach(async () => {
  await h.pool.query("drop trigger if exists l9_boom on ticket_external_refs");
  await h.pool.query("drop function if exists l9_boom()");
});

describe("item 2: a segunda rodada não desfaz o que foi arrumado à mão", () => {
  it("rodada 1 abandonada depois de criar tudo, pessoa move tickets, rodada 2 conclui e não mexe neles", async () => {
    const data = team(issues(4, (i) => (i === 2 || i === 3 ? { parent: "i1" } : i === 4 ? { parent: "i2" } : {})));
    const first = await begin(data);
    await until(first, "hierarchy");
    expect((await abandon(first)).body).toMatchObject({ phase: "failed" });
    const rows = await byExt();
    const manualParent = rows.get("i3")!["id"] as string;
    // a pessoa leva i2 para baixo de i3 (nada a ver com o Linear); i3 e i4 ficam como a importação deixou
    await h.pool.query("update tickets set parent_id = $2::uuid where id = $1::uuid", [rows.get("i2")!["id"], manualParent]);
    const second = await post("");
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const last = await finish(second.body.id as string);
    const after = await byExt();
    expect(after.get("i2")!["parent_id"]).toBe(manualParent); // ficou onde a pessoa pôs
    expect(after.get("i3")!["parent_id"]).toBe(after.get("i1")!["id"]); // o resto desceu para o pai do Linear
    expect(after.get("i4")!["parent_id"]).toBe(after.get("i2")!["id"]);
    expect(last.counts?.["keptMoved"]).toBe(1);
  });
});

describe("item 3: nenhum erro repetível prende a rodada", () => {
  it("updatedAt que não parseia (ou fora de qualquer intervalo) vira nulo e o ticket entra", async () => {
    const runId = await begin(team(issues(3, (i) => ({ updatedAt: i === 1 ? "lixo" : i === 2 ? "0001-01-01T00:00:00Z" : "2026-11-01T10:00:00.000Z" }))));
    const last = await finish(runId);
    expect(last.counts).toMatchObject({ issuesCreated: 3, skippedInvalid: 0 });
    const rows = await q("select external_id, external_updated_at from ticket_external_refs where project_id = $1::uuid and kind = 'issue' order by external_id", [open()]);
    expect(rows.map((row) => [row["external_id"], row["external_updated_at"] === null])).toEqual([["i1", true], ["i2", true], ["i3", false]]);
  });

  it("ciclo no plano que só aparece depois de tirar uma descida para ideia: o item fica onde está (skipped) e a rodada termina", async () => {
    // Ordem de criação B, A, X. Linear: B→X (X virou ideia: B, concluído, não entra) e A→B. Hoje B está sob A; sem B→X, A→B fecha ciclo.
    const data = team([
      { id: "ib", identifier: "ENG-1", state: "completed", parent: "ix" },
      { id: "ia", identifier: "ENG-2", parent: "ib" },
      { id: "ix", identifier: "ENG-3" },
    ]);
    const runId = await begin(data);
    await until(runId, "hierarchy");
    const rows = await byExt();
    await h.pool.query("update tickets set parent_id = $2::uuid where id = $1::uuid", [rows.get("ib")!["id"], rows.get("ia")!["id"]]);
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1::uuid", [rows.get("ix")!["id"]]);
    const last = await finish(runId);
    expect(last.phase).toBe("done");
    expect(last.counts).toMatchObject({ movedOutOfIdea: 1, skipped: 1, parentsLinked: 0 });
    const after = await byExt();
    expect(after.get("ib")!["parent_id"]).toBe(after.get("ia")!["id"]); // ficou onde estava
    expect(after.get("ia")!["parent_id"]).toBeNull();
  });

  it("o gatilho de ciclo do banco recusa um item no fallback: o item conta em skipped e o passo segue (nunca erro repetido)", async () => {
    // O plano do domínio já impede o ciclo; aqui o ciclo nasce de uma troca à mão ENTRE a leitura e a gravação, simulada por um gatilho.
    const data = team(issues(3, (i) => (i === 2 ? { parent: "i1" } : i === 3 ? { parent: "i1" } : {})));
    const runId = await begin(data);
    await until(runId, "hierarchy");
    const rows = await byExt();
    const bad = rows.get("i2")!["id"] as string;
    await h.pool.query(`create function l9_boom() returns trigger language plpgsql as $$ begin if new.id = '${bad}'::uuid and new.parent_id is not null then raise exception 'ticket_parent_cycle: teste'; end if; return new; end $$`);
    await h.pool.query("create trigger l9_boom before update on tickets for each row execute function l9_boom()");
    try {
      const last = await finish(runId);
      expect(last.phase).toBe("done");
      expect(last.counts).toMatchObject({ skipped: 1, parentsLinked: 1 });
    } finally {
      await h.pool.query("drop trigger if exists l9_boom on tickets");
      await h.pool.query("drop function if exists l9_boom()");
    }
    const after = await byExt();
    expect(after.get("i2")!["parent_id"]).toBeNull();
    expect(after.get("i3")!["parent_id"]).toBe(after.get("i1")!["id"]);
  });

  it("em hierarchy e mentions um destino apagado não obriga a abandonar; em issues sim", async () => {
    const dest = (await q("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,900,'Destino',$3::uuid) returning id", [ORG, open(), h.world().people.admin]))[0]!["id"] as string;
    const runId = await begin(team(issues(3, (i) => (i === 2 ? { parent: "i1" } : {}))), { destinationTicketId: dest });
    await until(runId, "hierarchy");
    await h.pool.query("update tickets set parent_id = null where parent_id = $1::uuid", [dest]); // a pessoa tira os filhos e apaga o destino
    await h.pool.query("delete from tickets where id = $1::uuid", [dest]);
    const last = await finish(runId);
    expect(last.phase).toBe("done");
    // e na fase issues o destino apagado recusa
    await h.pool.query("delete from ticket_external_refs where project_id = $1::uuid", [open()]);
    await h.pool.query("delete from external_import_runs where project_id = $1::uuid", [open()]);
    const dest2 = (await q("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,901,'Destino 2',$3::uuid) returning id", [ORG, open(), h.world().people.admin]))[0]!["id"] as string;
    const opened = await post("", "admin", { destinationTicketId: dest2 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const second = opened.body.id as string;
    await step(second); // projects
    await h.pool.query("update tickets set parent_id = null where parent_id = $1::uuid", [dest2]);
    await h.pool.query("delete from tickets where id = $1::uuid", [dest2]);
    const refused = await step(second);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "linear_destination_invalid" } });
  });

  it("impasse de transação (40P01) e prazo da transação não entram em error_streak", async () => {
    const runId = await begin(team(issues(2)));
    await step(runId); // projects
    await h.pool.query(`create function l9_boom() returns trigger language plpgsql as $$ begin raise exception 'deadlock detected' using errcode = '40P01'; end $$`);
    await h.pool.query("create trigger l9_boom before insert on ticket_external_refs for each row execute function l9_boom()");
    for (let i = 0; i < 3; i += 1) {
      const res = await step(runId);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "concurrent_update" } });
    }
    expect(await q("select error_streak, last_error_code from external_import_runs where id = $1::uuid", [runId])).toEqual([{ error_streak: 0, last_error_code: null }]);
    await h.pool.query("drop trigger l9_boom on ticket_external_refs");
    expect((await finish(runId)).phase).toBe("done");
  });
});

describe("item 5: menores", () => {
  const BIG = { raw: "x".repeat(4 * 1024 * 1024 + 16) };

  it("repescagem com página de 1: UMA issue conhecida no topo não encerra; issues novas atrás dela entram", async () => {
    const list = issues(6);
    let sawNonTop = false;
    let spliced = false;
    const data = team(list, {
      override: (_call, ask) => (ask.first > 1 ? BIG : undefined),
      onIssuesPage: (ask) => {
        if (ask.after !== null) sawNonTop = true;
        else if (sawNonTop && !spliced) {
          // voltou ao topo depois de ler adiante: é a repescagem; duas issues NOVAS apareceram logo depois da conhecida do topo
          spliced = true;
          list.splice(1, 0, { id: "n1", identifier: "ENG-91" }, { id: "n2", identifier: "ENG-92" });
        }
      },
    });
    const runId = await begin(data);
    await step(runId); // projects
    await step(runId).then((res) => expect([200, 503]).toContain(res.status)); // 50→…→1 gasta as 6 chamadas (503) ou já fecha
    const last = await finish(runId, 200);
    expect(last.phase).toBe("done");
    const refs = (await q("select external_id from ticket_external_refs where project_id = $1::uuid and kind = 'issue'", [open()])).map((row) => row["external_id"]);
    expect(refs).toContain("n1");
    expect(refs).toContain("n2");
  });

  it("o teto de 40 páginas da repescagem termina a rodada mesmo se sempre aparecer issue nova", async () => {
    const list = issues(8);
    let sawNonTop = false;
    let next = 0;
    let sweeping = false;
    const data = team(list, {
      override: (_call, ask) => (ask.first > 3 ? BIG : undefined),
      onIssuesPage: (ask) => {
        if (ask.after !== null) sawNonTop = true;
        else if (sawNonTop) sweeping = true; // voltou ao topo depois de ler adiante: é a repescagem
        // na repescagem, cada leitura acrescenta issues novas no FIM da lista (a próxima página sempre tem novidade)
        if (sweeping) for (let k = 0; k < 6; k += 1) list.push({ id: `late${(next += 1)}`, identifier: `ENG-${1000 + next}` });
      },
    });
    const runId = await begin(data);
    let issuePages = 0;
    for (let i = 0; i < 400; i += 1) {
      const res = await step(runId);
      if (res.status === 200 && res.body.phase === "issues") issuePages += 1;
      if (res.status === 200 && res.body.done) break;
    }
    const final = (await q("select phase from external_import_runs where id = $1::uuid", [runId]))[0]!;
    expect(final["phase"]).toBe("done");
    // 40 páginas de repescagem no máximo (mais as da leitura principal): a rodada não gira para sempre
    expect(issuePages).toBeLessThanOrEqual(40 + 60);
  });

  it("abandonar ENTRE a leitura do Linear e a gravação do passo: nada é gravado e a rodada fica failed", async () => {
    const runId = await begin(team(issues(5)));
    await step(runId); // projects
    const before = Number((await q("select count(*)::int n from tickets where project_id = $1::uuid", [open()]))[0]!["n"]);
    let abandoned = false;
    h.linear().beforeReply = async (call) => {
      if (abandoned || !call.query.includes("issues(")) return;
      abandoned = true;
      const res = await abandon(runId);
      expect(res.status).toBe(200);
    };
    try {
      const res = await step(runId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ phase: "failed", done: true });
    } finally {
      h.linear().beforeReply = null;
    }
    expect(abandoned).toBe(true);
    expect(Number((await q("select count(*)::int n from tickets where project_id = $1::uuid", [open()]))[0]!["n"])).toBe(before);
  });
});
