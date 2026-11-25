import { afterEach, describe, expect, it } from "vitest";
import { KEY, TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import type { LinearReply } from "./linear-fake-fetch.js";
import { ORG, as } from "./world.js";

// L7, A1: nenhuma rodada pode ficar sem saída (abandonar, degradar por item, página que estoura, e-mail ilegível, destino que mudou).
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const step = (runId: string, who: Parameters<typeof as>[0] = "admin") => post(`/${runId}/step`, who);
const abandon = (runId: string, who: Parameters<typeof as>[0] = "admin") => post(`/${runId}/abandon`, who);
const issues = (n: number, over: (i: number) => Partial<FakeIssue> = () => ({})): FakeIssue[] => Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, identifier: `ENG-${i + 1}`, ...over(i + 1) }));
const team = (list: FakeIssue[], extra: Partial<FakeTeamData> = {}): Record<string, FakeTeamData> => ({ [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }], issues: list, ...extra } });
const MB4 = 4 * 1024 * 1024;
const TOO_BIG: LinearReply = { raw: "x".repeat(MB4 + 16) };

async function begin(data: Record<string, FakeTeamData>, body: unknown = {}): Promise<string> {
  await linkWithData(h, put, open(), data);
  const run = await post("", "admin", body);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body.id as string;
}
async function finish(runId: string, max = 60): Promise<RunBody> {
  let last: RunBody = {};
  for (let i = 0; i < max; i += 1) {
    const res = await step(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    last = res.body;
    if (last["done"]) return last;
  }
  throw new Error("não terminou");
}
const run = async (runId: string) => (await q("select * from external_import_runs where id = $1::uuid", [runId]))[0] as Row;
const tickets = async () => (await q("select title, description, status, parent_id from tickets where project_id = $1::uuid order by number", [open()])) as Row[];

afterEach(async () => {
  await h.pool.query("drop trigger if exists l7_boom on ticket_external_refs");
  await h.pool.query("drop function if exists l7_boom()");
});

describe("A1.1 abandonar a rodada", () => {
  it("fase failed, finished_at e atividade; depois abre outra rodada `first`, e o que já veio não duplica", async () => {
    const runId = await begin(team(issues(60)));
    await step(runId); // projects
    await step(runId); // issues, página 1 (50)
    const before = (await tickets()).length;
    expect(before).toBe(51);
    const res = await abandon(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ phase: "failed", done: true });
    expect(res.body.finishedAt).toBeTruthy();
    expect((await q("select 1 from activity_events where kind = 'ticket.import_abandoned_from_linear' and subject_id = $1::text", [open()]))).toHaveLength(1);
    // um passo na rodada abandonada não faz nada
    expect((await step(runId)).body).toMatchObject({ phase: "failed" });
    // a rodada nova (outra, `first`) segue de onde parou, sem duplicar
    const next = await post("");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.mode).toBe("first");
    expect(next.body.id).not.toBe(runId);
    const last = await finish(next.body.id);
    expect(last.counts).toMatchObject({ projectsExisting: 1, issuesExisting: 50, issuesCreated: 10 });
    expect((await tickets()).length).toBe(61);
    expect((await q("select count(distinct external_id)::int n, count(*)::int c from ticket_external_refs where project_id = $1::uuid", [open()]))[0]).toEqual({ n: 61, c: 61 });
  });

  it("a rodada concluída não se abandona (409) e a próxima rodada é uma reimportação", async () => {
    const runId = await begin(team(issues(3)));
    await finish(runId);
    const late = await abandon(runId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("linear_run_finished");
    expect((await post("")).body.mode).toBe("reimport");
  });

  it("abandonar duas vezes devolve a rodada; outra rodada/projeto e permissão", async () => {
    const runId = await begin(team(issues(3)));
    expect((await abandon(runId, "reader")).status).toBe(403);
    expect((await abandon(runId, "plain")).status).toBe(403);
    expect((await abandon("0190a1b2-0000-7000-8000-000000000999")).status).toBe(404);
    expect((await abandon(runId)).status).toBe(200);
    const again = await abandon(runId);
    expect(again.status).toBe(200);
    expect(again.body.phase).toBe("failed");
    expect((await q("select 1 from activity_events where kind = 'ticket.import_abandoned_from_linear'"))).toHaveLength(1);
  });

  it("o destino da nova rodada pode ser outro", async () => {
    const dest = (await q("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,500,'Destino novo',$3::uuid) returning id", [ORG, open(), h.world().people.admin]))[0]!["id"] as string;
    const runId = await begin(team(issues(2)));
    await abandon(runId);
    const next = await post("", "admin", { destinationTicketId: dest });
    expect(next.status).toBe(201);
    expect(next.body.destinationTicketId).toBe(dest);
  });
});

describe("A1.2 degradar por item, não por página", () => {
  it("um nó inválido é pulado e contado; os outros 49 entram", async () => {
    const good = issues(5);
    const data = team(good, {
      override: (call, ask) => {
        if (ask.after !== null) return undefined;
        const nodes = [{ id: "ruim" }, { id: "i1", identifier: "ENG-1", url: "https://linear.app/x", title: "Boa", description: "d", priority: 0, updatedAt: "2026-11-01T10:00:00.000Z", state: { type: "unstarted" } }, { id: "i2", identifier: "ENG-2", url: "u", title: "Sem estado", priority: 0, updatedAt: "x", state: null }];
        void call;
        return { body: { data: { team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      },
    });
    const runId = await begin(data);
    const last = await finish(runId);
    expect(last.counts).toMatchObject({ skippedInvalid: 2, issuesCreated: 1, issuesSeen: 1 });
    expect((await tickets()).map((t) => t["title"])).toContain("Boa");
  });
});

describe("A1.3 página grande demais", () => {
  it("estourou o teto: repete com metade (50→25→12→6) e guarda o tamanho na rodada", async () => {
    const asks: number[] = [];
    const runId = await begin(team(issues(60, () => ({ description: "d" })), { override: (_c, ask) => { asks.push(ask.first); return ask.first > 6 ? TOO_BIG : undefined; } }));
    await step(runId); // projects
    const res = await step(runId); // issues: tenta 50, 25, 12 e acerta em 6
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(asks).toEqual([50, 25, 12, 6]);
    expect(res.body.counts.issuesCreated).toBe(6);
    expect((await run(runId))["page_size"]).toBe(6);
    expect(res.body.pageSize).toBe(6);
    // L14: o tamanho reduzido por estouro NÃO volta ao dobro no passo seguinte: só cresce depois de três passos seguidos bons (6 → 12)
    asks.length = 0;
    const next = await step(runId);
    expect(asks[0]).toBe(6);
    expect(next.body.pageSize).toBe(6);
    expect((await step(runId)).body.pageSize).toBe(6);
    expect(asks.slice(-1)[0]).toBe(6);
    expect((await step(runId)).body.pageSize).toBe(12);
    // L9: leva a rodada até o fim: nenhuma issue se perdeu nem repetiu por causa da mudança de tamanho
    const last = await finish(runId);
    expect(last.counts).toMatchObject({ issuesCreated: 60, issuesSeen: 60 });
    const refs = await q("select external_id from ticket_external_refs where project_id = $1::uuid and kind = 'issue'", [open()]);
    expect(new Set(refs.map((row) => row["external_id"]))).toEqual(new Set(Array.from({ length: 60 }, (_, i) => `i${i + 1}`)));
    expect(refs).toHaveLength(60);
  });

  it("com 1 e ainda grande, busca aquela issue SEM descrição (descrição vazia, contador withoutDescription)", async () => {
    const data = team(issues(3, () => ({ description: "enorme" })), { override: (_c, ask) => (ask.withDescription ? TOO_BIG : undefined) });
    const runId = await begin(data);
    await step(runId); // projects
    // 50→25→12→6→3→1 gasta as 6 chamadas do passo: termina em erro, mas o tamanho 1 já fica gravado (L9)...
    const stopped = await step(runId);
    expect(stopped.status).toBe(503);
    expect(await run(runId)).toMatchObject({ phase: "issues", page_size: 1 });
    // ...e o passo seguinte começa em 1, não consegue com descrição e busca SEM ela.
    const last = await finish(runId);
    expect(last.counts!.withoutDescription).toBe(3);
    expect(last.counts!.issuesCreated).toBe(3);
    // L9: só os tickets de ISSUE (o do projeto também tem descrição vazia): exatamente as 3, todas sem descrição
    const issueRows = await q("select t.description from tickets t join ticket_external_refs r on r.ticket_id = t.id and r.org_id = t.org_id where r.kind = 'issue' and t.project_id = $1::uuid", [open()]);
    expect(issueRows).toHaveLength(3);
    expect(issueRows.every((r) => r["description"] === "")).toBe(true);
  });

  it("sem saída mesmo sem descrição: erro 503 e a rodada fica aberta, com a sequência de falhas contada", async () => {
    const data = team(issues(3), { override: () => TOO_BIG });
    const runId = await begin(data);
    await step(runId);
    const res = await step(runId);
    expect(res.status).toBe(503);
    expect(await run(runId)).toMatchObject({ phase: "issues", last_error_code: "linear_unavailable", error_streak: 1 });
  });
});

describe("A1.4 e-mail ilegível", () => {
  it("repete sem e-mail, marca na rodada e segue sem responsáveis (as próximas páginas já nem pedem o e-mail)", async () => {
    const emailError: LinearReply = { body: { errors: [{ message: "no permission", path: ["team", "issues", "nodes", 0, "assignee", "email"], extensions: { code: "FORBIDDEN" } }], data: null } };
    const withEmail: boolean[] = [];
    const data = team(issues(70, (i) => ({ assignee: { id: "u1", email: "admin@exemplo.test" }, ...(i === 0 ? {} : {}) })), {
      override: (_call, ask) => {
        withEmail.push(ask.withEmail);
        return ask.withEmail ? emailError : undefined;
      },
    });
    const runId = await begin(data);
    const last = await finish(runId);
    expect(last.counts).toMatchObject({ assigneeEmailUnavailable: true, assigned: 0, issuesCreated: 70 });
    // a primeira página tentou com e-mail e sem; depois nunca mais pediu e-mail
    expect(withEmail.slice(0, 2)).toEqual([true, false]);
    expect(withEmail.slice(2).every((v) => v === false)).toBe(true);
    expect((await q("select count(*)::int n from ticket_assignees"))[0]!["n"]).toBe(0);
  });
});

describe("A1.5 controles e bytes nulos nos retratos e nos nomes", () => {
  it("nada de controle em título, descrição, retratos e nome de projeto", async () => {
    const data = team(issues(1, () => ({ title: "T\u0001ítulo\u0000", description: "D\u0007esc\u001f\u0000rição" })), { projects: [{ id: "lp1", name: "Proj\u0000eto\u0002 X" }] });
    const runId = await begin(data);
    await finish(runId);
    const rows = await q("select t.title, t.description, r.source_snapshot::text as s, r.applied_snapshot::text as a from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid order by t.number", [open()]);
    expect(rows.map((r) => r["title"])).toEqual(["Projeto X", "Título"]);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toMatch(/\\u00(0[0-8b-f]|1[0-9a-f]|7f)/i);
    }
    expect(rows[1]!["description"]).toBe("Descrição");
  });
});

describe("A1.6 destino que ficou inválido no meio", () => {
  const dest = async () => (await q("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,500,'Destino',$3::uuid) returning id", [ORG, open(), h.world().people.admin]))[0]!["id"] as string;

  it("apagado: 409 linear_destination_invalid (e não vira a raiz em silêncio); abandonar e abrir outra resolve", async () => {
    const d = await dest();
    const runId = await begin(team(issues(3)), { destinationTicketId: d });
    await step(runId);
    await h.pool.query("update tickets set parent_id = null where parent_id = $1::uuid", [d]);
    await h.pool.query("delete from tickets where id = $1::uuid", [d]);
    const res = await step(runId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_destination_invalid");
    expect(await run(runId)).toMatchObject({ phase: "issues", last_error_code: "linear_destination_invalid" });
    await abandon(runId);
    const next = await post("");
    expect(next.status).toBe(201);
    expect((await finish(next.body.id))["counts"]).toMatchObject({ issuesCreated: 3 });
  });

  it("virou ideia, ou ficou dentro de uma ideia: 409 linear_destination_invalid", async () => {
    const d = await dest();
    const runId = await begin(team(issues(3)), { destinationTicketId: d });
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1::uuid", [d]);
    const res = await step(runId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_destination_invalid");
    // dentro de uma ideia: a ideia é um ancestral
    await h.pool.query("update tickets set idea_stage = null where id = $1::uuid", [d]);
    const top = (await q("insert into tickets (org_id, project_id, number, title, idea_stage, created_by_person_id) values ($1,$2::uuid,501,'Ideia','new',$3::uuid) returning id", [ORG, open(), h.world().people.admin]))[0]!["id"] as string;
    await h.pool.query("update tickets set parent_id = $2::uuid where id = $1::uuid", [d, top]);
    const inside = await step(runId);
    expect(inside.status).toBe(409);
    expect(inside.body.error.code).toBe("linear_destination_invalid");
  });

  it("projeto arquivado no meio continua project_archived", async () => {
    const runId = await begin(team(issues(3)));
    await h.pool.query("update projects set archived_at = now() where id = $1::uuid", [open()]);
    const res = await step(runId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });
});

describe("A1.7 falhas seguidas ficam registradas, nunca em laço silencioso", () => {
  it("três falhas seguidas do mesmo erro gravam o código e o contador; um passo que grava zera", async () => {
    const runId = await begin(team(issues(3)));
    await step(runId); // projects
    await h.pool.query("create function l7_boom() returns trigger language plpgsql as $$ begin raise exception 'l7 boom'; end $$");
    await h.pool.query("create trigger l7_boom before insert on ticket_external_refs for each row execute function l7_boom()");
    for (let i = 1; i <= 3; i += 1) {
      const res = await step(runId);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await run(runId)).toMatchObject({ phase: "issues", error_streak: i, last_error_code: "step_failed" });
    }
    await h.pool.query("drop trigger l7_boom on ticket_external_refs");
    const ok = await step(runId);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ errorStreak: 0, lastErrorCode: null });
    expect((await run(runId))["error_streak"]).toBe(0);
  });

  it("o mesmo erro do Linear (chave recusada) também conta; código diferente recomeça a contagem", async () => {
    const runId = await begin(team(issues(3)));
    h.linear().use(() => ({ status: 400, body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }));
    for (let i = 1; i <= 3; i += 1) {
      expect((await step(runId)).status).toBe(422);
      expect(await run(runId)).toMatchObject({ error_streak: i, last_error_code: "linear_key_invalid" });
    }
    h.linear().use(() => ({ status: 503, body: {} }));
    expect((await step(runId)).status).toBe(503);
    expect(await run(runId)).toMatchObject({ error_streak: 1, last_error_code: "linear_unavailable" });
    void KEY;
  });
});
