import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeLabel, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// ADR 0066, correções da revisão LV1 (BRIEF-LV2). `fetch` falso: nada chama o Linear nem provedor de IA.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; mode?: string; overwrite?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
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
type World = { team: FakeTeamData; list: FakeIssue[] };
function base(extra: FakeIssue[] = []): World {
  const list: FakeIssue[] = [
    { id: "p1", identifier: "ENG-1", title: "Pai um", project: "lp1" },
    { id: "p2", identifier: "ENG-2", title: "Pai dois", project: "lp1" },
    { id: "t", identifier: "ENG-3", title: "Título do Linear", dueDate: null, project: "lp1" },
    { id: "d", identifier: "ENG-4", title: "Descrição", description: "Texto do Linear", project: "lp1" },
    { id: "s", identifier: "ENG-7", title: "Situação", state: "started", project: "lp1" },
    { id: "asg", identifier: "ENG-8", title: "Responsável", assignee: { id: "u-admin", email: "admin@exemplo.test" }, project: "lp1" },
    { id: "par", identifier: "ENG-9", title: "Com pai", parent: "p1" },
    { id: "par2", identifier: "ENG-14", title: "Com pai, quieta", parent: "p1" },
    { id: "loose", identifier: "ENG-10", title: "Solta" },
    { id: "lab", identifier: "ENG-11", title: "Etiquetas", labels: [L1], project: "lp1" },
    ...extra,
  ];
  return { list, team: { projects: [{ id: "lp1", name: "Alfa" }], issues: list, comments: [], relations: [] } };
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
    `select t.id, t.number, t.title, t.description, t.priority, t.status, t.parent_id, r.source_snapshot, r.applied_snapshot, r.status_pending, r.hierarchy_pending, r.status_run_flags,
            coalesce((select array_agg(a.person_id::text order by a.person_id) from ticket_assignees a where a.ticket_id = t.id), '{}') as assignees
       from ticket_external_refs r join tickets t on t.id = r.ticket_id where r.external_id = $1`,
    [externalId],
  );
  return rows[0] as Row;
}
const events = async (since: number): Promise<Row[]> => q("select subject_id, kind, payload from activity_events where kind in ('ticket.updated','ticket.labels_changed') order by occurred_at, id offset $1", [since]);
const eventCount = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind in ('ticket.updated','ticket.labels_changed')"))[0]!["n"] as number;
const nonZero = (counts: RunBody["counts"]): Record<string, unknown> => Object.fromEntries(Object.entries(counts ?? {}).filter(([, v]) => v !== 0 && v !== false));


/** Uma rodada com a opção até chegar a `phase` (as anteriores completas) e abandonada ali. */
async function abandonOverwriteAt(phase: string): Promise<void> {
  const opened = await begin({ overwrite: true });
  let last: RunBody = opened;
  for (let i = 0; i < 100 && last.phase !== phase && last.done !== true; i += 1) last = (await post(`/${opened.id}/step`)).body;
  expect(last.phase, `chegou a ${phase}`).toBe(phase);
  const res = await post(`/${opened.id}/abandon`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

describe("item 1: rodada de sobrescrita abandonada não muda a rodada normal seguinte", () => {
  for (const phase of ["issues", "hierarchy", "statuses", "mentions", "comments", "missing"]) {
    it(`abandonada ao chegar em \`${phase}\`: a normal seguinte dá o mesmo que o controle, sem evento, e nada da opção sobra na origem`, async () => {
      await firstImport();
      const p2 = await ticketOf("p2");
      await patch(await ticketOf("par"), { parentId: p2 });
      await patch(await ticketOf("s"), { status: "in_review" });
      // Controle: a normal com `par` movida aqui, `s` mexida aqui e o Linear sem mudança.
      const control = await sync();
      const marks = async () => q("select external_id, hierarchy_pending, status_pending from ticket_external_refs order by external_id");
      const marksBefore = await marks();
      await abandonOverwriteAt(phase);
      const positions = { par: (await ticket("par"))["parent_id"], s: (await ticket("s"))["status"] };
      // As marcas que uma rodada normal lê ficam como estavam (a opção só grava o que vale para a própria rodada).
      expect(await marks()).toEqual(marksBefore);
      const before = await eventCount();
      const normal = await sync();
      expect(nonZero(normal.counts)).toEqual(nonZero(control.counts));
      expect(await events(before)).toEqual([]);
      expect({ par: (await ticket("par"))["parent_id"], s: (await ticket("s"))["status"] }).toEqual(positions);
    });
  }
});

describe("item 2: convergência na hierarquia", () => {
  for (const order of ["filho-primeiro", "pai-primeiro"] as const) {
    it(`G > P > C no Linear; aqui C na raiz e P embaixo de C (${order}): UMA rodada converge`, async () => {
      const g: FakeIssue = { id: "g", identifier: "ENG-30", title: "G" };
      const p: FakeIssue = { id: "pp", identifier: "ENG-31", title: "P", parent: "g" };
      const c: FakeIssue = { id: "cc", identifier: "ENG-32", title: "C", parent: "pp" };
      await firstImport(base(order === "filho-primeiro" ? [c, g, p] : [g, p, c]));
      const G = await ticketOf("g");
      const P = await ticketOf("pp");
      const C = await ticketOf("cc");
      await patch(C, { parentId: null });
      await patch(P, { parentId: C });
      const first = await overwrite();
      expect({ P: (await ticket("pp"))["parent_id"], C: (await ticket("cc"))["parent_id"] }).toEqual({ P: G, C: P });
      expect(first.counts).toMatchObject({ overwritten: 2, skipped: 0 });
      const before = await eventCount();
      const second = await overwrite();
      expect(second.counts).toMatchObject({ overwritten: 0, parentsLinked: 0, updated: 0 });
      expect(await events(before)).toEqual([]);
    });
  }

  it("duas rodadas com a opção seguidas: a segunda dá zero mudanças e zero eventos", async () => {
    const world = await firstImport();
    await patch(await ticketOf("t"), { title: "Daqui", status: "in_review", priority: 50, dueDate: "2027-02-02", description: "Daqui também" });
    await patch(await ticketOf("par"), { parentId: await ticketOf("p2") });
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("asg")}/assignees/${h.world().people.admin}`, as("admin"))).status).toBeLessThan(300);
    issue(world, "s").title = "Mudou no Linear";
    await overwrite();
    const before = await eventCount();
    const second = await overwrite();
    expect(await events(before)).toEqual([]);
    expect(second.counts).toMatchObject({ overwritten: 0, updated: 0, parentsLinked: 0, keptTouched: 0, keptMoved: 0 });
    const beforeNormal = await eventCount();
    await sync();
    expect(await events(beforeNormal)).toEqual([]);
  });

  it("pai do Linear dentro de ideia (não corrigido, TREEPM a registrar): sem laço infinito — a segunda move, a terceira dá zero", async () => {
    await firstImport();
    const p2 = await ticketOf("p2");
    await patch(await ticketOf("par"), { parentId: p2, status: "in_progress" });
    await patch(await ticketOf("par2"), { parentId: p2 });
    expect((await h.call("POST", `/api/tickets/${await ticketOf("p1")}/idea`, as("admin"))).status).toBeLessThan(300);
    await overwrite();
    await overwrite();
    const before = await eventCount();
    const third = await overwrite();
    expect(await events(before)).toEqual([]);
    expect(third.counts).toMatchObject({ overwritten: 0, parentsLinked: 0, updated: 0 });
  });
});

describe("item 3: descrição sobrescrita e menções", () => {
  it("a menção nascida do texto daqui sai; a descrição do Linear que cita outra issue continua virando a menção de sempre", async () => {
    const key = (await q("select key from projects where id = $1::uuid", [open()]))[0]!["key"] as string;
    const world = base();
    world.list.push({ id: "cita", identifier: "ENG-40", title: "Cita", description: `Depende de ${key}-1`, project: "lp1" });
    await firstImport(world);
    const mentionsOf = async (externalId: string) => q("select to_ticket_id from ticket_relations where kind = 'mentions' and from_ticket_id = $1::uuid", [await ticketOf(externalId)]);
    const citesBefore = await mentionsOf("cita");
    const target = await ticket("t");
    await patch(await ticketOf("d"), { description: `Ver ${key}-${String(target["number"])} antes` });
    await patch(await ticketOf("cita"), { title: "Mexida aqui" });
    expect(await mentionsOf("d")).toHaveLength(1);
    await overwrite();
    expect((await ticket("d"))["description"]).toBe("Texto do Linear");
    expect(await mentionsOf("d")).toEqual([]);
    expect(await mentionsOf("cita")).toEqual(citesBefore);
  });
});

describe("item 6: responsável que não casa", () => {
  it("ticket NÃO mexido aqui: a opção faz o que a normal faz (esvazia), e nada fica para trás", async () => {
    const world = await firstImport();
    issue(world, "asg").assignee = { id: "u-z", email: "ninguem@fora.test" };
    await overwrite();
    expect((await ticket("asg"))["assignees"]).toEqual([]);
    expect(((await ticket("asg"))["source_snapshot"] as Row)["assigneeExternalId"]).toBe("u-z");
  });

  it("ticket mexido aqui: os daqui ficam e o retrato de origem não avança; com o e-mail legível depois, a opção aplica", async () => {
    const world = await firstImport();
    const people = h.world().people;
    expect((await h.call("PUT", `/api/tickets/${await ticketOf("asg")}/assignees/${people.manager}`, as("admin"))).status).toBeLessThan(300);
    issue(world, "asg").assignee = { id: "u-manager", email: null as unknown as string };
    await overwrite();
    expect(((await ticket("asg"))["assignees"] as string[]).sort()).toEqual([people.admin, people.manager].sort());
    expect(((await ticket("asg"))["source_snapshot"] as Row)["assigneeExternalId"]).toBe("u-admin");
    issue(world, "asg").assignee = { id: "u-manager", email: "manager@exemplo.test" };
    await overwrite();
    expect((await ticket("asg"))["assignees"]).toEqual([people.manager]);
  });
});

describe("item 7: marcas e contagens", () => {
  it("só a situação sobrescrita: conta uma vez (`updated` 1, `unchanged` sem ela, `overwritten` 1) e a marca de sobrescrito fica na origem", async () => {
    await firstImport();
    await patch(await ticketOf("s"), { status: "in_review" });
    const control = await sync();
    const run = await overwrite();
    expect(run.counts).toMatchObject({ overwritten: 1, updated: 1, unchanged: Number(control.counts!["unchanged"]) - 1 });
    const row = await q("select status_run_flags from ticket_external_refs where external_id = 's'");
    expect(Number(row[0]!["status_run_flags"]) & 16).toBe(16);
  });
});
