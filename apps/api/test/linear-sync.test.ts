import { mapLinearPriority } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeProject, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 1 (ADR 0061; TREEPM-489 e filhos): origem com datas, criador e chaves antigas; descrição, líder e prioridade do projeto.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const ANA = { id: "u-ana", name: "Ana Criadora", email: "admin@exemplo.test" };
const ZED = { id: "u-zed", name: "Zed Externo", email: "zed.sentinela@linear.test" };
const LEAD = { id: "u-lead", email: "admin@exemplo.test" };

async function finish(run: RunBody): Promise<RunBody> {
  for (let i = 0; i < 120; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
const sync = async (): Promise<RunBody> => {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return finish(run.body);
};

type World = { project: FakeProject; list: FakeIssue[]; data: Record<string, FakeTeamData> };
const world = (over: Partial<FakeProject> = {}): World => {
  const project: FakeProject = { id: "lp1", name: "Alfa", status: "started", description: "Resumo do Alfa", content: "Conteúdo longo do Alfa", priority: 2, lead: LEAD, ...over };
  const list: FakeIssue[] = [
    { id: "a", identifier: "ENG-1", title: "Título A", project: "lp1", creator: ANA, createdAt: "2026-03-03T10:00:00.000Z", startedAt: "2026-03-04T10:00:00.000Z" },
    { id: "z", identifier: "ENG-2", title: "Título Z", project: "lp1", creator: ZED, previousIdentifiers: ["OPS-3", "OPS-1"] },
  ];
  return { project, list, data: { [TEAM_ENG.id]: { projects: [project], issues: list } } };
};
const projectTicket = async (): Promise<Row> =>
  (await q(`select t.id, t.description, t.priority, r.source_snapshot, r.applied_snapshot,
              coalesce((select array_agg(a.person_id::text) from ticket_assignees a where a.ticket_id = t.id), '{}') as assignees
         from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.kind = 'project' and r.project_id = $1::uuid`, [open()]))[0] as Row;
const origin = async (externalId: string): Promise<Row> => (await q("select * from ticket_external_refs where external_id = $1", [externalId]))[0] as Row;
const updatedEvents = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]!["n"] as number;

/** Põe o projeto como estava antes desta fatia: origem sem as colunas novas e o ticket do projeto sem retrato de descrição, líder e prioridade. */
async function ageToOld(): Promise<void> {
  await q("update ticket_external_refs set external_created_at = null, external_started_at = null, external_completed_at = null, external_canceled_at = null, external_previous_keys = '{}', external_creator_id = null, external_creator_name = null, creator_person_id = null");
  await q(`update ticket_external_refs set source_snapshot = source_snapshot - 'description' - 'assigneeExternalId' - 'priority',
                  applied_snapshot = (applied_snapshot - 'heldHere') || '{"description": "", "assigneeIds": [], "priority": 0}'::jsonb where kind = 'project'`);
  await q("update tickets set description = '', priority = 0 where id in (select ticket_id from ticket_external_refs where kind = 'project')");
  await q("delete from ticket_assignees where ticket_id in (select ticket_id from ticket_external_refs where kind = 'project')");
}
async function firstImport(w: World = world()): Promise<World> {
  await linkWithData(h, put, open(), w.data);
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  await finish(run.body);
  return w;
}

describe("a primeira importação de um projeto novo já nasce com tudo", () => {
  it("origem com datas, criador e chaves antigas; ticket do projeto com descrição (o conteúdo longo), líder e prioridade", async () => {
    await firstImport();
    const people = h.world().people;
    const a = await origin("a");
    expect(a).toMatchObject({ external_creator_id: "u-ana", creator_person_id: people.admin, external_creator_name: null, external_previous_keys: [] });
    expect(new Date(a["external_created_at"] as string).toISOString()).toBe("2026-03-03T10:00:00.000Z");
    expect(new Date(a["external_started_at"] as string).toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(a["external_completed_at"]).toBeNull();
    const z = await origin("z");
    expect(z).toMatchObject({ external_creator_id: "u-zed", creator_person_id: null, external_creator_name: "Zed Externo", external_previous_keys: ["OPS-3", "OPS-1"] });
    const project = await projectTicket();
    expect(project).toMatchObject({ description: "Conteúdo longo do Alfa", priority: mapLinearPriority(2), assignees: [people.admin] });
    expect(project["source_snapshot"]).toMatchObject({ description: "Conteúdo longo do Alfa", assigneeExternalId: "u-lead", priority: 2 });
  });

  it("sem conteúdo longo vale o resumo; o e-mail do Linear não entra em retrato nenhum", async () => {
    await firstImport(world({ content: null }));
    expect((await projectTicket())["description"]).toBe("Resumo do Alfa");
    const all = JSON.stringify(await q("select source_snapshot, applied_snapshot from ticket_external_refs"));
    for (const secret of ["admin@exemplo.test", "zed.sentinela", "linear.test"]) expect(all, secret).not.toContain(secret);
  });

  it("líder com e-mail de duas pessoas ou de pessoa de teste fica sem responsável", async () => {
    await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_A','u_dup1','D1','dup@exemplo.test','member'), ('org_A','u_dup2','D2','DUP@exemplo.test','member')");
    await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ('org_A','treepm_test_bia','Bia','bia@teste.invalid','member', true)");
    await firstImport(world({ lead: { id: "u-dup", email: "dup@exemplo.test" } }));
    expect((await projectTicket())["assignees"]).toEqual([]);
  });
});

describe("projeto já importado (retratos antigos) + sincronização", () => {
  it("preenche datas e criador na origem e descrição, líder e prioridade no ticket do projeto; a segunda sincronização fica quieta", async () => {
    await firstImport();
    await ageToOld();
    const people = h.world().people;
    const before = await updatedEvents();
    const first = await sync();
    // Campos preenchidos pela primeira vez: descrição, líder e prioridade do projeto (3) + a origem de cada issue (2).
    expect(first.counts).toMatchObject({ filled: 5, issuesCreated: 0, updated: 1 });
    expect(await updatedEvents()).toBe(before + 1);
    expect(await projectTicket()).toMatchObject({ description: "Conteúdo longo do Alfa", priority: mapLinearPriority(2), assignees: [people.admin] });
    expect(await origin("a")).toMatchObject({ creator_person_id: people.admin, external_creator_name: null, external_creator_id: "u-ana" });
    expect(await origin("z")).toMatchObject({ creator_person_id: null, external_creator_name: "Zed Externo", external_previous_keys: ["OPS-3", "OPS-1"] });
    const second = await sync();
    expect(second.counts).toMatchObject({ filled: 0, updated: 0, keptTouched: 0 });
    expect(await updatedEvents()).toBe(before + 1);
  });

  it("descrição que alguém já escreveu no TreePM fica, e não é sobrescrita nas sincronizações seguintes mesmo com o Linear mudando", async () => {
    const w = await firstImport();
    await ageToOld();
    const ticket = (await projectTicket())["id"] as string;
    expect((await h.call("PATCH", `/api/tickets/${ticket}`, as("admin"), { description: "Escrito aqui, no TreePM" })).status).toBe(200);
    const first = await sync();
    expect(first.counts).toMatchObject({ keptTouched: 1, filled: 4 });
    expect((await projectTicket())["description"]).toBe("Escrito aqui, no TreePM");
    expect(((await projectTicket())["applied_snapshot"] as { heldHere?: string[] }).heldHere).toEqual(["description"]);
    // O Linear muda o texto: continua o daqui; o que não foi mantido (prioridade) segue a regra de sempre.
    w.project.content = "Texto novo do Linear";
    w.project.priority = 3;
    const second = await sync();
    expect(second.counts).toMatchObject({ filled: 0, keptTouched: 1, updated: 1 });
    expect(await projectTicket()).toMatchObject({ description: "Escrito aqui, no TreePM", priority: mapLinearPriority(3) });
    // O Linear não muda mais nada: quieto, sem evento.
    const events = await updatedEvents();
    const third = await sync();
    expect(third.counts).toMatchObject({ filled: 0, keptTouched: 0, updated: 0 });
    expect(await updatedEvents()).toBe(events);
    expect((await projectTicket())["description"]).toBe("Escrito aqui, no TreePM");
  });

  it("campo preenchido aqui com o mesmo valor do Linear não é 'mantido': acompanha o Linear depois", async () => {
    const w = await firstImport();
    await ageToOld();
    const ticket = (await projectTicket())["id"] as string;
    await h.call("PATCH", `/api/tickets/${ticket}`, as("admin"), { description: "Conteúdo longo do Alfa" });
    await sync();
    expect(((await projectTicket())["applied_snapshot"] as { heldHere?: string[] }).heldHere ?? []).toEqual([]);
    w.project.content = "Mudou no Linear";
    await sync();
    expect((await projectTicket())["description"]).toBe("Mudou no Linear");
  });

  it("issue que trocou de time (identificador novo) guarda o antigo e passa a ser achada por ele", async () => {
    const w = await firstImport();
    const a = w.list.find((issue) => issue.id === "a") as FakeIssue;
    a.identifier = "ENG-20";
    a.previousIdentifiers = ["ENG-1", "OPS-9"];
    await sync();
    expect(await origin("a")).toMatchObject({ external_key: "ENG-20", external_previous_keys: ["ENG-1", "OPS-9"] });
  });

  it("repetir passos e duas abas: nada se duplica nem se conta duas vezes", async () => {
    await firstImport();
    await ageToOld();
    const run = (await post("", {})).body as RunBody;
    let last: RunBody = run;
    for (let i = 0; i < 120 && !last.done; i += 1) {
      const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
      last = [one, two].find((res) => res.status === 200)?.body ?? last;
    }
    const done = await finish(run);
    expect(done.counts).toMatchObject({ filled: 5, updated: 1 });
    expect((await q("select count(*)::int n from activity_events where kind = 'ticket.updated' and payload->>'source' = 'linear_reimport'"))[0]!["n"]).toBe(1);
  });
});

describe("o criador e o e-mail ilegível", () => {
  const denied = (world: World): void => {
    world.data[TEAM_ENG.id]!.override = (_call, ask) => (ask.withEmail ? { body: { errors: [{ message: "x", path: ["team", "issues", "nodes", 0, "creator", "email"], extensions: { code: "FORBIDDEN" } }] } } : undefined);
    world.data[TEAM_ENG.id]!.projectsOverride = (_call, ask) => (ask.withEmail ? { body: { errors: [{ message: "x", path: ["team", "projects", "nodes", 0, "lead", "email"], extensions: { code: "FORBIDDEN" } }] } } : undefined);
  };

  it("sem e-mail legível o criador entra pelo nome, o líder não é atribuído e nada quebra; com o e-mail de volta, casa e o nome some", async () => {
    const w = world();
    denied(w);
    await firstImport(w);
    expect(await origin("a")).toMatchObject({ creator_person_id: null, external_creator_name: "Ana Criadora", external_creator_id: "u-ana" });
    expect((await projectTicket())["assignees"]).toEqual([]);
    // O e-mail volta: o criador casa com a pessoa e o nome sai; o líder passa a ser atribuído (nunca esteve atribuído nem no retrato).
    w.data[TEAM_ENG.id]!.override = undefined;
    w.data[TEAM_ENG.id]!.projectsOverride = undefined;
    await sync();
    expect(await origin("a")).toMatchObject({ creator_person_id: h.world().people.admin, external_creator_name: null });
  });

  it("pessoa já casada não é rebaixada a nome quando o e-mail some numa rodada", async () => {
    const w = world();
    await firstImport(w);
    denied(w);
    await sync();
    expect(await origin("a")).toMatchObject({ creator_person_id: h.world().people.admin, external_creator_name: null });
  });

  it("criador apagado no Linear: nenhuma coluna de criador", async () => {
    const w = world();
    await firstImport(w);
    (w.list.find((issue) => issue.id === "a") as FakeIssue).creator = null;
    await sync();
    expect(await origin("a")).toMatchObject({ creator_person_id: null, external_creator_name: null, external_creator_id: null });
  });
});

describe("conteúdo longo demais", () => {
  const TOO_BIG = { headers: { "content-length": String(8 * 1024 * 1024) }, body: {} };
  /** 50 projetos (uma página inteira) com o `pr25` gigante: a página que o inclui estoura, qualquer redução que o deixe de fora cabe. */
  const bigWorld = (): World => {
    const projects: FakeProject[] = Array.from({ length: 50 }, (_, i) => ({ id: `pr${i + 1}`, name: `Projeto ${i + 1}`, status: "started", description: `Resumo ${i + 1}`, content: `Conteúdo longo ${i + 1}`, priority: 1, lead: null }));
    const w = { project: projects[0] as FakeProject, list: [] as FakeIssue[], data: {} as Record<string, FakeTeamData> };
    w.data[TEAM_ENG.id] = { projects, issues: [], projectsOverride: (_call, ask) => (ask.withContent && ask.ids.includes("pr25") ? TOO_BIG : undefined) };
    return w;
  };
  /** Passos até terminar, tolerando os passos que terminam em erro (a página reduzida fica guardada para o seguinte). */
  async function finishTolerant(run: RunBody): Promise<{ done: RunBody; failed: number }> {
    let failed = 0;
    for (let i = 0; i < 200; i += 1) {
      const res = await post(`/${run.id}/step`);
      if (res.status !== 200) failed += 1;
      else if (res.body.done) return { done: res.body, failed };
    }
    throw new Error("não terminou");
  }
  const descriptionOf = async (id: string): Promise<string> => (await q("select t.description from tickets t join ticket_external_refs r on r.ticket_id = t.id and r.org_id = t.org_id where r.external_id = $1", [id]))[0]!["description"] as string;
  const tooBig = (w: World): void => {
    w.data[TEAM_ENG.id]!.projectsOverride = (_call, ask) => (ask.withContent ? TOO_BIG : undefined);
  };

  it("na primeira importação, só o projeto gigante fica com o resumo; os outros 49 recebem o conteúdo", async () => {
    const w = bigWorld();
    await linkWithData(h, put, open(), w.data);
    const started = await post("", {});
    const { done } = await finishTolerant(started.body);
    expect(done.counts).toMatchObject({ projectsSeen: 50, projectsCreated: 50, descriptionUnavailable: true });
    expect(await descriptionOf("pr25")).toBe("Resumo 25");
    for (const n of [1, 24, 26, 50]) expect(await descriptionOf(`pr${n}`)).toBe(`Conteúdo longo ${n}`);
    expect((await q("select count(*)::int n from ticket_external_refs where kind = 'project'"))[0]!["n"]).toBe(50);
  });

  it("na sincronização: projeto antigo SEM descrição recebe o resumo; o que já tem retrato da descrição não é tocado", async () => {
    const w = bigWorld();
    await linkWithData(h, put, open(), w.data);
    await finishTolerant((await post("", {})).body);
    // Antes desta fatia: sem retrato de descrição no gigante e em pr1; só pr1 tem o texto que o Linear lhe deu.
    await q("update ticket_external_refs set source_snapshot = source_snapshot - 'description', applied_snapshot = (applied_snapshot - 'heldHere') || '{\"description\": \"\"}'::jsonb where external_id = 'pr25'");
    await q("update tickets set description = '' where id = (select ticket_id from ticket_external_refs where external_id = 'pr25')");
    w.data[TEAM_ENG.id]!.projects[24]!.description = "Resumo novo 25";
    w.data[TEAM_ENG.id]!.projects[24]!.content = "Conteúdo enorme do 25";
    const { done } = await finishTolerant((await post("", {})).body);
    expect(done.counts).toMatchObject({ descriptionUnavailable: true });
    expect(await descriptionOf("pr25")).toBe("Resumo novo 25");
    expect(await descriptionOf("pr24")).toBe("Conteúdo longo 24");
    // O gigante agora TEM retrato (o resumo): se o Linear muda o resumo, o ticket acompanha o resumo e nunca fica sem texto.
    // Já um projeto com o conteúdo longo no retrato, que passa a estourar, não troca o conteúdo pelo resumo.
    w.data[TEAM_ENG.id]!.projectsOverride = (_call, ask) => (ask.withContent && ask.ids.includes("pr1") ? TOO_BIG : undefined);
    w.data[TEAM_ENG.id]!.projects[0]!.description = "Resumo novo 1";
    await finishTolerant((await post("", {})).body);
    expect(await descriptionOf("pr1")).toBe("Conteúdo longo 1");
  });

  it("repetir o passo depois do erro não duplica nem conta duas vezes", async () => {
    const w = bigWorld();
    await linkWithData(h, put, open(), w.data);
    const run = (await post("", {})).body as RunBody;
    const first = await post(`/${run.id}/step`); // 50 estoura (o gigante é o 25º), 25 estoura, 12 cabe: o passo grava 12 projetos
    expect(first.status).toBe(200);
    expect((await q("select page_size from external_import_runs where id = $1::uuid", [run.id]))[0]!["page_size"]).toBe(12);
    expect((await q("select count(*)::int n from ticket_external_refs where kind = 'project'"))[0]!["n"]).toBe(12);
    const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
    expect([one.status, two.status]).toContain(200);
    const { done } = await finishTolerant(run);
    expect(done.counts).toMatchObject({ projectsSeen: 50, projectsCreated: 50 });
    expect((await q("select count(*)::int n from ticket_external_refs where kind = 'project'"))[0]!["n"]).toBe(50);
  });

  it("limite de taxa no meio das reduções: espera com a página já reduzida e segue dali", async () => {
    const w = bigWorld();
    await linkWithData(h, put, open(), w.data);
    let limited = true;
    w.data[TEAM_ENG.id]!.projectsOverride = (_call, ask) => {
      if (ask.first === 12 && limited) return { status: 429, headers: { "Retry-After": "30" }, body: {} };
      return ask.withContent && ask.ids.includes("pr25") ? TOO_BIG : undefined;
    };
    const run = (await post("", {})).body as RunBody;
    const hit = await post(`/${run.id}/step`); // 50 → 25 → 12: limite
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ phase: "projects", lastErrorCode: "linear_rate_limited" });
    expect((await q("select page_size from external_import_runs where id = $1::uuid", [run.id]))[0]!["page_size"]).toBe(12);
    expect((await q("select count(*)::int n from ticket_external_refs where kind = 'project'"))[0]!["n"]).toBe(0);
    limited = false;
    await q("update external_import_runs set wait_until = now() - interval '1 second' where id = $1::uuid", [run.id]);
    const { done } = await finishTolerant(run);
    expect(done.counts).toMatchObject({ projectsSeen: 50, projectsCreated: 50 });
    expect(await descriptionOf("pr25")).toBe("Resumo 25");
    expect(await descriptionOf("pr1")).toBe("Conteúdo longo 1");
  });

  it("projeto único que estoura: a primeira importação usa o resumo", async () => {
    const w = world();
    tooBig(w);
    await linkWithData(h, put, open(), w.data);
    await finishTolerant((await post("", {})).body);
    expect(await descriptionOf("lp1")).toBe("Resumo do Alfa");
  });
});

describe("as respostas", () => {
  it("o detalhe do ticket traz datas e criador (pessoa casada OU nome do Linear), sem id do Linear nem e-mail", async () => {
    await firstImport();
    const a = (await q("select ticket_id from ticket_external_refs where external_id = 'a'"))[0]!["ticket_id"] as string;
    const z = (await q("select ticket_id from ticket_external_refs where external_id = 'z'"))[0]!["ticket_id"] as string;
    const detailA = (await h.call("GET", `/api/tickets/${a}`, as("admin"))).body;
    expect(detailA.externalSource).toMatchObject({ provider: "linear", createdAt: "2026-03-03T10:00:00.000Z", startedAt: "2026-03-04T10:00:00.000Z", completedAt: null, canceledAt: null, creator: { personId: h.world().people.admin } });
    expect(Object.keys(detailA.externalSource.creator)).toEqual(["personId"]);
    const detailZ = (await h.call("GET", `/api/tickets/${z}`, as("admin"))).body;
    expect(detailZ.externalSource.creator).toEqual({ name: "Zed Externo" });
    for (const detail of [detailA, detailZ]) {
      const text = JSON.stringify(detail.externalSource);
      for (const secret of ["u-ana", "u-zed", "sentinela", "linear.test", "OPS-3"]) expect(text, secret).not.toContain(secret);
    }
  });

  it("o GET current traz quando foi a última sincronização concluída e por quem", async () => {
    await firstImport();
    const done = await sync();
    const current = (await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"))).body;
    expect(current.lastFinished).toMatchObject({ id: done.id, mode: "reimport", startedBy: { id: h.world().people.admin } });
    expect(typeof current.lastFinished.finishedAt).toBe("string");
  });
});
