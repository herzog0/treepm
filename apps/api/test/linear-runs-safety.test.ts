import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, KEY_B, TEAM_ENG, TEAM_OPS, WORKSPACE, linearImportWorld, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, LinearWorld } from "./linear-support.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";
import { ORG, as } from "./world.js";

const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const step = (runId: string, who: Parameters<typeof as>[0] = "admin") => post(`/${runId}/step`, who);

const issues = (n: number): FakeIssue[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, identifier: `ENG-${i + 1}`, project: i < 60 ? "lp1" : null, parent: i === 4 ? "i110" : null, assignee: i === 1 ? { id: "u1", email: "  ADMIN@Exemplo.TEST " } : null }));
const data = (n = 120) => ({ [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }, { id: "lp2", name: "Beta" }], issues: issues(n) } });
const baseWorld = (): LinearWorld => ({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] } });

async function start(n = 120): Promise<string> {
  await linkWithData(h, put, open(), data(n));
  const run = await post("");
  expect(run.status).toBe(201);
  return run.body.id as string;
}
const done = async (runId: string): Promise<boolean> => (await q("select phase from external_import_runs where id = $1::uuid", [runId]))[0]?.phase === "done";
const tickets = async () => (await q("select count(*)::int n from tickets where project_id = $1::uuid", [open()]))[0]?.n as number;
const refs = async () => (await q("select count(*)::int n, count(distinct external_id)::int d from ticket_external_refs where project_id = $1::uuid", [open()]))[0] as { n: number; d: number };

/** Programa o Linear de teste com um tratador que pode trocar a resposta; os dados são os de `data`. */
function program(wrap: (call: LinearCall, next: () => LinearReply) => LinearReply | null, n = 120, world: LinearWorld = baseWorld()): void {
  const base = linearImportWorld(world, data(n));
  h.linear().use((call) => wrap(call, () => base(call)) ?? base(call));
}

afterEach(() => vi.restoreAllMocks());

describe("idempotência e retomada", () => {
  it("repetir o mesmo passo (resposta perdida) não duplica nada", async () => {
    const runId = await start();
    await step(runId); // projects
    await step(runId); // issues, página 1
    const before = await tickets();
    await h.pool.query("update external_import_runs set phase = 'issues', cursor = null where id = $1::uuid", [runId]); // outra instância repetindo a página 1
    const again = await step(runId);
    expect(again.status).toBe(200);
    expect(again.body.counts.issuesExisting).toBe(50);
    expect(await tickets()).toBe(before);
    expect(await refs()).toMatchObject({ n: before, d: before });
  });

  it("passos repetidos ao acaso (a rodada volta atrás de vez em quando) terminam com a mesma árvore e sem duplicata", async () => {
    const runId = await start();
    let seed = 7;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < 120 && !(await done(runId)); i += 1) {
      const saved = (await q("select phase, cursor from external_import_runs where id = $1::uuid", [runId]))[0] as { phase: string; cursor: string | null };
      const res = await step(runId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      if (!res.body.done && rand() < 0.35) await h.pool.query("update external_import_runs set phase = $2, cursor = $3 where id = $1::uuid", [runId, saved.phase, saved.cursor]);
    }
    expect(await done(runId)).toBe(true);
    expect(await tickets()).toBe(120 + 2);
    expect(await refs()).toMatchObject({ n: 122, d: 122 });
    const parent = await q("select p.parent_id = (select ticket_id from ticket_external_refs where external_id = 'lp1') as under_alfa from tickets p join ticket_external_refs r on r.ticket_id = p.id where r.external_id = 'i1'");
    expect(parent[0]?.under_alfa).toBe(true);
  });

  it("dois passos ao mesmo tempo na mesma rodada: um recebe 409 linear_step_in_progress e nada duplica", async () => {
    const runId = await start();
    let second: { status: number; body: { error: { code: string } } } | null = null;
    h.linear().beforeReply = async (call) => {
      if (second === null && call.query.includes("TeamProjects")) second = await step(runId);
    };
    const first = await step(runId);
    h.linear().beforeReply = null;
    expect(first.status).toBe(200);
    expect(second).toMatchObject({ status: 409 });
    expect((second as unknown as { body: { error: { code: string } } }).body.error.code).toBe("linear_step_in_progress");
    expect(await refs()).toMatchObject({ n: 2 });
  });

  it("fecha no meio e retoma: o estado vem de GET current e outra pessoa com chave do mesmo workspace termina", async () => {
    const runId = await start();
    await step(runId);
    await step(runId);
    const current = await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"));
    expect(current.body.run).toMatchObject({ id: runId, phase: "issues", done: false });
    await put("manager"); // a própria chave da outra pessoa, mesmo workspace
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2::uuid,$3::uuid,'manager') on conflict do nothing", [ORG, open(), h.world().people.manager]);
    for (let i = 0; i < 40 && !(await done(runId)); i += 1) expect((await step(runId, "manager")).status).toBe(200);
    expect(await done(runId)).toBe(true);
    expect(await tickets()).toBe(122);
    // O ticket fica com quem executou o passo; a rodada, com quem abriu.
    const row = (await q("select started_by_person_id from external_import_runs where id = $1::uuid", [runId]))[0];
    expect(row?.started_by_person_id).toBe(h.world().people.admin);
  });

  it("passo em rodada já concluída devolve o estado sem ir ao Linear; rodada de outro projeto ou inexistente → 404", async () => {
    const runId = await start(10);
    for (let i = 0; i < 10 && !(await done(runId)); i += 1) await step(runId);
    const calls = h.linear().calls.length;
    const again = await step(runId);
    expect(again.body).toMatchObject({ phase: "done", done: true });
    expect(h.linear().calls.length).toBe(calls);
    expect((await step("0190a1b2-0000-7000-8000-000000000999")).status).toBe(404);
    expect((await h.call("POST", `/api/projects/${h.world().projects.priv}/linear/runs/${runId}/step`, as("admin"))).status).toBe(404);
  });
});

describe("limite do Linear e erros", () => {
  it("limite no meio: 200 com waitUntil, nada gravado; antes da hora responde igual sem chamar o Linear; depois da hora segue", async () => {
    let limited = true;
    const runId = await start();
    program((call) => (limited && call.query.includes("TeamIssues") && call.variables["after"] === null ? { status: 429, headers: { "Retry-After": "30" }, body: {} } : null));
    await step(runId); // projects
    const hit = await step(runId);
    expect(hit.status).toBe(200);
    expect(hit.body.phase).toBe("issues");
    expect(hit.body.waitUntil).toBeTruthy();
    expect(hit.body.lastErrorCode).toBe("linear_rate_limited");
    expect(new Date(hit.body.waitUntil).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await tickets()).toBe(2);
    const calls = h.linear().calls.length;
    const early = await step(runId);
    expect(early.body.waitUntil).toBe(hit.body.waitUntil);
    expect(h.linear().calls.length).toBe(calls);
    limited = false;
    await h.pool.query("update external_import_runs set wait_until = now() - interval '1 second' where id = $1::uuid", [runId]);
    const go = await step(runId);
    expect(go.body).toMatchObject({ phase: "issues", waitUntil: null, lastErrorCode: null });
    expect(await tickets()).toBe(2 + 50);
  });

  it("limite já na conferência de acesso (requireLinearAccess) também vira espera", async () => {
    const runId = await start();
    program((call) => (call.query.includes("team(id") && call.query.includes("{ id key name }") ? { status: 429, headers: { "Retry-After": "5" }, body: {} } : null));
    const res = await step(runId);
    expect(res.status).toBe(200);
    expect(res.body.waitUntil).toBeTruthy();
  });

  it("chave trocada por uma inválida: 422 linear_key_invalid, a rodada segue aberta e retoma quando a chave volta", async () => {
    const runId = await start();
    await step(runId);
    h.linear().use(linearImportWorld({ [KEY]: "invalid" }, data()));
    const bad = await step(runId);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("linear_key_invalid");
    expect((await q("select phase, last_error_code from external_import_runs where id = $1::uuid", [runId]))[0]).toEqual({ phase: "issues", last_error_code: "linear_key_invalid" });
    h.linear().use(linearImportWorld(baseWorld(), data()));
    const ok = await step(runId);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ lastErrorCode: null });
  });

  it("time que a chave deixou de enxergar → 403 linear_team_not_visible; chave de outro workspace → 403 linear_workspace_mismatch", async () => {
    const runId = await start();
    h.linear().use(linearImportWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_OPS] } }, data()));
    const hidden = await step(runId);
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.code).toBe("linear_team_not_visible");
    h.linear().use(linearImportWorld({ ...baseWorld(), [KEY_B]: { workspace: { id: "ws-2", name: "Beta", urlKey: "beta" }, teams: [TEAM_ENG] } }, data()));
    await put("admin", KEY_B);
    const other = await step(runId);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("linear_workspace_mismatch");
    expect((await q("select phase from external_import_runs where id = $1::uuid", [runId]))[0]?.phase).toBe("projects");
  });

  it("Linear fora do ar (5xx) → 503 e a rodada fica intacta", async () => {
    const runId = await start();
    h.linear().use(() => ({ status: 502, body: {} }));
    const res = await step(runId);
    expect(res.status).toBe(503);
    expect((await q("select phase, cursor from external_import_runs where id = $1::uuid", [runId]))[0]).toEqual({ phase: "projects", cursor: null });
    expect(await tickets()).toBe(0);
  });
});

describe("privacidade e segurança", () => {
  const spyLogs = (): string[] => {
    const lines: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as never);
    }
    return lines;
  };

  it("o e-mail do Linear não aparece em banco (origem, rodada, atividade), respostas nem logs; nenhuma IA é chamada", async () => {
    const logs = spyLogs();
    const runId = await start();
    const bodies: unknown[] = [];
    for (let i = 0; i < 40 && !(await done(runId)); i += 1) bodies.push((await step(runId)).body);
    expect(await done(runId)).toBe(true);
    // O responsável foi casado (e-mail só no Linear, com caixa e espaços diferentes do do banco).
    expect((await q("select count(*)::int n from ticket_assignees"))[0]?.n).toBe(1);
    const dump = JSON.stringify([
      await q("select * from ticket_external_refs"),
      await q("select * from external_import_runs"),
      await q("select kind, payload from activity_events"),
      await q("select title, description from tickets"),
      bodies,
      logs,
    ]).toLowerCase();
    expect(dump).not.toContain("exemplo.test");
    expect(dump).not.toContain(KEY.toLowerCase());
    for (const fake of [h.conversation(), h.judge(), h.summarizer(), h.affinity(), h.related(), h.namer(), h.writer(), h.chat(), h.elaborator(), h.embedder()]) {
      expect((fake as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    }
  });

  it("recusados: sem permissão de importar, projeto arquivado no meio, 'entrar como' e outra organização", async () => {
    const runId = await start(10);
    expect((await step(runId, "reader")).status).toBe(403);
    expect((await step(runId, "plain")).status).toBe(403);
    expect((await h.call("POST", `/api/projects/${open()}/linear/runs/${runId}/step`, as("admin", "org_B"))).status).toBe(404);
    await h.pool.query("update projects set archived_at = now() where id = $1::uuid", [open()]);
    const archived = await step(runId);
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe("project_archived");
    expect(await tickets()).toBe(0);
  });

  it("texto do Linear não vira menção de pessoa nem estoura os limites (título, descrição)", async () => {
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: { projects: [], issues: [{ id: "i1", title: "[@Ana](person:abc) " + "t".repeat(400), description: "[@Bia](person:def) " + "d".repeat(30_000) }] } });
    const runId = (await post("")).body.id as string;
    for (let i = 0; i < 10 && !(await done(runId)); i += 1) await step(runId);
    const row = (await q("select title, description from tickets"))[0] as { title: string; description: string };
    expect(row.title.length).toBeLessThanOrEqual(200);
    expect(row.description.length).toBeLessThanOrEqual(20_000);
    expect(`${row.title}${row.description}`).not.toMatch(/\]\(\s*person:/i);
    expect(row.title.startsWith("@Ana")).toBe(true);
  });
});
