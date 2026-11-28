import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// L10: reimportação sem duplicar (ADR 0060, seção 5; TREEPM-424). `fetch` falso: nada chama o Linear nem provedor de IA.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; mode?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}, who: Parameters<typeof as>[0] = "admin") => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const patch = (id: unknown, body: unknown) => h.call("PATCH", `/api/tickets/${String(id)}`, as("admin"), body);

async function finish(run: RunBody, max = 120): Promise<RunBody> {
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
const runAll = async (body: unknown = {}): Promise<RunBody> => finish(await begin(body));
const byExt = async (): Promise<Map<string, Row>> =>
  new Map(
    (
      await q(
        `select r.external_id, r.external_key, r.external_url, r.missing_since, r.last_seen_run_id, r.hierarchy_pending, r.source_snapshot, r.applied_snapshot, t.id, t.number, t.title, t.status, t.priority, t.parent_id, t.description,
                coalesce((select array_agg(a.person_id::text order by a.person_id) from ticket_assignees a where a.ticket_id = t.id), '{}') as assignees
           from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid`,
        [open()],
      )
    ).map((row) => [row["external_id"] as string, row]),
  );
const events = async (kind = "ticket.updated") => q("select subject_id, payload from activity_events where kind = $1 order by occurred_at, id", [kind]);

type World = { data: Record<string, FakeTeamData>; list: FakeIssue[] };
const base = (): World => {
  const list: FakeIssue[] = [
    { id: "p1", identifier: "ENG-1", title: "Pai um", project: "lp1" },
    { id: "p2", identifier: "ENG-2", title: "Pai dois", project: "lp1" },
    { id: "a", identifier: "ENG-3", title: "Título A", project: "lp1" },
    { id: "b", identifier: "ENG-4", title: "Título B", description: "Descrição B", project: "lp1" },
    { id: "c", identifier: "ENG-5", title: "Título C", state: "unstarted", project: "lp1" },
    { id: "d", identifier: "ENG-6", title: "Título D", assignee: { id: "u-admin", email: "admin@exemplo.test" }, project: "lp1" },
    { id: "e", identifier: "ENG-7", title: "Título E", priority: 0, project: "lp1" },
    { id: "f", identifier: "ENG-8", title: "Título F", project: "lp1" },
    { id: "h", identifier: "ENG-9", title: "Título H", parent: "p1" },
    { id: "i", identifier: "ENG-10", title: "Título I", project: "lp1" },
  ];
  return { list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }], issues: list } } };
};
const removeFromTeam = (world: World, id: string): void => void world.list.splice(world.list.findIndex((issue) => issue.id === id), 1);
const issue = (world: World, id: string): FakeIssue => world.list.find((item) => item.id === id) as FakeIssue;

async function firstImport(world: World = base()): Promise<{ world: World; first: RunBody }> {
  await linkWithData(h, put, open(), world.data);
  const first = await runAll();
  expect(first.counts).toMatchObject({ issuesCreated: world.list.length, projectsCreated: 1 });
  return { world, first };
}

describe("item 1: abrir a reimportação", () => {
  it("depois de uma rodada done, abre uma rodada reimport; antes disso é a primeira; uma aberta recusa", async () => {
    const { world } = await firstImport();
    expect(world).toBeDefined();
    const run = await begin();
    expect(run.mode).toBe("reimport");
    const again = await post("");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("linear_run_open");
    const last = await finish(run);
    expect(last.mode).toBe("reimport");
  });

  it("o destino é o da primeira importação concluída; null no corpo é a raiz; outro destino só vale para issue nova sem pai e sem projeto", async () => {
    const world = base();
    await linkWithData(h, put, open(), world.data);
    const dest = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    const first = await runAll({ destinationTicketId: dest });
    expect(first.destinationTicketId).toBe(dest);
    // Herda quando o corpo não traz destino.
    const inherited = await begin();
    expect(inherited.destinationTicketId).toBe(dest);
    await finish(inherited);
    // `null` explícito é a raiz do projeto.
    const root = await begin({ destinationTicketId: null });
    expect(root.destinationTicketId).toBeNull();
    world.list.push({ id: "loose", identifier: "ENG-11", title: "Solta" });
    const done = await finish(root);
    expect(done.counts).toMatchObject({ issuesCreated: 1 });
    expect((await byExt()).get("loose")!["parent_id"]).toBeNull();
    // Outro destino no corpo vale para a issue nova sem pai e sem projeto.
    world.list.push({ id: "loose2", identifier: "ENG-12", title: "Solta 2" }, { id: "withproj", identifier: "ENG-13", title: "Com projeto", project: "lp1" });
    const other = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Outro" })).body.id as string;
    await runAll({ destinationTicketId: other });
    const rows = await byExt();
    expect(rows.get("loose2")!["parent_id"]).toBe(other);
    expect(rows.get("withproj")!["parent_id"]).toBe(rows.get("lp1")?.["id"] ?? (await q("select ticket_id from ticket_external_refs where external_id = 'lp1'"))[0]!["ticket_id"]);
  });

  it("destino herdado que sumiu ou ficou dentro de ideia: recusa com linear_destination_invalid, sem cair na raiz", async () => {
    const world = base();
    await linkWithData(h, put, open(), world.data);
    const dest = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Destino" })).body.id as string;
    await runAll({ destinationTicketId: dest });
    await q("update tickets set parent_id = null where parent_id = $1::uuid", [dest]);
    await q("delete from tickets where id = $1::uuid", [dest]);
    const res = await post("");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_destination_invalid");
  });
});

describe("itens 2 a 5 e 7: o cenário completo, campo por campo", () => {
  it("aplica o que só o Linear mudou, mantém o que foi mexido aqui, marca os não encontrados e não repete sem mudança", async () => {
    const { world } = await firstImport();
    const before = await byExt();
    const peopleBefore = h.world().people;
    // ---- no Linear ----
    issue(world, "a").title = "Título A novo";
    issue(world, "b").description = "Descrição B nova";
    issue(world, "c").state = "started";
    issue(world, "d").assignee = { id: "u-manager", email: "manager@exemplo.test" };
    issue(world, "e").priority = 2;
    removeFromTeam(world, "f"); // arquivada
    removeFromTeam(world, "i"); // trocou de time: some deste
    issue(world, "h").parent = "p2";
    world.list.push({ id: "g", identifier: "ENG-11", title: "Nova G", project: "lp1" });
    // ---- no TreePM ----
    expect((await patch(before.get("a")!["id"], { title: "A editado aqui" })).status).toBe(200);
    expect((await patch(before.get("c")!["id"], { status: "done" })).status).toBe(200);
    expect((await patch(before.get("h")!["id"], { parentId: before.get("b")!["id"] })).status).toBe(200);
    const eventsBefore = (await events()).length;

    const second = await runAll();
    expect(second.mode).toBe("reimport");
    const rows = await byExt();
    const get = (id: string) => rows.get(id) as Row;

    // A: o título foi mexido aqui, fica; o retrato de origem avança, o aplicado não.
    expect(get("a")["title"]).toBe("A editado aqui");
    expect((get("a")["source_snapshot"] as Row)["title"]).toBe("Título A novo");
    expect((get("a")["applied_snapshot"] as Row)["title"]).toBe("Título A");
    // B: só o Linear mudou a descrição.
    expect(get("b")["description"]).toBe("Descrição B nova");
    expect((get("b")["applied_snapshot"] as Row)["description"]).toBe("Descrição B nova");
    expect((get("b")["source_snapshot"] as Row)["description"]).toBe("Descrição B nova");
    // C: concluído aqui, o Linear foi para "em andamento": fica concluído.
    expect(get("c")["status"]).toBe("done");
    expect((get("c")["source_snapshot"] as Row)["stateType"]).toBe("started");
    // D: o responsável mudou no Linear e ninguém mexeu aqui: refaz a correspondência por e-mail.
    expect(get("d")["assignees"]).toEqual([peopleBefore.manager]);
    expect((get("d")["applied_snapshot"] as Row)["assigneeIds"]).toEqual([peopleBefore.manager]);
    expect((get("d")["source_snapshot"] as Row)["assigneeExternalId"]).toBe("u-manager");
    // E: prioridade 2 → 300.
    expect(get("e")["priority"]).toBe(300);
    // F e I: não vistos: marcados, tickets intactos.
    for (const gone of ["f", "i"]) {
      expect(get(gone)["missing_since"], gone).not.toBeNull();
      expect(get(gone)["title"]).toBe(before.get(gone)!["title"]);
      expect(get(gone)["status"]).toBe(before.get(gone)!["status"]);
    }
    // G: criada, no lugar certo (sob o ticket do projeto do Linear), e nunca marcada como não encontrada.
    const projectTicket = (await q("select ticket_id from ticket_external_refs where external_id = 'lp1' and kind = 'project'"))[0]!["ticket_id"];
    expect(get("g")["parent_id"]).toBe(projectTicket);
    expect(get("g")["missing_since"]).toBeNull();
    // H: movida à mão: fica onde está (sob B), sem erro.
    expect(get("h")["parent_id"]).toBe(get("b")["id"]);
    // Identificador e endereço atuais; ninguém ficou pendente.
    expect(get("a")["external_key"]).toBe("ENG-3");
    for (const row of rows.values()) expect(row["hierarchy_pending"]).toBe(false);
    // Contagens.
    expect(second.counts).toMatchObject({ issuesCreated: 1, updated: 3, keptTouched: 2, keptMoved: 1, missing: 2, elsewhere: 0 });
    expect(second.counts!["unchanged"]).toBeGreaterThanOrEqual(3);
    // Eventos: UM por ticket atualizado, automático, vindo da reimportação do Linear; nada para os outros.
    const news = (await events()).slice(eventsBefore).filter((event) => (event["payload"] as Row)["source"] === "linear_reimport");
    expect(news.map((event) => event["subject_id"]).sort()).toEqual([get("b")["id"], get("d")["id"], get("e")["id"]].sort());
    for (const event of news) expect(event["payload"]).toMatchObject({ automatic: true, source: "linear_reimport", runId: second.id });
    // Nenhum e-mail do Linear foi gravado (nem na origem nem nos eventos).
    expect(JSON.stringify(await q("select source_snapshot, applied_snapshot from ticket_external_refs"))).not.toContain("exemplo.test");
    expect(JSON.stringify(await q("select payload from activity_events"))).not.toContain("manager@exemplo.test");

    // ---- de novo, sem mudança alguma: zero atualizações, zero eventos ----
    const countEvents = (await q("select count(*)::int n from activity_events"))[0]!["n"] as number;
    const third = await runAll();
    expect(third.counts).toMatchObject({ updated: 0, issuesCreated: 0 });
    const fourth = await runAll();
    expect(fourth.counts).toMatchObject({ updated: 0, issuesCreated: 0 });
    const newEvents = await q("select kind from activity_events order by occurred_at, id offset $1", [countEvents]);
    expect(newEvents.map((event) => event["kind"]).filter((kind) => kind === "ticket.updated")).toEqual([]);
    // F e I continuam marcadas, e a marca não anda (é "desde").
    const again = await byExt();
    expect(again.get("f")!["missing_since"]).toEqual(get("f")["missing_since"]);

    // ---- F reaparece: a marca zera ----
    world.list.push({ id: "f", identifier: "ENG-8", title: "Título F", project: "lp1" });
    const fifth = await runAll();
    expect(fifth.counts).toMatchObject({ missing: 1, issuesCreated: 0 });
    expect((await byExt()).get("f")!["missing_since"]).toBeNull();
    expect((await byExt()).get("i")!["missing_since"]).not.toBeNull();
    // Nada duplicado.
    expect((await q("select count(*)::int n, count(distinct (kind, external_id))::int d from ticket_external_refs"))[0]).toMatchObject({ n: 12, d: 12 });
  });
});

describe("item 5 e 6: não encontradas, detalhe, contagem e dados da tela", () => {
  it("o detalhe do ticket traz missingSince; a tela dos times traz lastImportedAt; current traz lastFinished", async () => {
    const { world } = await firstImport();
    removeFromTeam(world, "f");
    await runAll();
    const rows = await byExt();
    const detail = await h.call("GET", `/api/tickets/${rows.get("f")!["id"]}`, as("admin"));
    expect(detail.body.externalSource.missingSince).toEqual(expect.any(String));
    expect((await h.call("GET", `/api/tickets/${rows.get("a")!["id"]}`, as("admin"))).body.externalSource.missingSince).toBeNull();
    const teams = await h.call("GET", "/api/linear/teams", as("admin"));
    expect(teams.status, JSON.stringify(teams.body)).toBe(200);
    const eng = (teams.body as { id: string; lastImportedAt: string | null }[]).find((team) => team.id === TEAM_ENG.id);
    expect(eng?.lastImportedAt).toEqual(expect.any(String));
    const cur = await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"));
    expect(cur.body.lastFinished).toMatchObject({ mode: "reimport", phase: "done" });
  });

  it("GET …/linear/preview traz a contagem do time; o Linear fora do ar ou limitando vira null (nunca 5xx); sem permissão de importar, 403", async () => {
    await firstImport();
    const ok = await h.call("GET", `/api/projects/${open()}/linear/preview`, as("admin"));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ issueCount: 10 });
    expect((await h.call("GET", `/api/projects/${open()}/linear/preview`, as("reader"))).status).toBe(403);
    h.linear().use(() => ({ status: 503, body: {} }));
    const down = await h.call("GET", `/api/projects/${open()}/linear/preview`, as("admin"));
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    expect(down.body).toEqual({ issueCount: null });
    h.linear().use(() => ({ status: 429, headers: { "Retry-After": "7" }, body: {} }));
    expect((await h.call("GET", `/api/projects/${open()}/linear/preview`, as("admin"))).body).toEqual({ issueCount: null });
  });

  it("rodada de reimportação abandonada no meio não marca nada como não encontrada, e a seguinte termina o serviço", async () => {
    const { world } = await firstImport();
    removeFromTeam(world, "f");
    issue(world, "h").parent = "p2"; // o pai mudou: a marca de pendência sobrevive à rodada abandonada
    issue(world, "b").description = "Descrição B nova";
    const run = await begin();
    for (let i = 0; i < 4; i += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.body.phase === "hierarchy" || res.body.phase === "mentions") break;
    }
    expect((await post(`/${run.id}/abandon`)).body.phase).toBe("failed");
    expect((await q("select count(*)::int n from ticket_external_refs where missing_since is not null"))[0]!["n"]).toBe(0);
    const rows = await byExt();
    expect(rows.get("h")!["hierarchy_pending"], "a marca de pendência sobrevive ao abandono").toBe(true);
    expect(rows.get("b")!["description"]).toBe("Descrição B nova");
    const next = await runAll();
    expect(next.counts).toMatchObject({ missing: 1 });
    const after = await byExt();
    expect(after.get("f")!["missing_since"]).not.toBeNull();
    // H desceu para o pai novo na rodada seguinte, mesmo que a abandonada já tivesse lido a mudança.
    expect(after.get("h")!["parent_id"]).toBe(after.get("p2")!["id"]);
    expect(after.get("h")!["hierarchy_pending"]).toBe(false);
  });

  it("issue que perde o pai e o projeto no Linear volta ao destino da rodada (a raiz do projeto, no caso)", async () => {
    const { world } = await firstImport();
    issue(world, "h").parent = null;
    const second = await runAll();
    expect(second.counts).toMatchObject({ parentsLinked: 1 });
    expect((await byExt()).get("h")!["parent_id"]).toBeNull();
  });

  it("projeto do Linear que sumiu conta em missingProjects; issue em lixeira conta como não vista", async () => {
    const { world } = await firstImport();
    world.data[TEAM_ENG.id]!.projects.length = 0;
    issue(world, "a").trashed = true;
    const second = await runAll();
    expect(second.counts).toMatchObject({ missing: 1, missingProjects: 1 });
    const rows = await q("select external_id, missing_since from ticket_external_refs where missing_since is not null order by external_id");
    expect(rows.map((row) => row["external_id"])).toEqual(["a", "lp1"]);
  });

  it("item fora do formato na leitura: a rodada não marca nada e diz que não conferiu", async () => {
    const { world } = await firstImport();
    removeFromTeam(world, "f");
    world.data[TEAM_ENG.id]!.override = (_call, ask) => {
      void ask;
      return undefined;
    };
    // um nó inválido (sem id) no meio da lista
    world.list.push({ id: "" as string, identifier: "ENG-99", title: "Quebrada" });
    const second = await runAll();
    expect(second.counts).toMatchObject({ skippedInvalid: 1, missingNotChecked: true });
    expect((await q("select count(*)::int n from ticket_external_refs where missing_since is not null"))[0]!["n"]).toBe(0);
  });
});

describe("item 2: invariantes e retratos ilegíveis", () => {
  it("pai: a situação do Linear não é copiada (sai do filho aberto) e três rodadas sem mudança não oscilam (zero atualizações)", async () => {
    const { world } = await firstImport();
    // p1 tem o filho aberto H: a situação de p1 sai dele (ADR 0068), qualquer que seja a do Linear.
    issue(world, "p1").state = "started";
    const started = await runAll();
    expect(started.counts).toMatchObject({ updated: 0, keptTouched: 0 });
    expect((await byExt()).get("p1")!["status"]).toBe("todo");
    issue(world, "p1").state = "completed";
    const second = await runAll();
    const rows = await byExt();
    expect(rows.get("p1")!["status"]).toBe("todo");
    expect((rows.get("p1")!["applied_snapshot"] as Row)["status"]).toBe("todo");
    expect(second.counts).toMatchObject({ updated: 0, keptTouched: 0 });
    for (let i = 0; i < 2; i += 1) expect((await runAll()).counts).toMatchObject({ updated: 0, keptTouched: 0 });
    expect((await byExt()).get("p1")!["status"]).toBe("todo");
  });

  it("situação dentro de uma ideia não muda e a próxima rodada não insiste", async () => {
    const { world } = await firstImport();
    const rows = await byExt();
    const root = (await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Ideia" })).body.id as string;
    expect((await h.call("POST", `/api/tickets/${root}/idea`, as("admin"))).status).toBe(200);
    expect((await patch(rows.get("a")!["id"], { parentId: root })).status).toBe(200);
    issue(world, "a").state = "started";
    const second = await runAll();
    expect((await byExt()).get("a")!["status"]).toBe("todo");
    expect(second.counts).toMatchObject({ updated: 0 });
    expect((await runAll()).counts).toMatchObject({ updated: 0 });
  });

  it("concluído aqui e mexido no Linear: mantém o concluído e conta em keptTouched", async () => {
    const { world } = await firstImport();
    const rows = await byExt();
    await patch(rows.get("h")!["id"], { status: "done" });
    await patch(rows.get("p1")!["id"], { status: "done" });
    issue(world, "h").state = "started";
    // h foi concluído aqui (mexido): o Linear mudou, o TreePM também: fica concluído e conta em keptTouched.
    const second = await runAll();
    expect(second.counts).toMatchObject({ keptTouched: 1 });
    expect((await byExt()).get("h")!["status"]).toBe("done");
  });

  it("voltar a fazer um filho de pai concluído leva o pai para em andamento (evento automático)", async () => {
    const world = base();
    world.list.push({ id: "k", identifier: "ENG-20", title: "Filho K", parent: "p2", state: "completed" });
    await firstImport(world);
    const rows = await byExt();
    expect((await patch(rows.get("p2")!["id"], { status: "done" })).status).toBe(200);
    issue(world, "k").state = "started";
    const second = await runAll();
    const after = await byExt();
    expect(after.get("k")!["status"]).toBe("in_progress");
    expect(after.get("p2")!["status"]).toBe("in_progress");
    expect(second.counts).toMatchObject({ updated: 1 });
    // um evento automático de situação no pai nesta rodada (o outro, da primeira importação, é a conta do filho concluído)
    const reopen = (await events()).filter((event) => event["subject_id"] === rows.get("p2")!["id"] && (event["payload"] as Row)["automatic"] === true && (event["payload"] as Row)["runId"] === second.id);
    expect(reopen).toHaveLength(1);
    // nenhuma outra tabela de aviso recebeu linha: só atividade
    expect(JSON.stringify((await q("select distinct kind from activity_events where occurred_at > now() - interval '1 minute' order by kind")).map((r) => r["kind"]))).not.toMatch(/notif/);
  });

  it("e-mail ilegível não troca o responsável, e a mudança não se perde (a descrição que não veio tem o seu teste em linear-reimport-statuses)", async () => {
    const { world } = await firstImport();
    issue(world, "b").description = "Outra descrição";
    issue(world, "d").assignee = { id: "u-manager", email: "manager@exemplo.test" };
    // Esta rodada: sem descrição e sem e-mail (o Linear recusa).
    const emailError = { body: { errors: [{ message: "no permission", path: ["team", "issues", "nodes", 0, "assignee", "email"], extensions: { code: "FORBIDDEN" } }], data: null } };
    const data = world.data[TEAM_ENG.id]!;
    data.override = (_call, ask) => (ask.withEmail ? emailError : undefined);
    const second = await runAll();
    expect(second.counts).toMatchObject({ assigneeEmailUnavailable: true });
    let rows = await byExt();
    expect(rows.get("d")!["assignees"]).toEqual([h.world().people.admin]);
    expect((rows.get("d")!["source_snapshot"] as Row)["assigneeExternalId"]).toBe("u-admin");
    // Quando o e-mail volta, a mudança é vista e aplicada.
    delete data.override;
    await runAll();
    rows = await byExt();
    expect(rows.get("d")!["assignees"]).toEqual([h.world().people.manager]);
    expect(rows.get("b")!["description"]).toBe("Outra descrição");
  });

  it("o texto atualizado passa pelas mesmas neutralizações: chave do projeto e menção de pessoa; nenhum e-mail do Linear é gravado", async () => {
    const { world } = await firstImport();
    issue(world, "b").description = "Veja OPEN-1 e [@Fulano](person:abc) e https://x.test/?t=OPEN-2";
    issue(world, "a").title = "Título [@Beltrano](person:xyz)";
    await runAll();
    const rows = await byExt();
    const description = rows.get("b")!["description"] as string;
    expect(description).not.toMatch(/OPEN-\d/);
    expect(description).not.toContain("person:abc");
    expect(rows.get("a")!["title"] as string).not.toContain("person:");
    expect((await q("select count(*)::int n from ticket_relations where kind = 'mentions' and from_ticket_id = $1::uuid", [rows.get("b")!["id"]]))[0]!["n"]).toBe(0);
  });

  it("origem em outro projeto do TreePM não é tocada: conta em elsewhere", async () => {
    const { world } = await firstImport();
    // a origem de A passa para outro projeto (como se o ticket tivesse sido movido), e o título muda no Linear
    const rows = await byExt();
    const other = h.world().projects.priv;
    await q("update tickets set project_id = $2::uuid, parent_id = null where id = $1::uuid", [rows.get("a")!["id"], other]);
    await q("update ticket_external_refs set project_id = $2::uuid where ticket_id = $1::uuid", [rows.get("a")!["id"], other]);
    issue(world, "a").title = "Novo título de A";
    const second = await runAll();
    expect(second.counts).toMatchObject({ elsewhere: 1, issuesCreated: 0 });
    expect((await q("select title from tickets where id = $1::uuid", [rows.get("a")!["id"]]))[0]!["title"]).toBe("Título A");
    expect((await q("select count(*)::int n from ticket_external_refs where external_id = 'a'"))[0]!["n"]).toBe(1);
  });

  it("passo repetido na reimportação (resposta perdida) não duplica nem conta duas vezes", async () => {
    const { world } = await firstImport();
    issue(world, "b").description = "Descrição B nova";
    issue(world, "e").priority = 3;
    const run = await begin();
    let last: RunBody = run;
    for (let i = 0; i < 120 && !last.done; i += 1) {
      const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
      last = [one, two].find((res) => res.status === 200)?.body ?? last;
    }
    const done = await finish(run);
    expect(done.counts).toMatchObject({ updated: 2, issuesCreated: 0 });
    expect((await q("select count(*)::int n from activity_events where kind = 'ticket.updated' and payload->>'source' = 'linear_reimport'"))[0]!["n"]).toBe(2);
  });

  it("nenhuma chamada a provedor de IA durante a reimportação", async () => {
    const { world } = await firstImport();
    issue(world, "a").title = "Outro";
    const originalFetch = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      hosts.push(String(typeof input === "object" && input !== null && "url" in input ? (input as { url: string }).url : input));
      return originalFetch(input as never, init as never);
    }) as typeof fetch;
    try {
      await runAll();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(hosts.filter((host) => /anthropic|voyage|typesafe|jev/i.test(host))).toEqual([]);
  });
});
