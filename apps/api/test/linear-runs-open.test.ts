import { describe, expect, it } from "vitest";
import { KEY, TEAM_ENG, WORKSPACE, linearImportWorld, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue } from "./linear-support.js";
import { actAs, createTestPerson } from "./act-as-support.js";
import { ORG, as } from "./world.js";

const { h, put } = useLinearHarness();
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Record<string, unknown>[];
const open = () => h.world().projects.org;
const priv = () => h.world().projects.priv;
const issues = (n: number): FakeIssue[] => Array.from({ length: n }, (_, i) => ({ id: `iss-${i + 1}` }));
const data = (n = 3) => ({ [TEAM_ENG.id]: { projects: [], issues: issues(n) } });
const runs = (projectId: string, body: unknown = {}, who: Parameters<typeof as>[0] = "admin") => h.call("POST", `/api/projects/${projectId}/linear/runs`, as(who), body);
const current = (projectId: string, who: Parameters<typeof as>[0] = "admin") => h.call("GET", `/api/projects/${projectId}/linear/runs/current`, as(who));

describe("POST /api/projects/:id/linear/runs", () => {
  it("abre a rodada (fase projects, modo first), com o total de issues do time e sem categorização", async () => {
    await linkWithData(h, put, open(), data(7));
    const res = await runs(open());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      projectId: open(),
      mode: "first",
      phase: "projects",
      done: false,
      categorize: false,
      categorizeAvailable: false,
      totalExpected: 7,
      waitUntil: null,
      lastErrorCode: null,
      destinationTicketId: null,
      finishedAt: null,
    });
    expect(res.body.counts).toMatchObject({ projectsCreated: 0, issuesCreated: 0 });
    expect(res.body.startedBy).toEqual({ id: h.world().people.admin });
    const rows = await q("select phase, mode, cursor, started_by_person_id, total_expected from external_import_runs where org_id = $1", [ORG]);
    expect(rows).toEqual([{ phase: "projects", mode: "first", cursor: null, started_by_person_id: h.world().people.admin, total_expected: 7 }]);
  });

  it("guarda categorize: true mas a resposta diz categorizeAvailable: false (a fase é pulada nesta fatia)", async () => {
    await linkWithData(h, put, open(), data());
    const res = await runs(open(), { categorize: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ categorize: true, categorizeAvailable: false });
  });

  it("o destino é um ticket do projeto; outro projeto ou inexistente → 404", async () => {
    await linkWithData(h, put, open(), data());
    const mine = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    const foreign = (await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "De fora" })).body.id as string;
    expect((await runs(open(), { destinationTicketId: foreign })).status).toBe(404);
    expect((await runs(open(), { destinationTicketId: "0190a1b2-0000-7000-8000-000000000999" })).status).toBe(404);
    const ok = await runs(open(), { destinationTicketId: mine });
    expect(ok.status).toBe(201);
    expect(ok.body.destinationTicketId).toBe(mine);
  });

  it("destino dentro de uma ideia → 409 ticket_in_idea", async () => {
    await linkWithData(h, put, open(), data());
    const idea = await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Ideia", idea: true });
    expect(idea.status).toBeLessThan(300);
    const res = await runs(open(), { destinationTicketId: idea.body.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_in_idea");
  });

  it("corpo inválido → 422/400 sem abrir rodada", async () => {
    await linkWithData(h, put, open(), data());
    for (const body of [{ extra: 1 }, { destinationTicketId: 7 }, { categorize: "sim" }, { destinationTicketId: "nao-e-id" }]) {
      expect([400, 422]).toContain((await runs(open(), body)).status);
    }
    expect(await q("select 1 from external_import_runs")).toHaveLength(0);
  });

  it("projeto não ligado → 409 linear_not_linked", async () => {
    h.linear().use(linearImportWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG] } }, {}));
    await put("admin");
    const res = await runs(open());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_linked");
  });

  it("segunda rodada com uma aberta → 409 linear_run_open, devolvendo a aberta", async () => {
    await linkWithData(h, put, open(), data());
    const first = await runs(open());
    const second = await runs(open());
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("linear_run_open");
    expect(second.body.error.details.run.id).toBe(first.body.id);
    expect(await q("select 1 from external_import_runs")).toHaveLength(1);
  });

  it("projeto com rodada concluída → 409 linear_reimport_not_available (a reimportação é a fatia 3)", async () => {
    await linkWithData(h, put, open(), data());
    const first = await runs(open());
    await h.pool.query("update external_import_runs set phase = 'done', finished_at = now() where id = $1::uuid", [first.body.id]);
    const res = await runs(open());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_reimport_not_available");
    expect(await q("select 1 from external_import_runs")).toHaveLength(1);
  });

  it("recusa quem não pode importar (404 sem ver o projeto, 403 vendo), projeto arquivado e 'entrar como'", async () => {
    await linkWithData(h, put, open(), data());
    expect((await runs(open(), {}, "reader")).status).toBe(403);
    expect((await runs(priv(), {}, "plain")).status).toBe(404);
    await h.pool.query("update projects set archived_at = now() where id = $1::uuid", [open()]);
    const archived = await runs(open());
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe("project_archived");
    expect(await q("select 1 from external_import_runs")).toHaveLength(0);
  });

  it("sem chave conectada → 409 linear_not_connected", async () => {
    await linkWithData(h, put, open(), data());
    await h.call("DELETE", "/api/linear/connection", as("admin"));
    const none = await runs(open());
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("linear_not_connected");
  });

  it("'entrar como' é recusado", async () => {
    await linkWithData(h, put, open(), data());
    const res = await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {}, actAs((await createTestPerson(h)).id));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:id/linear/runs/current", () => {
  it("sem rodada → { run: null }; com rodada aberta → ela; depois de concluída → a última", async () => {
    await linkWithData(h, put, open(), data());
    expect((await current(open())).body).toEqual({ run: null });
    const first = await runs(open());
    expect((await current(open())).body.run.id).toBe(first.body.id);
    await h.pool.query("update external_import_runs set phase = 'done', finished_at = now() where id = $1::uuid", [first.body.id]);
    const last = (await current(open())).body.run;
    expect(last).toMatchObject({ id: first.body.id, phase: "done", done: true });
  });

  it("exige a permissão de importar, vê só o próprio projeto e recusa organização errada", async () => {
    await linkWithData(h, put, open(), data());
    await runs(open());
    expect((await current(open(), "reader")).status).toBe(403);
    expect((await current(priv(), "plain")).status).toBe(404);
    const other = await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin", "org_B"));
    expect(other.status).toBe(404);
  });
});
