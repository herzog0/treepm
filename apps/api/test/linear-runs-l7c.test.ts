import { afterEach, describe, expect, it } from "vitest";
import { KEY, TEAM_ENG, TEAM_OPS, WORKSPACE, linearImportWorld, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { ORG, as } from "./world.js";

// L7: testes que faltavam: contagens `*Elsewhere` (origem em outro projeto) e a UNIQUE da origem disparando no meio de um lote.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const other = () => h.world().projects.priv;
const post = (project: string, path: string, body: unknown = {}) => h.call("POST", `/api/projects/${project}/linear/runs${path}`, as("admin"), body);
const issues = (ids: string[], over: Partial<FakeIssue> = {}): FakeIssue[] => ids.map((id) => ({ id, identifier: id.toUpperCase(), ...over }));

afterEach(async () => {
  await h.pool.query("drop trigger if exists l7_unique on ticket_external_refs");
  await h.pool.query("drop function if exists l7_unique()");
});

async function runAll(project: string): Promise<RunBody> {
  const run = await post(project, "");
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  for (let i = 0; i < 40; i += 1) {
    const res = await post(project, `/${run.body.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}

describe("origem em OUTRO projeto do TreePM (projectsElsewhere, issuesElsewhere)", () => {
  it("issue que mudou de time e projeto do Linear compartilhado por dois times ligados: não duplica, conta Elsewhere", async () => {
    const data: Record<string, FakeTeamData> = {
      [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Compartilhado" }], issues: issues(["i1", "i2"], { project: "lp1" }) },
      [TEAM_OPS.id]: { projects: [{ id: "lp1", name: "Compartilhado" }, { id: "lp2", name: "Só do OPS" }], issues: [...issues(["i1"], { project: "lp1" }), ...issues(["o1"], { project: "lp2" })] },
    };
    await linkWithData(h, put, open(), data);
    const link = await h.call("POST", `/api/projects/${other()}/linear`, as("admin"), { teamId: TEAM_OPS.id, confirmTeamKey: TEAM_OPS.key });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    h.linear().use(linearImportWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] } }, data));
    const first = await runAll(open());
    expect(first.counts).toMatchObject({ projectsCreated: 1, issuesCreated: 2, projectsElsewhere: 0, issuesElsewhere: 0 });
    const second = await runAll(other());
    expect(second.counts).toMatchObject({ projectsSeen: 2, projectsCreated: 1, projectsElsewhere: 1, issuesSeen: 2, issuesCreated: 1, issuesElsewhere: 1, issuesExisting: 0 });
    // nada duplicado na organização
    expect((await q("select count(*)::int n, count(distinct (kind, external_id))::int d from ticket_external_refs"))[0]).toEqual({ n: 5, d: 5 });
    // o ticket de cada origem continua no projeto onde nasceu
    expect((await q("select project_id from ticket_external_refs where external_id = 'i1'"))[0]!["project_id"]).toBe(open());
  });
});

describe("UNIQUE da origem disparando no meio de um lote", () => {
  it("aborta o passo inteiro (nada pela metade, cursor intacto) e, resolvido o conflito, o mesmo passo conclui sem duplicar", async () => {
    const data: Record<string, FakeTeamData> = { [TEAM_ENG.id]: { projects: [], issues: issues(["i1", "i2", "i3", "i4", "i5"]) } };
    await linkWithData(h, put, open(), data);
    const run = await post(open(), "");
    const runId = run.body.id as string;
    await post(open(), `/${runId}/step`); // projects (vazio)
    // Um ticket de outro projeto que será o "vencedor da corrida" por i3: um gatilho grava a origem de i3 ANTES da linha do lote.
    const winner = (await q("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,1,'Vencedor',$3::uuid) returning id", [ORG, other(), h.world().people.admin]))[0]!["id"] as string;
    await h.pool.query(`create function l7_unique() returns trigger language plpgsql as $$ begin
      if new.external_id = 'i3' and not exists (select 1 from ticket_external_refs where external_id = 'i3') then
        insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, external_url, source_snapshot, applied_snapshot)
        values (new.org_id, '${winner}', '${other()}', 'linear', 'issue', 'i3', null, '{}', '{}');
      end if; return new; end $$`);
    await h.pool.query("create trigger l7_unique before insert on ticket_external_refs for each row execute function l7_unique()");
    const before = (await q("select cursor, phase from external_import_runs where id = $1::uuid", [runId]))[0];
    const failed = await post(open(), `/${runId}/step`);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect((await q("select count(*)::int n from tickets where project_id = $1::uuid", [open()]))[0]!["n"]).toBe(0);
    expect((await q("select count(*)::int n from ticket_external_refs where external_id <> 'i3'"))[0]!["n"]).toBe(0);
    expect((await q("select cursor, phase from external_import_runs where id = $1::uuid", [runId]))[0]).toEqual(before);
    // o conflito agora é um fato (a origem de i3 já existe, em outro projeto): o passo conclui e conta Elsewhere
    await h.pool.query("drop trigger l7_unique on ticket_external_refs");
    await h.pool.query("insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, external_url, source_snapshot, applied_snapshot) values ($1,$2::uuid,$3::uuid,'linear','issue','i3',null,'{}','{}')", [ORG, winner, other()]);
    const ok = await post(open(), `/${runId}/step`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.counts).toMatchObject({ issuesCreated: 4, issuesElsewhere: 1 });
    expect((await q("select count(*)::int n, count(distinct external_id)::int d from ticket_external_refs where external_id like 'i%'"))[0]).toEqual({ n: 5, d: 5 });
  });
});
