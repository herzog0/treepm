import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import { fakeCommentNode } from "./linear-support.js";
import type { FakeComment, FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 2: comentários (ADR 0061, seções 3 a 7; TREEPM-477), de ponta a ponta com `fetch` falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean>; waitUntil?: string | null };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

const SENTINEL = "zed.sentinela@linear.test";
const DUP = "duplicado@exemplo.test";
const TESTER = "pessoa.teste@exemplo.test";
const SECRET_BODY = "CORPO-SECRETO-NAO-LOGAR";
const ISSUES: FakeIssue[] = [
  { id: "a", identifier: "ENG-1", title: "A" },
  { id: "b", identifier: "ENG-2", title: "B" },
  { id: "c", identifier: "ENG-3", title: "C" },
];
/** Os autores, em ciclo: casado, e-mail duplicado, pessoa de teste, sem e-mail, robô, apagado, de fora (Slack), não casado (sentinela). */
const AUTHORS: Pick<FakeComment, "user" | "bot" | "external">[] = [
  { user: { id: "u-admin", name: "Admin no Linear", email: "admin@exemplo.test" } },
  { user: { id: "u-dup", name: "Dup", email: DUP } },
  { user: { id: "u-test", name: "Testadora", email: TESTER } },
  { user: { id: "u-noemail", name: "Sem E-mail", email: null } },
  { bot: "GitHub" },
  {},
  { external: "Zé do Slack" },
  { user: { id: "u-zed", name: "Zed Externo", email: SENTINEL } },
];
/** 130 comentários (3 páginas de 50), mais novos primeiro; o 5 responde ao 120 (pai numa página posterior); o 129 é de issue de outro time. */
function comments(): FakeComment[] {
  return Array.from({ length: 130 }, (_, i): FakeComment => ({
    id: `c-${i}`,
    issue: i === 129 ? "x-outro-time" : (ISSUES[i % 3] as FakeIssue).id,
    body: i === 120 ? "Pai lá no fim\ncom duas linhas" : i === 7 ? `${SECRET_BODY} [@Ana](person:0190a0b0-0000-7000-8000-000000000001) ENG-1` : `Comentário ${i}`,
    createdAt: new Date(Date.UTC(2026, 2, 1) + (130 - i) * 60_000).toISOString(),
    ...(i === 5 ? { parent: { id: "c-120", body: "Pai lá no fim\ncom duas linhas" } } : {}),
    ...(AUTHORS[i % AUTHORS.length] as object),
  }));
}

async function finish(run: RunBody, steps = 200): Promise<RunBody> {
  for (let i = 0; i < steps; i += 1) {
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
async function seedPeople(): Promise<void> {
  const org = (await q("select org_id from people where id = $1", [h.world().people.admin]))[0]!["org_id"];
  await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_dup1', 'Dup 1', $2, 'member'), ($1, 'u_dup2', 'Dup 2', $2, 'member')", [org, DUP]);
  await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ($1, 'treepm_test_c1', 'Teste', $2, 'member', true)", [org, TESTER]);
}
async function firstImport(list: FakeComment[] = comments()): Promise<FakeTeamData> {
  await seedPeople();
  const team: FakeTeamData = { projects: [], issues: ISSUES, comments: list };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  const run = await post("", {});
  expect(run.status).toBe(201);
  const done = await finish(run.body);
  expect(done.phase).toBe("done");
  return team;
}
const imported = async (): Promise<Row[]> => q("select c.*, r.external_id from ticket_comments c join external_item_refs r on r.local_id = c.id order by r.external_id");
const byExternal = async (id: string): Promise<Row> => (await q("select c.*, r.removed_here_at, r.missing_since, r.local_id as ref_local from external_item_refs r left join ticket_comments c on c.id = r.local_id where r.external_id = $1", [id]))[0] as Row;
/**
 * C2, item 6: os eventos "N comentários trazidos" são gravados um por ticket por PÁGINA; `total` é a soma das contagens e `groups` o
 * número de pares (ticket, rodada) — o que a linha do tempo mostra como uma entrada cada.
 */
const coverage = async (): Promise<{ total: number; groups: number }> => {
  const row = (await q("select coalesce(sum((payload->>'count')::int), 0)::int total, count(distinct (subject_id, payload->>'runId'))::int groups from activity_events where kind = 'ticket.comments_imported_from_linear'"))[0] as Row;
  return { total: row["total"] as number, groups: row["groups"] as number };
};
const eventsOf = async (kind: string): Promise<number> => (await q("select count(*)::int n from activity_events where kind = $1", [kind]))[0]!["n"] as number;

describe("a primeira importação traz os comentários", () => {
  it("todos, com data original, autor certo, citação do pai e um evento por ticket; nada de menção nem de evento por comentário", async () => {
    await firstImport();
    const rows = await imported();
    expect(rows).toHaveLength(129);
    expect(rows.every((row) => row["via"] === "linear")).toBe(true);
    const run = (await q("select counts from external_import_runs order by started_at desc limit 1"))[0]!["counts"] as Record<string, number>;
    expect(run).toMatchObject({ commentsCreated: 129, commentsSkipped: 1, commentsUpdated: 0, commentsKeptEdited: 0 });
    const people = h.world().people;
    const at = (i: number) => rows.find((row) => row["external_id"] === `c-${i}`) as Row;
    expect(at(0)).toMatchObject({ author_person_id: people.admin, external_author_name: null });
    expect(at(1)).toMatchObject({ author_person_id: null, external_author_name: "Dup" });
    expect(at(2)).toMatchObject({ author_person_id: null, external_author_name: "Testadora" });
    expect(at(3)).toMatchObject({ author_person_id: null, external_author_name: "Sem E-mail" });
    expect(at(4)).toMatchObject({ author_person_id: null, external_author_name: "GitHub" });
    expect(at(13)).toMatchObject({ author_person_id: null, external_author_name: null });
    expect(at(6)).toMatchObject({ author_person_id: null, external_author_name: "Zé do Slack" });
    expect(at(15)).toMatchObject({ author_person_id: null, external_author_name: "Zed Externo" });
    expect((at(10)["created_at"] as Date).toISOString()).toBe(new Date(Date.UTC(2026, 2, 1) + 120 * 60_000).toISOString());
    expect(at(5)["body"]).toBe("> Pai lá no fim com duas linhas\n\nComentário 5");
    expect(at(7)["body"]).not.toMatch(/\(person:/);
    expect(await coverage()).toEqual({ total: 129, groups: 3 });
    expect(await eventsOf("ticket.comment_added")).toBe(0);
    expect((await q("select count(*)::int n from ticket_relations"))[0]!["n"]).toBe(0);
    // O e-mail do Linear não fica em lugar nenhum.
    const dump = JSON.stringify(await q("select * from ticket_comments")) + JSON.stringify(await q("select * from external_item_refs")) + JSON.stringify(await q("select * from activity_events")) + JSON.stringify(await q("select * from external_import_runs"));
    expect(dump).not.toContain(SENTINEL);
    expect(dump).not.toContain(DUP);
  });

  it("a página do ticket mostra o comentário importado sem edição, com o selo e o nome do Linear; a linha do tempo resume a rodada", async () => {
    await firstImport();
    const ticket = (await q("select id from tickets where id in (select ticket_id from ticket_external_refs where external_id = 'a')"))[0]!["id"];
    const res = await h.call("GET", `/api/tickets/${ticket}/activity?limit=100`, as("admin"));
    expect(res.status).toBe(200);
    const entries = res.body.entries as Row[];
    const zed = entries.find((entry) => entry["type"] === "comment" && (entry["externalAuthor"] as Row | undefined)?.["name"] === "Zed Externo") as Row;
    expect(zed).toMatchObject({ actor: null, via: "linear", canEdit: false, canRemove: true });
    const mine = entries.find((entry) => entry["type"] === "comment" && (entry["actor"] as Row | null)?.["id"] === h.world().people.admin) as Row;
    expect(mine).toMatchObject({ via: "linear", canEdit: false, canRemove: true });
    expect(entries.find((entry) => entry["type"] === "comments_imported")).toMatchObject({ count: 43, automatic: true });
    // Editar um comentário importado é recusado; remover vale e ele não volta.
    const edit = await h.call("PATCH", `/api/comments/${mine["id"]}`, as("admin"), { body: "outro" });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("comment_imported");
    expect((await h.call("DELETE", `/api/comments/${zed["id"]}`, as("admin"))).status).toBe(204);
    await sync();
    const gone = (await q("select r.removed_here_at, r.local_id, c.removed_at from external_item_refs r join ticket_comments c on c.id = $1 where r.external_id = 'c-15'", [zed["id"]]))[0] as Row;
    expect(gone["removed_here_at"]).not.toBeNull();
    expect(gone["local_id"]).toBeNull();
    expect(gone["removed_at"]).not.toBeNull();
    expect((await imported()).filter((row) => row["external_id"] === "c-15")).toHaveLength(0);
  });
});

describe("as sincronizações seguintes", () => {
  it("sem mudança fica quieta; edição no Linear atualiza; edição e remoção aqui são respeitadas; apagado lá ganha missing_since", async () => {
    const team = await firstImport();
    const events = await eventsOf("ticket.comments_imported_from_linear");
    const quiet = await sync();
    expect(quiet.counts).toMatchObject({ commentsCreated: 0, commentsUpdated: 0, commentsKeptEdited: 0, commentsMissing: 0 });
    expect(await eventsOf("ticket.comments_imported_from_linear")).toBe(events);

    const list = team.comments as FakeComment[];
    // c-10 editado só no Linear; c-11 editado nos dois (aqui por API antiga: direto no banco); c-12 removido aqui e editado lá; c-14 apagado lá.
    for (const i of [10, 11, 12]) Object.assign(list[i] as FakeComment, { body: `Editado no Linear ${i}`, editedAt: "2026-11-20T10:00:00.000Z" });
    await q("update ticket_comments set body = 'Editado aqui', edited_at = now() where id = (select local_id from external_item_refs where external_id = 'c-11')");
    await q("update ticket_comments set body = '', removed_at = now(), removed_by_person_id = $1 where id = (select local_id from external_item_refs where external_id = 'c-12')", [h.world().people.admin]);
    team.comments = list.filter((c) => c.id !== "c-14");
    const done = await sync();
    expect(done.counts).toMatchObject({ commentsCreated: 0, commentsUpdated: 1, commentsKeptEdited: 1, commentsMissing: 1 });
    expect(await byExternal("c-10")).toMatchObject({ body: "Editado no Linear 10" });
    expect(((await byExternal("c-10"))["edited_at"] as Date).toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(await byExternal("c-11")).toMatchObject({ body: "Editado aqui" });
    expect(await byExternal("c-12")).toMatchObject({ ref_local: null });
    expect((await byExternal("c-12"))["removed_here_at"]).not.toBeNull();
    expect((await q("select body, removed_at from ticket_comments where id not in (select local_id from external_item_refs where local_id is not null) and via = 'linear'"))[0]).toMatchObject({ body: "" });
    const missing = await byExternal("c-14");
    expect(missing["missing_since"]).not.toBeNull();
    expect(missing["body"]).toBe("Comentário 14");
    expect(await eventsOf("ticket.comments_imported_from_linear")).toBe(events);
  });

  it("projeto importado antes desta fatia recebe os comentários na primeira sincronização", async () => {
    const team = await firstImport([]);
    expect(await imported()).toHaveLength(0);
    team.comments = comments();
    const done = await sync();
    expect(done.counts).toMatchObject({ commentsCreated: 129 });
    expect(await coverage()).toEqual({ total: 129, groups: 3 });
  });

  it("e-mail recusado: nome do Linear; na sincronização em que o e-mail volta, o nome vira a pessoa; pessoa casada nunca volta a nome", async () => {
    await seedPeople();
    let refuse = true;
    const denied = { body: { errors: [{ message: "x", path: ["comments", "nodes", 0, "user", "email"], extensions: { code: "FORBIDDEN" } }] } };
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: comments().slice(0, 8), commentsOverride: (_call, ask) => (refuse && ask.withEmail ? denied : undefined) };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    await finish((await post("", {})).body);
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: null, external_author_name: "Admin no Linear" });
    refuse = false;
    await sync();
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: h.world().people.admin, external_author_name: null });
    refuse = true;
    await sync();
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: h.world().people.admin, external_author_name: null });
  });
});

describe("passos repetidos, duas abas e limite de taxa", () => {
  it("duas abas no mesmo passo e o limite no meio não duplicam nada", async () => {
    await seedPeople();
    let limited = false;
    const team: FakeTeamData = {
      projects: [],
      issues: ISSUES,
      comments: comments(),
      commentsOverride: (_call, ask) => {
        if (ask.after === "50" && !limited) {
          limited = true;
          return { status: 429, headers: { "Retry-After": "30" }, body: {} };
        }
        return undefined;
      },
    };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const run = (await post("", {})).body as RunBody;
    let waited = false;
    for (let i = 0; i < 200; i += 1) {
      const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
      for (const res of [one, two]) expect([200, 409], JSON.stringify(res.body)).toContain(res.status);
      const body = (one.status === 200 ? one.body : two.body) as RunBody;
      if (body.waitUntil) {
        waited = true;
        await q("update external_import_runs set wait_until = null where id = $1", [run.id]);
      }
      if (body.done) break;
    }
    expect(waited).toBe(true);
    expect(await imported()).toHaveLength(129);
    expect((await q("select count(*)::int n from external_item_refs"))[0]!["n"]).toBe(129);
    expect(await coverage()).toEqual({ total: 129, groups: 3 });
  });

  it("o passo repetido depois de gravado (resposta perdida) não grava de novo", async () => {
    await seedPeople();
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: comments() };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const run = (await post("", {})).body as RunBody;
    for (let i = 0; i < 50; i += 1) {
      const res = await post(`/${run.id}/step`);
      if ((res.body as RunBody).phase === "comments") break;
    }
    const before = (await q("select cursor from external_import_runs where id = $1", [run.id]))[0]!["cursor"];
    await post(`/${run.id}/step`);
    // Volta o cursor para o passo já gravado: a origem vista nesta rodada não é revista.
    await q("update external_import_runs set cursor = $2 where id = $1", [run.id, before]);
    await finish(run);
    expect(await imported()).toHaveLength(129);
  });
});

describe("privacidade", () => {
  it("nem o e-mail do autor nem o corpo do comentário vão para log, inclusive em erro", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    await seedPeople();
    let broken = true;
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: comments(), commentsOverride: () => (broken ? { status: 500, body: { errors: [{ message: `${SENTINEL} ${SECRET_BODY}` }] } } : undefined) };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const run = (await post("", {})).body as RunBody;
    for (let i = 0; i < 30; i += 1) {
      const res = await post(`/${run.id}/step`);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
      if ((res.body as RunBody).phase === "comments" || res.status >= 500) break;
    }
    broken = false;
    await finish(run);
    spy.mockRestore();
    vi.restoreAllMocks();
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(lines.join("\n")).not.toContain(SECRET_BODY);
  });
});

// ---- C2: correções da revisão ----

const SHAPE = /sentinela@/i;
describe("C2 item 1: nome em forma de e-mail nunca é guardado nem mostrado", () => {
  it("nos três tipos de autor, na renomeação para e-mail e no criador da issue", async () => {
    await seedPeople();
    const issues: FakeIssue[] = [{ id: "a", identifier: "ENG-1", title: "A", creator: { id: "u-cr", name: "criador.sentinela@linear.test", email: "criador.sentinela@linear.test" } }];
    const list: FakeComment[] = [
      { id: "e-user", issue: "a", user: { id: "u-e1", name: "user.sentinela@linear.test", email: "ninguem@linear.test" } },
      { id: "e-ext", issue: "a", external: "Fora <ext.sentinela@linear.test>" },
      { id: "e-bot", issue: "a", bot: "bot.sentinela@linear.test" },
      { id: "e-ren", issue: "a", user: { id: "u-e2", name: "Renomeada", email: "outra@linear.test" } },
    ];
    const team: FakeTeamData = { projects: [], issues, comments: list };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    await finish((await post("", {})).body);
    expect(await byExternal("e-ren")).toMatchObject({ author_person_id: null, external_author_name: "Renomeada" });
    (list[3] as FakeComment).user = { id: "u-e2", name: "renomeada.sentinela@linear.test", email: "outra@linear.test" };
    await sync();
    for (const id of ["e-user", "e-ext", "e-bot", "e-ren"]) expect(await byExternal(id)).toMatchObject({ author_person_id: null, external_author_name: null });
    const ticket = (await q("select ticket_id from ticket_external_refs where external_id = 'a'"))[0]!["ticket_id"] as string;
    expect((await q("select external_creator_name from ticket_external_refs where external_id = 'a'"))[0]).toEqual({ external_creator_name: null });
    const dump = JSON.stringify(await q("select * from ticket_comments")) + JSON.stringify(await q("select * from external_item_refs")) + JSON.stringify(await q("select * from ticket_external_refs")) + JSON.stringify(await q("select * from tickets")) + JSON.stringify(await q("select * from activity_events")) + JSON.stringify(await q("select * from external_import_runs"));
    expect(dump).not.toMatch(SHAPE);
    const page = await h.call("GET", `/api/tickets/${ticket}`, as("admin"));
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).not.toMatch(SHAPE);
    const activity = await h.call("GET", `/api/tickets/${ticket}/activity?limit=100`, as("admin"));
    expect(activity.status).toBe(200);
    expect(JSON.stringify(activity.body)).not.toMatch(SHAPE);
  });

  it("um criador já gravado em forma de e-mail é trocado por nulo na sincronização seguinte", async () => {
    await seedPeople();
    const issues: FakeIssue[] = [{ id: "a", identifier: "ENG-1", title: "A", creator: { id: "u-cr", name: "Criadora", email: "criadora@linear.test" } }];
    const team: FakeTeamData = { projects: [], issues, comments: [] };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    await finish((await post("", {})).body);
    // Gravado por uma versão anterior (ou pela 0043): o nome era o e-mail.
    await q("update ticket_external_refs set external_creator_name = 'criadora.sentinela@linear.test' where external_id = 'a'");
    (issues[0] as FakeIssue).creator = { id: "u-cr", name: "criadora.sentinela@linear.test", email: "criadora@linear.test" };
    await sync();
    expect((await q("select external_creator_name from ticket_external_refs where external_id = 'a'"))[0]).toEqual({ external_creator_name: null });
  });
});

describe("C2 item 2: texto removido não fica no banco", () => {
  it("a origem não guarda o corpo; remover o pai aqui tira a citação das respostas importadas (sem contar como editado aqui)", async () => {
    await seedPeople();
    const parentBody = "PAI-SENTINELA texto do pai";
    const list: FakeComment[] = [
      { id: "r-1", issue: "a", body: "Resposta um", parent: { id: "p-1", body: parentBody }, createdAt: "2026-03-05T10:02:00.000Z" },
      { id: "r-2", issue: "a", body: "Resposta dois", parent: { id: "p-1", body: parentBody }, createdAt: "2026-03-05T10:01:00.000Z" },
      { id: "p-1", issue: "a", body: parentBody, createdAt: "2026-03-05T10:00:00.000Z" },
    ];
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: list };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    await finish((await post("", {})).body);
    expect(JSON.stringify(await q("select applied from external_item_refs"))).not.toMatch(/PAI-SENTINELA|Resposta/);
    expect((await byExternal("r-1"))["body"]).toMatch(/PAI-SENTINELA/);
    const parent = (await byExternal("p-1"))["id"] as string;
    expect((await h.call("DELETE", `/api/comments/${parent}`, as("admin"))).status).toBe(204);
    for (const id of ["r-1", "r-2"]) expect(await byExternal(id)).toMatchObject({ body: id === "r-1" ? "Resposta um" : "Resposta dois", edited_at: null });
    expect(JSON.stringify(await q("select * from ticket_comments")) + JSON.stringify(await q("select * from external_item_refs"))).not.toMatch(/PAI-SENTINELA/);
    const quiet = await sync();
    expect(quiet.counts).toMatchObject({ commentsKeptEdited: 0, commentsUpdated: 0, commentsCreated: 0 });
    // Editada no Linear depois: acompanha (não foi editada aqui), e sem a citação do pai removido.
    Object.assign(list[0] as FakeComment, { body: "Resposta um editada", editedAt: "2026-11-20T10:00:00.000Z" });
    const edited = await sync();
    expect(edited.counts).toMatchObject({ commentsUpdated: 1, commentsKeptEdited: 0 });
    expect(await byExternal("r-1")).toMatchObject({ body: "Resposta um editada" });
  });

  it("uma resposta que começa com citação própria não perde nada quando um comentário qualquer é removido", async () => {
    await seedPeople();
    const list: FakeComment[] = [
      { id: "s-1", issue: "a", body: "> citação minha\n\nresto" },
      { id: "s-2", issue: "a", body: "outro" },
    ];
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: { projects: [], issues: ISSUES, comments: list } });
    await finish((await post("", {})).body);
    expect((await h.call("DELETE", `/api/comments/${(await byExternal("s-2"))["id"]}`, as("admin"))).status).toBe(204);
    expect((await byExternal("s-1"))["body"]).toBe("> citação minha\n\nresto");
  });
});

describe("C2 item 3: o autor acompanha o casamento atual", () => {
  const people = () => h.world().people;
  async function setup(list: FakeComment[], refuse: { on: boolean }): Promise<void> {
    await seedPeople();
    const denied = { body: { errors: [{ message: "x", path: ["comments", "nodes", 0, "user", "email"], extensions: { code: "FORBIDDEN" } }] } };
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: list, commentsOverride: (_call, ask) => (refuse.on && ask.withEmail ? denied : undefined) };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    await finish((await post("", {})).body);
  }

  it("A: o usuário troca o e-mail no Linear para o de uma pessoa → a pessoa; deixa de casar → volta ao nome", async () => {
    const list: FakeComment[] = [{ id: "m-1", issue: "a", user: { id: "u-zed", name: "Zed Externo", email: SENTINEL } }];
    await setup(list, { on: false });
    expect(await byExternal("m-1")).toMatchObject({ author_person_id: null, external_author_name: "Zed Externo" });
    (list[0] as FakeComment).user = { id: "u-zed", name: "Zed Externo", email: "admin@exemplo.test" };
    await sync();
    expect(await byExternal("m-1")).toMatchObject({ author_person_id: people().admin, external_author_name: null });
    (list[0] as FakeComment).user = { id: "u-zed", name: "Zed Externo", email: SENTINEL };
    await sync();
    expect(await byExternal("m-1")).toMatchObject({ author_person_id: null, external_author_name: "Zed Externo" });
    expect(JSON.stringify(await q("select applied from external_item_refs"))).toContain("u-zed");
    expect(JSON.stringify(await q("select * from external_item_refs"))).not.toContain(SENTINEL);
  });

  it("B: e-mail duplicado e uma das pessoas é desativada → a outra; e troca de pessoa quando o casamento muda", async () => {
    const list: FakeComment[] = [{ id: "m-2", issue: "a", user: { id: "u-dup", name: "Dup", email: DUP } }];
    await setup(list, { on: false });
    expect(await byExternal("m-2")).toMatchObject({ author_person_id: null, external_author_name: "Dup" });
    await q("update people set active = false where display_name = 'Dup 2'");
    await sync();
    const dup1 = (await q("select id from people where display_name = 'Dup 1'"))[0]!["id"];
    expect(await byExternal("m-2")).toMatchObject({ author_person_id: dup1, external_author_name: null });
    // Pessoa → outra pessoa: o e-mail passa a ser o do admin.
    (list[0] as FakeComment).user = { id: "u-dup", name: "Dup", email: "admin@exemplo.test" };
    await sync();
    expect(await byExternal("m-2")).toMatchObject({ author_person_id: people().admin, external_author_name: null });
  });

  it("rodada com e-mail recusado (duas páginas) não mexe no autor; autor apagado no Linear → os dois nulos", async () => {
    const list = comments().slice(0, 60);
    const refuse = { on: false };
    await setup(list, refuse);
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: people().admin });
    expect(await byExternal("c-56")).toMatchObject({ author_person_id: people().admin });
    expect(await byExternal("c-15")).toMatchObject({ author_person_id: null, external_author_name: "Zed Externo" });
    for (const i of [0, 56]) (list[i] as FakeComment).user = { id: "u-admin", name: "Admin no Linear", email: "ninguem@linear.test" };
    (list[15] as FakeComment).user = { id: "u-zed", name: "Zed Externo", email: "admin@exemplo.test" };
    refuse.on = true;
    await sync();
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: people().admin, external_author_name: null });
    expect(await byExternal("c-56")).toMatchObject({ author_person_id: people().admin, external_author_name: null });
    expect(await byExternal("c-15")).toMatchObject({ author_person_id: null, external_author_name: "Zed Externo" });
    (list[0] as FakeComment).user = null;
    await sync();
    expect(await byExternal("c-0")).toMatchObject({ author_person_id: null, external_author_name: null });
  });
});

describe("C2 item 6: evento gravado com a página", () => {
  it("rodada abandonada depois da 1ª página e sincronizada de novo: todo comentário criado está coberto por um evento, sem contar duas vezes", async () => {
    await seedPeople();
    const team: FakeTeamData = { projects: [], issues: ISSUES, comments: comments() };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const run = (await post("", {})).body as RunBody;
    let res = await post(`/${run.id}/step`);
    for (let i = 0; i < 50 && (res.body as RunBody).phase !== "comments"; i += 1) res = await post(`/${run.id}/step`);
    expect((res.body as RunBody).phase).toBe("comments");
    res = await post(`/${run.id}/step`); // a 1ª página de comentários
    expect((res.body as RunBody).counts).toMatchObject({ commentsCreated: 50 });
    expect((await post(`/${run.id}/abandon`)).status).toBeLessThan(300);
    expect(await coverage()).toEqual({ total: 50, groups: 3 });
    await sync();
    expect(await imported()).toHaveLength(129);
    const total = (await coverage()).total;
    expect(total).toBe(129);
    // A linha do tempo de cada ticket soma as páginas da mesma rodada numa entrada.
    const ticket = (await q("select ticket_id from ticket_external_refs where external_id = 'a'"))[0]!["ticket_id"] as string;
    const entries = ((await h.call("GET", `/api/tickets/${ticket}/activity?limit=100`, as("admin"))).body.entries as Row[]).filter((entry) => entry["type"] === "comments_imported");
    const created = (await q("select count(*)::int n from ticket_comments where ticket_id = $1 and via = 'linear'", [ticket]))[0]!["n"] as number;
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + (entry["count"] as number), 0)).toBe(created);
  });
});

describe("C2 item 4: recusa de e-mail gravada na hora", () => {
  it("passo de comentários que só estoura (e teve o e-mail recusado) termina em erro, mas a rodada já sabe que o e-mail é recusado", async () => {
    await seedPeople();
    const denied = { body: { errors: [{ message: "x", path: ["comments", "nodes", 0, "user", "email"], extensions: { code: "FORBIDDEN" } }] } };
    let calls = 0;
    const team: FakeTeamData = {
      projects: [],
      issues: ISSUES,
      comments: comments(),
      commentsOverride: (_call, ask) => {
        calls += 1;
        return ask.withEmail ? denied : { raw: JSON.stringify({ data: { pad: "x".repeat(4 * 1024 * 1024 + 10) } }) };
      },
    };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const run = (await post("", {})).body as RunBody;
    let res = await post(`/${run.id}/step`);
    for (let i = 0; i < 50 && (res.body as RunBody).phase !== "comments"; i += 1) res = await post(`/${run.id}/step`);
    calls = 0;
    const before = h.linear().calls.length;
    const failed = await post(`/${run.id}/step`);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    // TODA ida ao Linear do passo conta no orçamento de 6: a conferência de acesso (`getTeam`) e 5 leituras.
    expect(h.linear().calls.length - before).toBe(6);
    expect(calls).toBe(5);
    const counts = (await q("select counts from external_import_runs where id = $1", [run.id]))[0]!["counts"] as Record<string, unknown>;
    expect(counts["assigneeEmailUnavailable"]).toBe(true);
  });
});

describe("C2 item 5: Linear hostil não prende a rodada", () => {
  it("ids hostis, cursor começando com @ e datas fora da faixa: a rodada termina, os nós ruins contam em commentsInvalid", async () => {
    await seedPeople();
    const good = (id: string, createdAt?: string): FakeComment => ({ id, issue: "a", body: `ok ${id}`, ...(createdAt ? { createdAt } : {}) });
    const pages: Record<string, { list: FakeComment[]; next: string | null }> = {
      "": { list: [{ id: "x".repeat(201), issue: "a" }, { id: "c-\u0000", issue: "a" }, good("h-1", "1990-01-01T00:00:00.000Z")], next: "@cursor-do-linear" },
      "@cursor-do-linear": { list: [good("h-2", "2999-01-01T00:00:00.000Z"), good("h-3")], next: null },
    };
    const team: FakeTeamData = {
      projects: [],
      issues: ISSUES,
      comments: [],
      commentsOverride: (_call, ask) => {
        const pageOf = pages[ask.after ?? ""];
        if (pageOf === undefined) return { status: 400, body: { errors: [{ message: "cursor inesperado" }] } };
        const nodes = pageOf.list.map((c) => fakeCommentNode(c, ask));
        return { body: { data: { comments: { nodes, pageInfo: { hasNextPage: pageOf.next !== null, endCursor: pageOf.next } } } } };
      },
    };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const before = Date.now();
    const done = await finish((await post("", {})).body);
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ commentsCreated: 3, commentsInvalid: 2 });
    for (const id of ["h-1", "h-2"]) expect(((await byExternal(id))["created_at"] as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(((await byExternal("h-3"))["created_at"] as Date).toISOString()).toBe("2026-03-05T10:00:00.000Z");
  });
});
