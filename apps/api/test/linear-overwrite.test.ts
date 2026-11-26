import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeComment, FakeIssue, FakeLabel, FakeRelation, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// ADR 0066: "Sobrescrever com o Linear". `fetch` falso: nada chama o Linear nem provedor de IA.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; mode?: string; overwrite?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const people = () => h.world().people;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const patch = async (id: unknown, body: unknown): Promise<void> => {
  const res = await h.call("PATCH", `/api/tickets/${String(id)}`, as("admin"), body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

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
const sync = async (body: unknown = {}): Promise<RunBody> => finish(await begin(body));
const overwrite = async (): Promise<RunBody> => sync({ overwrite: true });

const L1: FakeLabel = { id: "lab-1", name: "Bug", color: "#eb5757" };
const L2: FakeLabel = { id: "lab-2", name: "Front", color: "#4ea7fc" };
type World = { team: FakeTeamData; list: FakeIssue[] };
function base(): World {
  const list: FakeIssue[] = [
    { id: "p1", identifier: "ENG-1", title: "Pai um", project: "lp1" },
    { id: "p2", identifier: "ENG-2", title: "Pai dois", project: "lp1" },
    { id: "t", identifier: "ENG-3", title: "Título do Linear", dueDate: null, project: "lp1" },
    { id: "d", identifier: "ENG-4", title: "Descrição", description: "Texto do Linear", project: "lp1" },
    { id: "p", identifier: "ENG-5", title: "Prioridade", priority: 2, project: "lp1" },
    { id: "due", identifier: "ENG-6", title: "Prazo", dueDate: "2026-12-01", project: "lp1" },
    { id: "s", identifier: "ENG-7", title: "Situação", state: "started", project: "lp1" },
    { id: "asg", identifier: "ENG-8", title: "Responsável", assignee: { id: "u-admin", email: "admin@exemplo.test" }, project: "lp1" },
    { id: "par", identifier: "ENG-9", title: "Com pai", parent: "p1" },
    { id: "loose", identifier: "ENG-10", title: "Solta" },
    { id: "lab", identifier: "ENG-11", title: "Etiquetas", labels: [L1, L2], project: "lp1" },
    { id: "rel-a", identifier: "ENG-12", title: "Rel A", project: "lp1" },
    { id: "rel-b", identifier: "ENG-13", title: "Rel B", project: "lp1" },
  ];
  const comments: FakeComment[] = [{ id: "c-1", issue: "t", body: "Comentário do Linear", createdAt: "2026-03-01T10:00:00.000Z", user: { id: "u-x", name: "Xis", email: "xis@linear.test" } }];
  const relations: FakeRelation[] = [{ id: "r-1", type: "related", from: "rel-a", to: "rel-b" }];
  return { list, team: { projects: [{ id: "lp1", name: "Alfa" }], issues: list, comments, relations } };
}
const issue = (world: World, id: string): FakeIssue => world.list.find((item) => item.id === id) as FakeIssue;

async function firstImport(world: World = base()): Promise<World> {
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: world.team });
  const first = await sync();
  expect(first.mode).toBe("first");
  return world;
}
const ticketOf = async (externalId: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [externalId]))[0]!["ticket_id"] as string;
async function ticket(externalId: string): Promise<Row> {
  const rows = await q(
    `select t.id, t.title, t.description, t.priority, t.status, t.parent_id, to_char(t.due_date, 'YYYY-MM-DD') as due_date, r.source_snapshot, r.applied_snapshot, r.status_pending, r.hierarchy_pending,
            coalesce((select array_agg(a.person_id::text order by a.person_id) from ticket_assignees a where a.ticket_id = t.id), '{}') as assignees,
            coalesce((select array_agg(pl.name order by pl.name) from ticket_labels tl join project_labels pl on pl.id = tl.label_id where tl.ticket_id = t.id), '{}') as labels
       from ticket_external_refs r join tickets t on t.id = r.ticket_id where r.external_id = $1`,
    [externalId],
  );
  return rows[0] as Row;
}
const updatedEvents = async (since: number): Promise<Row[]> => q("select subject_id, payload from activity_events where kind = 'ticket.updated' order by occurred_at, id offset $1", [since]);
const eventCount = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]!["n"] as number;
const labelId = async (name: string): Promise<string> => (await q("select id::text from project_labels where project_id = $1::uuid and name = $2", [open(), name]))[0]!["id"] as string;
async function changeLabels(externalId: string, change: { add?: unknown[]; remove?: string[] }): Promise<void> {
  const res = await h.call("POST", `/api/tickets/${await ticketOf(externalId)}/labels`, as("admin"), change);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Depois da rodada com a opção, uma sincronização normal não muda nada, não gera evento e não conta "mantidos". */
async function expectQuietNormalSync(): Promise<void> {
  const before = await eventCount();
  const normal = await sync();
  expect(normal.overwrite).toBe(false);
  expect(normal.counts).toMatchObject({ updated: 0, keptTouched: 0, keptMoved: 0, overwritten: 0, labelsAdded: 0, labelsRemoved: 0, parentsLinked: 0 });
  expect(await updatedEvents(before)).toEqual([]);
}

describe("abrir a rodada com a opção", () => {
  it("primeira importação com a opção: recusada com código próprio, sem abrir nada", async () => {
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: base().team });
    const res = await post("", { overwrite: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_overwrite_first_import");
    expect(await q("select id from external_import_runs")).toEqual([]);
  });

  it("a opção fica gravada e volta na rodada; sem ela, `overwrite: false`", async () => {
    await firstImport();
    const plain = await begin();
    expect(plain).toMatchObject({ mode: "reimport", overwrite: false });
    const done = await finish(plain);
    expect(done.overwrite).toBe(false);
    const chosen = await begin({ overwrite: true });
    expect(chosen).toMatchObject({ mode: "reimport", overwrite: true });
    expect((await q("select overwrite from external_import_runs where id = $1::uuid", [chosen.id]))[0]).toEqual({ overwrite: true });
    const current = await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"));
    expect(current.body.run).toMatchObject({ id: chosen.id, overwrite: true });
    expect((await finish(chosen)).overwrite).toBe(true);
  });

  it("rodada aberta com a outra opção: recusa com `linear_run_open_other_mode` e a aberta não muda; a mesma opção: `linear_run_open` de sempre", async () => {
    await firstImport();
    const normal = await begin();
    const other = await post("", { overwrite: true });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("linear_run_open_other_mode");
    expect((await q("select overwrite, phase from external_import_runs where id = $1::uuid", [normal.id]))[0]).toEqual({ overwrite: false, phase: "projects" });
    const same = await post("", {});
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("linear_run_open");
    const sameFalse = await post("", { overwrite: false });
    expect(sameFalse.body.error.code).toBe("linear_run_open");
    await finish(normal);

    const forced = await begin({ overwrite: true });
    const plain = await post("", {});
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe("linear_run_open_other_mode");
    expect((await post("", { overwrite: true })).body.error.code).toBe("linear_run_open");
    expect((await q("select overwrite from external_import_runs where id = $1::uuid", [forced.id]))[0]).toEqual({ overwrite: true });
  });

  it("`overwrite` que não é booleano: 400", async () => {
    await firstImport();
    const res = await post("", { overwrite: "sim" });
    expect(res.status).toBe(400);
  });
});

describe("item 1: cada campo mexido aqui, sem mudança no Linear, volta a ser o do Linear", () => {
  it("título", async () => {
    await firstImport();
    const id = await ticketOf("t");
    await patch(id, { title: "Título daqui" });
    const before = await eventCount();
    const run = await overwrite();
    const row = await ticket("t");
    expect(row["title"]).toBe("Título do Linear");
    expect((row["applied_snapshot"] as Row)["title"]).toBe("Título do Linear");
    expect(run.counts).toMatchObject({ overwritten: 1, keptTouched: 0, updated: 1 });
    const events = await updatedEvents(before);
    expect(events).toHaveLength(1);
    expect(events[0]!["payload"]).toMatchObject({ fields: ["title"], title: { from: "Título daqui", to: "Título do Linear" }, automatic: true, source: "linear_reimport", runId: run.id });
    await expectQuietNormalSync();
  });

  it("descrição", async () => {
    await firstImport();
    await patch(await ticketOf("d"), { description: "Texto daqui" });
    const before = await eventCount();
    const run = await overwrite();
    const row = await ticket("d");
    expect(row["description"]).toBe("Texto do Linear");
    expect((row["applied_snapshot"] as Row)["description"]).toBe("Texto do Linear");
    expect(run.counts).toMatchObject({ overwritten: 1, keptTouched: 0 });
    const events = await updatedEvents(before);
    expect(events).toHaveLength(1);
    expect((events[0]!["payload"] as Row)["fields"]).toEqual(["description"]);
    await expectQuietNormalSync();
  });

  it("prioridade", async () => {
    await firstImport();
    const linear = (await ticket("p"))["priority"];
    await patch(await ticketOf("p"), { priority: 50 });
    const before = await eventCount();
    const run = await overwrite();
    expect((await ticket("p"))["priority"]).toBe(linear);
    expect(run.counts).toMatchObject({ overwritten: 1 });
    expect((await updatedEvents(before))[0]!["payload"]).toMatchObject({ fields: ["priority"], priority: { from: 50, to: linear } });
    await expectQuietNormalSync();
  });

  it("prazo (inclusive tirado aqui)", async () => {
    await firstImport();
    await patch(await ticketOf("due"), { dueDate: "2027-05-05" });
    await patch(await ticketOf("t"), { dueDate: "2027-06-06" }); // o Linear não tem prazo nesta: volta a nenhum
    const before = await eventCount();
    const run = await overwrite();
    expect((await ticket("due"))["due_date"]).toBe("2026-12-01");
    expect((await ticket("t"))["due_date"]).toBeNull();
    expect(run.counts).toMatchObject({ overwritten: 2 });
    const payloads = (await updatedEvents(before)).map((event) => event["payload"] as Row);
    expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ dueDate: { from: "2027-05-05", to: "2026-12-01" } }), expect.objectContaining({ dueDate: { from: "2027-06-06", to: null } })]));
    await expectQuietNormalSync();
  });

  it("situação ('em revisão' daqui volta para 'em andamento')", async () => {
    await firstImport();
    await patch(await ticketOf("s"), { status: "in_review" });
    await patch(await ticketOf("t"), { status: "done" });
    const before = await eventCount();
    const run = await overwrite();
    expect((await ticket("s"))["status"]).toBe("in_progress");
    expect((await ticket("t"))["status"]).toBe("todo");
    expect((await ticket("s"))["status_pending"]).toBe(false);
    expect(((await ticket("s"))["applied_snapshot"] as Row)["status"]).toBe("in_progress");
    expect(run.counts).toMatchObject({ overwritten: 2, keptTouched: 0 });
    const payloads = (await updatedEvents(before)).map((event) => event["payload"] as Row);
    expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ fields: ["status"], status: { from: "in_review", to: "in_progress" } }), expect.objectContaining({ status: { from: "done", to: "todo" } })]));
    await expectQuietNormalSync();
  });

  it("responsável", async () => {
    await firstImport();
    const id = await ticketOf("asg");
    expect((await h.call("PUT", `/api/tickets/${id}/assignees/${people().manager}`, as("admin"))).status).toBeLessThan(300);
    expect((await h.call("DELETE", `/api/tickets/${id}/assignees/${people().admin}`, as("admin"))).status).toBeLessThan(300);
    const before = await eventCount();
    const run = await overwrite();
    expect((await ticket("asg"))["assignees"]).toEqual([people().admin]);
    expect(run.counts).toMatchObject({ overwritten: 1 });
    expect((await updatedEvents(before))[0]!["payload"]).toMatchObject({ fields: ["assignees"], assignees: { from: [people().manager], to: [people().admin] } });
    await expectQuietNormalSync();
  });

  it("pai (issue com pai no Linear, movida aqui, volta)", async () => {
    await firstImport();
    const p1 = await ticketOf("p1");
    const p2 = await ticketOf("p2");
    await patch(await ticketOf("par"), { parentId: p2 });
    const before = await eventCount();
    const run = await overwrite();
    expect((await ticket("par"))["parent_id"]).toBe(p1);
    expect(((await ticket("par"))["applied_snapshot"] as Row)["parentId"]).toBe(p1);
    expect(run.counts).toMatchObject({ overwritten: 1, keptMoved: 0 });
    expect((await updatedEvents(before)).map((event) => event["payload"])).toEqual([expect.objectContaining({ fields: ["parentId"], parentId: { from: p2, to: p1 } })]);
    await expectQuietNormalSync();
  });

  it("issue em projeto do Linear, movida aqui, volta para o ticket do projeto", async () => {
    await firstImport();
    const project = await ticketOf("lp1");
    await patch(await ticketOf("t"), { parentId: await ticketOf("p2") });
    await overwrite();
    expect((await ticket("t"))["parent_id"]).toBe(project);
    await expectQuietNormalSync();
  });

  it("etiquetas: a do Linear tirada aqui volta; a daqui (sem origem no Linear) fica", async () => {
    await firstImport();
    expect((await ticket("lab"))["labels"]).toEqual(["Bug", "Front"]);
    await changeLabels("lab", { remove: [await labelId("Bug")], add: [{ name: "Daqui" }] });
    const marked = await q("select removed_here_at from external_item_refs where kind = 'label' and external_id = 'lab:lab-1'");
    expect(marked[0]!["removed_here_at"]).not.toBeNull();
    // Uma sincronização normal respeita a remoção.
    expect((await sync()).counts).toMatchObject({ labelsAdded: 0 });
    expect((await ticket("lab"))["labels"]).toEqual(["Daqui", "Front"]);
    const run = await overwrite();
    expect((await ticket("lab"))["labels"]).toEqual(["Bug", "Daqui", "Front"]);
    expect(run.counts).toMatchObject({ overwritten: 1, labelsAdded: 1, labelsRemoved: 0 });
    const ref = await q("select removed_here_at, local_id from external_item_refs where kind = 'label' and external_id = 'lab:lab-1'");
    expect(ref[0]).toEqual({ removed_here_at: null, local_id: await labelId("Bug") });
    await expectQuietNormalSync();
  });

  it("etiquetas: a que saiu no Linear sai, mesmo a que já estava aqui quando o Linear a trouxe (adotada)", async () => {
    const world = await firstImport();
    // "Bug" posta aqui num ticket que o Linear depois marca com Bug: a origem a adota.
    await changeLabels("t", { add: [{ labelId: await labelId("Bug") }] });
    issue(world, "t").labels = [L1];
    await sync();
    expect((await q("select applied from external_item_refs where kind = 'label' and external_id = 't:lab-1'"))[0]!["applied"]).toEqual({ adopted: true });
    // Sai no Linear: a regra de sempre manteria (era daqui); com a opção, sai.
    issue(world, "t").labels = [];
    const run = await overwrite();
    expect((await ticket("t"))["labels"]).toEqual([]);
    expect(run.counts).toMatchObject({ overwritten: 1, labelsRemoved: 1 });
    await expectQuietNormalSync();
  });
});

describe("item 2: mantido numa sincronização normal em que o Linear mudou, depois a opção", () => {
  it("o retrato de origem já avançou: com a opção vale o do Linear", async () => {
    const world = await firstImport();
    await patch(await ticketOf("t"), { title: "Daqui" });
    issue(world, "t").title = "Linear novo";
    const normal = await sync();
    expect(normal.counts).toMatchObject({ keptTouched: 1 });
    expect((await ticket("t"))["title"]).toBe("Daqui");
    expect(((await ticket("t"))["source_snapshot"] as Row)["title"]).toBe("Linear novo");
    const run = await overwrite();
    expect((await ticket("t"))["title"]).toBe("Linear novo");
    expect(run.counts).toMatchObject({ overwritten: 1, keptTouched: 0 });
    await expectQuietNormalSync();
  });
});

describe("item 3: campo mantido daqui pela regra do campo sem retrato", () => {
  it("é sobrescrito e a marca sai", async () => {
    await firstImport();
    // Simula a origem de antes do prazo (ADR 0064): sem a chave nos retratos, e um prazo posto aqui.
    await q("update ticket_external_refs set source_snapshot = source_snapshot - 'dueDate', applied_snapshot = applied_snapshot - 'dueDate' where external_id = 'due'");
    await patch(await ticketOf("due"), { dueDate: "2027-01-01" });
    const normal = await sync();
    expect(normal.counts).toMatchObject({ keptTouched: 1 });
    expect(((await ticket("due"))["applied_snapshot"] as Row)["heldHere"]).toEqual(["dueDate"]);
    expect((await ticket("due"))["due_date"]).toBe("2027-01-01");
    const run = await overwrite();
    expect((await ticket("due"))["due_date"]).toBe("2026-12-01");
    expect(((await ticket("due"))["applied_snapshot"] as Row)["heldHere"]).toEqual([]);
    expect(run.counts).toMatchObject({ overwritten: 1, keptTouched: 0 });
    await expectQuietNormalSync();
  });
});

describe("item 4: depois da opção, a sincronização normal", () => {
  it("tudo mexido de uma vez: depois, zero mudanças; uma mudança posterior no Linear é aplicada normalmente", async () => {
    const world = await firstImport();
    await patch(await ticketOf("t"), { title: "Daqui", status: "in_review", priority: 50, dueDate: "2027-02-02", description: "Daqui também" });
    await patch(await ticketOf("par"), { parentId: await ticketOf("p2") });
    await changeLabels("lab", { remove: [await labelId("Front")] });
    const run = await overwrite();
    expect(run.counts).toMatchObject({ overwritten: 3, keptTouched: 0 });
    await expectQuietNormalSync();
    issue(world, "t").title = "De novo no Linear";
    issue(world, "t").state = "completed";
    const next = await sync();
    expect((await ticket("t"))["title"]).toBe("De novo no Linear");
    expect((await ticket("t"))["status"]).toBe("done");
    expect(next.counts).toMatchObject({ updated: 1, keptTouched: 0, overwritten: 0 });
  });
});

describe("item 5: responsável", () => {
  it("o Linear tem responsável que não casa: os daqui ficam", async () => {
    const world = await firstImport();
    expect((await h.call("PUT", `/api/tickets/${await ticketOf("asg")}/assignees/${people().manager}`, as("admin"))).status).toBeLessThan(300);
    issue(world, "asg").assignee = { id: "u-ninguem", email: "ninguem@fora.test" };
    const run = await overwrite();
    expect(((await ticket("asg"))["assignees"] as string[]).sort()).toEqual([people().admin, people().manager].sort());
    expect(run.counts).toMatchObject({ overwritten: 0 });
  });

  it("e-mail ilegível no Linear: os daqui ficam", async () => {
    const world = await firstImport();
    await h.call("PUT", `/api/tickets/${await ticketOf("asg")}/assignees/${people().manager}`, as("admin"));
    issue(world, "asg").assignee = { id: "u-admin", email: null as unknown as string };
    await overwrite();
    expect(((await ticket("asg"))["assignees"] as string[]).sort()).toEqual([people().admin, people().manager].sort());
  });

  it("issue sem responsável no Linear: esvazia", async () => {
    await firstImport();
    await h.call("PUT", `/api/tickets/${await ticketOf("t")}/assignees/${people().manager}`, as("admin"));
    const run = await overwrite();
    expect((await ticket("t"))["assignees"]).toEqual([]);
    expect(run.counts).toMatchObject({ overwritten: 1 });
    await expectQuietNormalSync();
  });
});

describe("item 6: pai", () => {
  it("issue sem pai e sem projeto no Linear, movida aqui: não se move (nem para o destino, nem para a raiz)", async () => {
    await firstImport();
    const p2 = await ticketOf("p2");
    await patch(await ticketOf("loose"), { parentId: p2 });
    const run = await overwrite();
    expect((await ticket("loose"))["parent_id"]).toBe(p2);
    expect(run.counts).toMatchObject({ overwritten: 0, parentsLinked: 0 });
    await expectQuietNormalSync();
  });

  it("ciclo de verdade: a volta é pulada (skipped) e a rodada termina", async () => {
    const world = base();
    // q1 solta no Linear; q2 filha de q1 no Linear. Aqui q2 vai à raiz e q1 para baixo de q2: q1 (solta lá) não se move, e a volta de q2
    // para baixo de q1 criaria ciclo → pulada.
    world.list.push({ id: "q1", identifier: "ENG-20", title: "Q1" }, { id: "q2", identifier: "ENG-21", title: "Q2", parent: "q1" });
    await firstImport(world);
    const q1 = await ticketOf("q1");
    const q2 = await ticketOf("q2");
    await patch(q2, { parentId: null });
    await patch(q1, { parentId: q2 });
    const run = await overwrite();
    expect(run.phase).toBe("done");
    expect((await ticket("q1"))["parent_id"]).toBe(q2);
    expect((await ticket("q2"))["parent_id"]).toBeNull();
    expect(Number(run.counts!["skipped"])).toBeGreaterThanOrEqual(1);
  });
});

describe("item 7: concluído no Linear com filho aberto aqui", () => {
  it("a regra da árvore vence, sem vaivém em rodadas seguidas", async () => {
    const world = await firstImport();
    const s = await ticketOf("s");
    const child = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Filho daqui", parentId: s })).body.id as string;
    await patch(s, { status: "in_review" });
    issue(world, "s").state = "completed";
    const run = await overwrite();
    expect((await ticket("s"))["status"]).toBe("in_review");
    expect(run.counts).toMatchObject({ overwritten: 0 });
    const before = await eventCount();
    for (let i = 0; i < 2; i += 1) {
      const again = await sync();
      expect(again.counts).toMatchObject({ updated: 0, keptTouched: 0 });
    }
    expect(await updatedEvents(before)).toEqual([]);
    expect((await ticket("s"))["status"]).toBe("in_review");
    // O filho fecha: a próxima sincronização normal conclui (o ticket deixou de ser "mexido aqui").
    await patch(child, { status: "done" });
    await sync();
    expect((await ticket("s"))["status"]).toBe("done");
  });
});

describe("item 8: o que a opção não toca", () => {
  it("ticket criado aqui, comentário editado aqui, relação removida aqui e origem `missing` ficam como estão", async () => {
    const world = await firstImport();
    const mine = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Criado aqui", description: "Meu" })).body.id as string;
    const comment = (await q("select c.id from ticket_comments c join external_item_refs r on r.local_id = c.id where r.external_id = 'c-1'"))[0]!["id"] as string;
    // Como em `linear-comments.test.ts`: a edição local de um comentário de outro autor, direto no banco.
    await q("update ticket_comments set body = 'Editado aqui', edited_at = now() where id = $1::uuid", [comment]);
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("rel-a")}/related/${await ticketOf("rel-b")}`, as("admin"))).status).toBe(204);
    // A issue `d` some do Linear (origem `missing`) e é mexida aqui.
    world.list.splice(world.list.findIndex((item) => item.id === "d"), 1);
    await sync();
    await patch(await ticketOf("d"), { title: "Sumida e mexida" });
    await overwrite();
    expect((await q("select title, description from tickets where id = $1::uuid", [mine]))[0]).toEqual({ title: "Criado aqui", description: "Meu" });
    expect((await q("select body from ticket_comments where id = $1::uuid", [comment]))[0]!["body"]).toBe("Editado aqui");
    expect(await q("select id from ticket_relations where kind = 'related'")).toEqual([]);
    expect((await ticket("d"))["title"]).toBe("Sumida e mexida");
  });
});

describe("item 10: passo repetido e duas abas", () => {
  it("idempotente: `overwritten` não conta duas vezes", async () => {
    await firstImport();
    await patch(await ticketOf("t"), { title: "Daqui", status: "in_review" });
    await patch(await ticketOf("par"), { parentId: await ticketOf("p2") });
    await changeLabels("lab", { remove: [await labelId("Bug")] });
    const opened = await begin({ overwrite: true });
    let last: RunBody = opened;
    for (let i = 0; i < 200 && last.done !== true; i += 1) {
      const pair = await Promise.all([post(`/${opened.id}/step`), post(`/${opened.id}/step`)]);
      for (const res of pair) expect([200, 409], JSON.stringify(res.body)).toContain(res.status);
      const ok = pair.filter((res) => res.status === 200).map((res) => res.body as RunBody);
      last = ok.find((body) => body.done === true) ?? ok[ok.length - 1] ?? last;
    }
    expect(last.done).toBe(true);
    expect(last.counts).toMatchObject({ overwritten: 3, keptTouched: 0 });
    expect((await ticket("t"))["title"]).toBe("Título do Linear");
    await expectQuietNormalSync();
  });
});

describe("item 11: privacidade", () => {
  afterEach(() => vi.restoreAllMocks());
  it("nenhum valor sobrescrito (título, descrição, nome) aparece em log; nenhum pedido a provedor de IA nasce da opção", async () => {
    const SENT = { linearTitle: "Sentinela-Titulo-Linear-91x", linearText: "Sentinela-Texto-Linear-91x", hereTitle: "Sentinela-Titulo-Daqui-91x", hereText: "Sentinela-Texto-Daqui-91x" };
    const world = base();
    Object.assign(issue(world, "t"), { title: SENT.linearTitle, description: SENT.linearText });
    await firstImport(world);
    await patch(await ticketOf("t"), { title: SENT.hereTitle, description: SENT.hereText });
    const providers = () => [h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, h.conversation().calls, h.summarizer().calls, h.writer().calls, h.chat().calls, h.elaborator().calls, h.embedder().calls].map((calls) => calls.length);
    const before = providers();
    const lines: string[] = [];
    for (const method of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (lines.push(String(chunk)), true)) as never);
    const run = await overwrite();
    vi.restoreAllMocks();
    expect(run.counts).toMatchObject({ overwritten: 1 });
    expect((await ticket("t"))["title"]).toBe(SENT.linearTitle);
    const logged = lines.join("\n");
    for (const value of [...Object.values(SENT), "Xis", "admin@exemplo.test"]) expect(logged, value).not.toContain(value);
    expect(providers()).toEqual(before);
  });
});
