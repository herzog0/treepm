import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue } from "./linear-support.js";
import { ORG, as } from "./world.js";

const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;

const LP = { a: "lp-alfa", b: "lp-beta", c: "lp-gama" };
const issue = (n: number, over: Partial<FakeIssue> = {}): FakeIssue => ({ id: `i${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, project: n <= 40 ? LP.a : n <= 80 ? LP.b : null, ...over });
/** 120 issues (3 páginas de 50/50/20), com o pai de i3 (i110) só na terceira página. */
function dataset(): FakeIssue[] {
  const all = Array.from({ length: 120 }, (_, i) => issue(i + 1));
  const set = (n: number, over: Partial<FakeIssue>) => Object.assign(all[n - 1] as FakeIssue, over);
  set(3, { parent: "i110", project: LP.a });
  set(4, { parent: "i3" });
  set(5, { parent: "issue-de-outro-time", project: LP.a });
  set(10, { state: "completed" });
  set(11, { parent: "i10", state: "unstarted" });
  set(12, { parent: "i10", state: "completed" });
  set(20, { assignee: { id: "u-admin", email: "  ADMIN@Exemplo.TEST " }, priority: 1 });
  set(21, { assignee: { id: "u-dup", email: "Dup@Exemplo.test" }, priority: 2 });
  set(22, { assignee: { id: "u-teste", email: "bia@teste.invalid" }, priority: 3 });
  set(23, { assignee: { id: "u-nada", email: "ninguem@exemplo.test" }, priority: 4 });
  set(24, { assignee: { id: "u-off", email: "saiu@exemplo.test" } });
  set(30, { state: "started" });
  set(31, { state: "canceled" });
  set(32, { state: "duplicate" });
  set(33, { state: "triage" });
  set(42, { trashed: true });
  set(43, { description: "Falar com [@Ana](person:0190a1b2-0000-7000-8000-000000000001) e ver [x](person:abc)" });
  set(44, { title: "x".repeat(300), description: "y".repeat(25_000) });
  return all;
}

async function seedPeople(): Promise<void> {
  const add = (user: string, email: string, extra = "") =>
    h.pool.query(`insert into people (org_id, clerk_user_id, display_name, email, clerk_role${extra ? ", " + extra.split("=")[0] : ""}) values ($1,$2,$3,$4,'member'${extra ? ", " + extra.split("=")[1] : ""})`, [ORG, user, user, email]);
  await add("u_dup1", "dup@exemplo.test");
  await add("u_dup2", "DUP@exemplo.test");
  await add("treepm_test_bia", "bia@teste.invalid", "is_test=true");
  await add("u_off", "saiu@exemplo.test", "active=false");
}

const world = () => ({ [TEAM_ENG.id]: { projects: [{ id: LP.a, name: "Alfa" }, { id: LP.b, name: "Beta" }, { id: LP.c, name: "Gama" }], issues: dataset() } });
const post = (path: string, who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);

async function importAll(body: unknown = {}): Promise<{ runId: string; steps: number; last: Record<string, unknown> & { done?: boolean; counts?: Record<string, number>; finishedAt?: unknown } }> {
  await seedPeople();
  await linkWithData(h, put, open(), world());
  const run = await post("", "admin", body);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  let last = run.body as Record<string, unknown> & { done?: boolean; counts?: Record<string, number>; finishedAt?: unknown };
  let steps = 0;
  while (!last.done && steps < 60) {
    const res = await post(`/${run.body.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    last = res.body;
    steps += 1;
  }
  return { runId: run.body.id as string, steps, last };
}

const byExt = async (): Promise<Map<string, Row>> => {
  const rows = await q(
    `select r.external_id, r.kind, r.external_key, t.id, t.number, t.title, t.status, t.priority, t.parent_id, t.description,
            (select array_agg(a.person_id::text) from ticket_assignees a where a.ticket_id = t.id) as assignees
       from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid`,
    [open()],
  );
  return new Map(rows.map((row) => [row.external_id as string, row]));
};

describe("importação completa do time (120 issues, 3 projetos, 3 páginas)", () => {
  it("roda os passos até done, com as contagens e a rodada concluída", async () => {
    const { last, steps } = await importAll();
    expect(last).toMatchObject({ phase: "done", done: true, totalExpected: 119, waitUntil: null, lastErrorCode: null });
    expect(last["finishedAt"]).toBeTruthy();
    expect(last["counts"]).toMatchObject({ projectsSeen: 3, projectsCreated: 3, issuesSeen: 120, issuesTrashed: 1, issuesCreated: 119, skipped: 0, flattened: 0 });
    expect(steps).toBeGreaterThanOrEqual(5); // projetos, 3 de issues, hierarquia
    expect(await q("select 1 from tickets where project_id = $1::uuid", [open()])).toHaveLength(3 + 119 + 0);
  });

  it("a árvore: pai vence projeto; pai que chega depois; pai de outro time vira sem pai; sem projeto na raiz", async () => {
    await importAll();
    const t = await byExt();
    const id = (ext: string) => t.get(ext)?.id as string;
    const parent = (ext: string) => t.get(ext)?.parent_id as string | null;
    expect(parent(LP.a)).toBeNull();
    expect(parent("i1")).toBe(id(LP.a));
    expect(parent("i41")).toBe(id(LP.b));
    expect(parent("i90")).toBeNull();
    expect(parent("i110")).toBeNull(); // pai de i3, sem projeto: raiz
    expect(parent("i3")).toBe(id("i110")); // o pai chegou na página seguinte; vence o projeto
    expect(parent("i4")).toBe(id("i3"));
    expect(parent("i5")).toBe(id(LP.a)); // pai de outro time: sem pai, fica no projeto
    expect(t.has(LP.c)).toBe(true); // projeto sem issue vira ticket vazio
    expect(t.has("i42")).toBe(false); // na lixeira
  });

  it("situações, prioridade, título e descrição", async () => {
    await importAll();
    const t = await byExt();
    const s = (ext: string) => t.get(ext)?.status;
    expect([s("i1"), s("i30"), s("i31"), s("i32"), s("i33")]).toEqual(["todo", "in_progress", "cancelled", "cancelled", "todo"]);
    expect(s("i10")).toBe("todo"); // concluída com filha aberta nasce a fazer
    expect(s("i12")).toBe("done");
    expect([20, 21, 22, 23].map((n) => t.get(`i${n}`)?.priority)).toEqual([400, 300, 200, 100]);
    expect(t.get("i1")?.priority).toBe(0);
    expect((t.get("i44")?.title as string).length).toBe(200);
    expect((t.get("i44")?.description as string).length).toBe(20_000);
    const desc = t.get("i43")?.description as string;
    expect(desc).toContain("@Ana");
    expect(desc).not.toMatch(/\]\(\s*person:/i);
  });

  it("responsáveis: e-mail único casa (sem diferenciar caixa); duplicado, de teste, inativo e inexistente ficam sem", async () => {
    await importAll();
    const t = await byExt();
    expect(t.get("i20")?.assignees).toEqual([h.world().people.admin]);
    for (const n of [21, 22, 23, 24, 1]) expect(t.get(`i${n}`)?.assignees ?? null).toBeNull();
  });

  it("a origem de cada ticket: provedor, tipo, chave, endereço e retratos sem e-mail", async () => {
    await importAll();
    const rows = await q("select kind, external_key, external_url, external_parent_id, external_project_id, source_snapshot, applied_snapshot from ticket_external_refs where external_id = 'i20'");
    expect(rows[0]).toMatchObject({ kind: "issue", external_key: "ENG-20", external_parent_id: null, external_project_id: LP.a });
    expect(rows[0]?.external_url).toBe("https://linear.app/acme/issue/ENG-20");
    expect(rows[0]?.source_snapshot).toMatchObject({ title: "Issue 20", stateType: "unstarted", assigneeExternalId: "u-admin", priority: 1 });
    expect(rows[0]?.applied_snapshot).toMatchObject({ title: "Issue 20", status: "todo", priority: 400, assigneeIds: [h.world().people.admin] });
    const proj = await q("select kind, external_key from ticket_external_refs where external_id = $1", [LP.a]);
    expect(proj).toEqual([{ kind: "project", external_key: null }]);
  });

  it("applied_snapshot acompanha o que a hierarquia e a reabertura aplicaram (pai e situação)", async () => {
    await importAll();
    const t = await byExt();
    const snap = async (ext: string) => (await q("select applied_snapshot s from ticket_external_refs where external_id = $1", [ext]))[0]?.s as Record<string, unknown>;
    expect((await snap("i3"))["parentId"]).toBe(t.get("i110")?.id);
    expect((await snap("i10"))["status"]).toBe("todo");
    expect((await snap("i4"))["parentId"]).toBe(t.get("i3")?.id);
  });

  it("a atividade do projeto traz as contagens, sem e-mail", async () => {
    const { runId } = await importAll();
    const rows = await q("select kind, payload from activity_events where subject_id = $1 and kind = 'ticket.imported_from_linear'", [open()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ provider: "linear", runId, counts: { issuesCreated: 119 } });
    expect(JSON.stringify(rows[0]?.payload)).not.toMatch(/@/);
  });

  it("segunda rodada no projeto concluído → 409 linear_reimport_not_available", async () => {
    await importAll();
    const res = await post("");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_reimport_not_available");
  });

  it("com destino: tudo o que não tem pai nem projeto entra sob o destino, e a árvore fica dentro dele", async () => {
    await seedPeople();
    await linkWithData(h, put, open(), world());
    const dest = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    const run = await post("", "admin", { destinationTicketId: dest });
    for (let i = 0; i < 40 && !(await q("select 1 from external_import_runs where phase = 'done'")).length; i += 1) await post(`/${run.body.id}/step`);
    const t = await byExt();
    expect(t.get(LP.a)?.parent_id).toBe(dest);
    expect(t.get("i90")?.parent_id).toBe(dest);
    expect(t.get("i1")?.parent_id).toBe(t.get(LP.a)?.id);
    expect(t.get("i110")?.parent_id).toBe(dest);
  });
});

describe("GET /api/tickets/:id traz a origem para 'Ver no Linear · ENG-123'", () => {
  it("externalSource com provedor, chave e endereço; nulo para ticket comum; sem retratos nem ids do Linear", async () => {
    await importAll();
    const t = await byExt();
    const res = await h.call("GET", `/api/tickets/${t.get("i20")?.id}`, as("admin"));
    expect(res.status).toBe(200);
    expect(res.body.externalSource).toEqual({ provider: "linear", key: "ENG-20", url: "https://linear.app/acme/issue/ENG-20" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("u-admin");
    expect(text).not.toMatch(/snapshot|externalId|external_id/i);
    const project = await h.call("GET", `/api/tickets/${t.get(LP.a)?.id}`, as("admin"));
    expect(project.body.externalSource).toMatchObject({ provider: "linear", key: null });
    const manual = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Mão" })).body.id as string;
    expect((await h.call("GET", `/api/tickets/${manual}`, as("admin"))).body.externalSource).toBeNull();
  });
});
