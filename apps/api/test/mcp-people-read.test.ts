/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { personLink } from "@treepm/domain";
import { activityEntrySchema } from "../src/tickets/ticket-activity.schema.js";
import { HISTORY_FIELDS } from "../src/mcp/mcp-people-read.js";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { openGeneral, openTicket, post } from "./chat-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0062, fatia 3 (TREEPM-495): list_comments, get_ticket_history, list_conversations e get_conversation. Só leitura, só com o
// alcance "pessoas e conversas" efetivo, sempre pelas mesmas leituras que a tela usa e com o Principal da dona do token.
const h = useMcpHarness();
const chat = h as any; // o auxiliar de conversa pede o `Harness`; o mesmo `call`, `pool` e `world` servem
const priv = () => h.world().projects.priv;
const P = () => h.world().people;
const TOOLS = ["list_comments", "get_ticket_history", "list_conversations", "get_conversation"];
const NAMES: Record<string, string> = { admin: "Zelda Quimera", manager: "Orfeu Calcanhotto", contributor: "Brunilda Tamanduá", reader: "Xerxes Pimenteira", plain: "Ulisses Ventania", teamAdmin: "Hortência Bambolê", target: "Cássio Trovoada" };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function keys(on: { people?: boolean; mcp?: boolean } = {}): Promise<void> {
  await h.pool.query("update organizations set mcp_enabled = $2, mcp_write_enabled = true, mcp_people_enabled = $3 where org_id = $1", [ORG, on.mcp ?? true, on.people ?? true]);
}
async function setup(opts: { who?: Who; scope?: "read" | "write"; people?: boolean; orgPeople?: boolean } = {}): Promise<{ token: string; id: string }> {
  await seedProject(h.pool, priv(), P().manager, P().contributor);
  for (const [who, name] of Object.entries(NAMES)) await h.pool.query("update people set display_name = $2 where org_id = $1 and clerk_user_id = $3", [ORG, name, `u_${who}`]);
  await keys({ people: true });
  const res = await h.create(opts.who ?? "contributor", priv(), { scope: opts.scope ?? "read", people: opts.people ?? true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (opts.orgPeople === false) await keys({ people: false });
  return { token: res.body.token as string, id: res.body.id as string };
}
const names = async (token: string) => ((await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;
const ticketId = async (number: number): Promise<string> => (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), number]))[0]?.["id"] as string;
const comment = async (number: number, by: string, body: string, extra: { via?: string; removed?: boolean; edited?: boolean; at?: string } = {}): Promise<string> => {
  const id = (
    await h.rows(
      "insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, via, created_at) select $1, project_id, id, $2, $3, $4, coalesce($6::timestamptz, now()) from tickets where project_id = $5 and number = $7 returning id",
      [ORG, by, body, extra.via ?? null, priv(), extra.at ?? null, number],
    )
  )[0]?.["id"] as string;
  if (extra.removed) await h.pool.query("update ticket_comments set body = '', removed_at = now(), removed_by_person_id = $2 where id = $1", [id, by]);
  if (extra.edited) await h.pool.query("update ticket_comments set edited_at = now() where id = $1", [id]);
  return id;
};
let tick = 0;
/** Cada evento ganha um instante próprio e crescente: a ordem da linha do tempo não depende do relógio. */
const event = async (number: number, actor: string | null, kind: string, payload: Record<string, unknown>): Promise<void> => {
  tick += 1;
  await h.pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload, occurred_at) values ($1,$2,$3,'ticket',$4,$5, '2026-01-01T00:00:00Z'::timestamptz + ($6 || ' seconds')::interval)", [ORG, actor, kind, await ticketId(number), JSON.stringify(payload), String(tick)]);
};
const call = (token: string, name: string, args: Record<string, unknown> = {}) => h.tool(token, "PRIV", name, args);

// Revisão de segurança da fatia 3 (M6): um valor hostil plantado em cada campo de texto livre, e o que nunca pode sair dele.
const hostile = (): string => `Jur [@x@y.test](person:${P().target})`;
const CLEANED = (): string => `Jur @${NAMES["target"]}`;
const expectNoLeak = (raw: string): void => {
  for (const needle of [P().target, "x@y.test", "person:"]) expect(raw, needle).not.toMatch(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
};
const randomUuid = (): string => crypto.randomUUID();
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Espia o log: cursor forjado é entrada inválida, não falha do servidor. */
function spyErrors(): { errors: () => number; restore: () => void } {
  const spies = (["error", "warn"] as const).flatMap((m) => [vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined), vi.spyOn(Logger, m).mockImplementation(() => undefined)]);
  return { errors: () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0), restore: () => spies.forEach((spy) => spy.mockRestore()) };
}
/** O tempo (ms) de uma chamada. */
async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

describe("o alcance: as quatro ferramentas só existem com pessoas e conversas efetivo", () => {
  const cases: { orgPeople: boolean; scope: "read" | "write"; people: boolean; mcp?: boolean }[] = [];
  for (const orgPeople of [false, true]) for (const scope of ["read", "write"] as const) for (const people of [false, true]) cases.push({ orgPeople, scope, people });
  it.each(cases)("chave de pessoas=$orgPeople, token $scope com pessoas=$people", async (c) => {
    const { token } = await setup({ scope: c.scope, people: c.people, orgPeople: c.orgPeople });
    const listed = await names(token);
    for (const name of TOOLS) expect(listed.includes(name), name).toBe(c.people && c.orgPeople);
    if (!(c.people && c.orgPeople)) {
      for (const [name, args] of [["list_comments", { key: "PRIV-3" }], ["get_ticket_history", { key: "PRIV-3" }], ["list_conversations", {}], ["get_conversation", { id: P().manager }]] as const) {
        const res = await call(token, name, { ...args });
        expect(refused(res), name).toBe(true);
        expect(JSON.stringify(res.raw), name).toMatch(/not found/i);
      }
    }
  });
  it("o token só de leitura com pessoas já enxerga as quatro (nenhuma é de escrita)", async () => {
    const { token } = await setup({ scope: "read", people: true });
    expect(await names(token)).toEqual(expect.arrayContaining(TOOLS));
    expect(await names(token)).not.toContain("add_comment");
  });
  it("a chave de pessoas desligada depois de criado o token corta na chamada seguinte; a chave geral desligada responde 403", async () => {
    const { token } = await setup();
    await comment(3, P().reader, "texto qualquer");
    expect((await call(token, "list_comments", { key: "PRIV-3" })).isError).toBe(false);
    await keys({ people: false });
    expect(refused(await call(token, "list_comments", { key: "PRIV-3" }))).toBe(true);
    await keys({ people: true, mcp: false });
    expect((await call(token, "list_comments", { key: "PRIV-3" })).status).toBe(403);
  });
  it("as ferramentas são só de leitura (anotações) e nada grava", async () => {
    const { token } = await setup({ scope: "write" });
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    for (const name of TOOLS) expect(tools.find((t) => t.name === name)?.annotations.readOnlyHint, name).toBe(true);
    const before = (await h.rows("select count(*)::int n from activity_events"))[0]?.["n"];
    await call(token, "list_comments", { key: "PRIV-3" });
    await call(token, "get_ticket_history", { key: "PRIV-3" });
    await call(token, "list_conversations");
    expect((await h.rows("select count(*)::int n from activity_events"))[0]?.["n"]).toBe(before);
  });
});

describe("list_comments", () => {
  it("do mais antigo ao mais novo, sem removidos, com autor, edição, origem e área", async () => {
    const { token } = await setup();
    const first = await comment(3, P().reader, "primeiro", { at: "2026-01-01T10:00:00Z" });
    await comment(3, P().manager, "removido", { removed: true, at: "2026-01-01T11:00:00Z" });
    const second = await comment(3, P().manager, "segundo pelo MCP", { via: "mcp", edited: true, at: "2026-01-01T12:00:00Z" });
    const res = await call(token, "list_comments", { key: "PRIV-3" });
    expect(res.isError, res.text).toBe(false);
    const items = res.json?.comments as any[];
    expect(items.map((c) => c.id)).toEqual([first, second]);
    expect(items[0]).toMatchObject({ author: { id: P().reader, name: NAMES["reader"] }, body: "primeiro", editedAt: null });
    expect(items[0].createdAt).toBe("2026-01-01T10:00:00.000Z");
    expect(items[0].via).toBeUndefined();
    expect(items[1]).toMatchObject({ author: { id: P().manager, name: NAMES["manager"] }, via: "mcp" });
    expect(items[1].editedAt).not.toBeNull();
    expect(res.json?.next).toBeNull();
    expect(JSON.stringify(res.raw)).not.toContain("removido");
  });
  it("comentário de área traz o nome da área; o da contribuição apagada, o nome guardado", async () => {
    const { token } = await setup();
    const area = (await h.rows("insert into areas (org_id, name) values ($1,'Jurídico') returning id", [ORG]))[0]?.["id"] as string;
    const contribution = (await h.rows("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'texto da área',$5) returning id", [ORG, priv(), await ticketId(3), area, P().manager]))[0]?.["id"] as string;
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, contribution_id) values ($1,$2,$3,$4,'na área',$5)", [ORG, priv(), await ticketId(3), P().manager, contribution]);
    await comment(3, P().manager, "no ticket");
    const items = (await call(token, "list_comments", { key: "PRIV-3" })).json?.comments as any[];
    expect(items.find((c) => c.body === "na área")?.area).toBe("Jurídico");
    expect(items.find((c) => c.body === "no ticket")?.area).toBeUndefined();
  });
  it("menção de pessoa vira @Nome simples, sem uuid; sem nome no Clerk e de outra organização viram o rótulo neutro; ticket fica como a chave", async () => {
    const { token } = await setup();
    await h.pool.query("update people set display_name = 'sem.nome@exemplo.test' where id = $1", [P().plain]);
    const other = (await h.rows("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'u_fora','Pessoa de Fora','fora@outra.test','member') returning id", [OTHER_ORG]))[0]?.["id"] as string;
    const text = `oi ${personLink(P().reader, NAMES["reader"]!)} e ${personLink(P().plain, "sem.nome@exemplo.test")} e ${personLink(other, "Pessoa de Fora")} veja PRIV-2 e #PRIV-4 e [@x](person:${P().target.toUpperCase()})`;
    await comment(3, P().manager, text);
    const res = await call(token, "list_comments", { key: "PRIV-3" });
    const body = (res.json?.comments as any[])[0].body as string;
    expect(body).toBe(`oi @${NAMES["reader"]} e @Unnamed person e @Unnamed person veja PRIV-2 e #PRIV-4 e @${NAMES["target"]}`);
    const raw = JSON.stringify(res.raw);
    for (const needle of [P().reader, P().plain, other, P().target, "sem.nome@exemplo.test", "@exemplo.test", "fora@outra.test", "person:"]) expect(raw, needle).not.toContain(needle);
  });
  it("autor sem nome no Clerk sai como rótulo neutro, sem e-mail", async () => {
    const { token } = await setup();
    await h.pool.query("update people set display_name = email where id = $1", [P().reader]);
    await comment(3, P().reader, "oi");
    const res = await call(token, "list_comments", { key: "PRIV-3" });
    expect((res.json?.comments as any[])[0].author).toEqual({ id: P().reader, name: "Unnamed person" });
    expect(JSON.stringify(res.raw)).not.toContain("@exemplo.test");
  });
  it("paginação: cursor, fim da lista, cursor inválido e cursor de outro ticket", async () => {
    const { token } = await setup();
    for (let i = 1; i <= 5; i += 1) await comment(3, P().reader, `c${i}`, { at: `2026-01-0${i}T10:00:00Z` });
    await comment(1, P().reader, "do outro ticket");
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(token, "list_comments", { key: "PRIV-3", limit: 2, ...(next ? { after: next } : {}) });
      expect(res.isError, res.text).toBe(false);
      seen.push(...(res.json?.comments as any[]).map((c) => c.body));
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 10);
    expect(seen).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(pages).toBe(3);
    const first = (await call(token, "list_comments", { key: "PRIV-3", limit: 2 })).json?.next as string;
    expect((await call(token, "list_comments", { key: "PRIV-3", after: "lixo" })).isError).toBe(true);
    expect((await call(token, "list_comments", { key: "PRIV-3", after: Buffer.from("{}").toString("base64url") })).isError).toBe(true);
    const crossed = await call(token, "list_comments", { key: "PRIV-1", after: first });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/cursor/i);
    expect((await call(token, "list_comments", { key: "PRIV-3", limit: 51 })).isError).toBe(true);
  });
  it("teto de tamanho: comentários grandes cortam a página e o cursor continua dali", async () => {
    const { token } = await setup();
    for (let i = 0; i < 12; i += 1) await comment(3, P().reader, `${String(i).padStart(2, "0")}${"x".repeat(9_900)}`, { at: `2026-02-01T10:${String(i).padStart(2, "0")}:00Z` });
    const bodies: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(token, "list_comments", { key: "PRIV-3", limit: 50, ...(next ? { after: next } : {}) });
      expect(res.text.length).toBeLessThanOrEqual(80_000 + 2_000);
      bodies.push(...(res.json?.comments as any[]).map((c) => (c.body as string).slice(0, 2)));
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 10);
    expect(bodies).toEqual(Array.from({ length: 12 }, (_, i) => String(i).padStart(2, "0")));
    expect(pages).toBeGreaterThan(1);
  });
  it("ticket inexistente, de outro projeto e de projeto que a pessoa não enxerga: a mesma recusa", async () => {
    const { token } = await setup();
    const a = await call(token, "list_comments", { key: "PRIV-99" });
    const b = await call(token, "list_comments", { key: "OPEN-1" });
    expect([a.isError, b.isError]).toEqual([true, true]);
    await h.pool.query("delete from project_memberships where project_id = $1 and person_id = $2", [priv(), P().contributor]);
    const c = await call(token, "list_comments", { key: "PRIV-3" });
    for (const res of [c]) expect(JSON.stringify(res.raw)).not.toContain("primeiro");
  });
  it("paridade com a tela: os mesmos comentários que a rota de atividade devolve à mesma pessoa", async () => {
    const { token } = await setup();
    for (let i = 1; i <= 4; i += 1) await comment(3, i % 2 ? P().reader : P().manager, `comentário ${i}`, { at: `2026-03-0${i}T10:00:00Z`, ...(i === 3 ? { removed: true } : {}) });
    await event(3, P().manager, "ticket.updated", { fields: ["priority"], priority: { from: 0, to: 3 } });
    const id = await ticketId(3);
    const screen: any[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await h.call("GET", `/api/tickets/${id}/activity?limit=2${before ? `&before=${before}` : ""}`, as("contributor"));
      expect(res.status).toBe(200);
      screen.push(...res.body.entries);
      before = res.body.before ?? undefined;
      if (!before) break;
    }
    const shown = screen.filter((e) => e.type === "comment" && !e.removed).map((e) => e.id).reverse();
    const mine = (await call(token, "list_comments", { key: "PRIV-3" })).json?.comments as any[];
    expect(mine.map((c) => c.id)).toEqual(shown);
    expect(shown.length).toBe(3);
  });
});

describe("get_ticket_history", () => {
  /** Um evento de cada tipo que a atividade do ticket conhece, com lixo de propósito nos payloads. */
  async function seedEvery(): Promise<void> {
    const junk = { tokenId: "TOKEN-ID-SECRETO", githubLogin: "gh-login-secreto", githubId: 424242, realPersonId: P().admin, via: "act-as" };
    const area = (await h.rows("insert into areas (org_id, name) values ($1,'Jurídico') returning id", [ORG]))[0]?.["id"] as string;
    const contribution = (await h.rows("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'texto',$5) returning id", [ORG, priv(), await ticketId(3), area, P().manager]))[0]?.["id"] as string;
    const cref = { contributionId: contribution, areaId: area };
    await event(3, P().manager, "ticket.created", { ...junk });
    await event(3, P().manager, "ticket.updated", { ...junk, fields: ["title", "description", "status", "parentId", "priority"], title: { from: "Antes", to: "Depois" }, status: { from: "todo", to: "done" }, automatic: true, causedBy: "PRIV-2", priority: { from: 0, to: 4 }, parentId: { from: null, to: await ticketId(1) } });
    await event(3, P().manager, "ticket.assignee_added", { ...junk, personId: P().reader });
    await event(3, P().manager, "ticket.assignee_removed", { ...junk, personId: P().reader });
    await event(3, P().manager, "ticket.dependency_added", { ...junk, dependsOnTicketId: await ticketId(2), dependsOnKey: "PRIV-2" });
    await event(3, P().manager, "ticket.dependency_removed", { ...junk, dependsOnTicketId: await ticketId(2), dependsOnKey: "PRIV-2" });
    await event(3, P().manager, "ticket.summary_updated", { ...junk, source: "assistant" });
    await event(3, P().manager, "ticket.contribution_added", { ...junk, ...cref });
    await event(3, P().manager, "ticket.contribution_removed", { ...junk, ...cref, areaName: "Jurídico" });
    await event(3, P().manager, "ticket.contribution_updated", { ...junk, ...cref, fields: ["text", "status"], status: { from: "todo", to: "done" } });
    await event(3, P().manager, "ticket.contribution_person_added", { ...junk, ...cref, personId: P().target });
    await event(3, P().manager, "ticket.contribution_person_removed", { ...junk, ...cref, personId: P().target });
    await event(3, P().manager, "ticket.idea_registered", { ...junk });
    await event(3, P().manager, "ticket.idea_stage_changed", { ...junk, from: "new", to: "refining" });
    await event(3, P().manager, "ticket.idea_accepted", { ...junk });
    await event(3, P().manager, "ticket.idea_discarded", { ...junk });
    await event(3, P().manager, "ticket.idea_reopened", { ...junk });
    await event(3, P().manager, "ticket.agent_work_started", { ...junk, until: "2026-05-01T10:00:00.000Z" });
    await event(3, P().manager, "ticket.agent_work_ended", { ...junk, reason: "finished" });
    await comment(3, P().reader, "um comentário");
  }
  const historyAll = async (token: string, args: Record<string, unknown> = {}): Promise<{ entries: any[]; raw: string; pages: number }> => {
    const entries: any[] = [];
    const raws: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(token, "get_ticket_history", { key: "PRIV-3", ...args, ...(next ? { after: next } : {}) });
      expect(res.isError, res.text).toBe(false);
      raws.push(res.text);
      entries.push(...(res.json?.events as any[]));
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 20);
    return { entries, raw: raws.join("\n"), pages };
  };

  it("um evento de cada tipo: só o que pode sair, sem login do GitHub, sem tokenId, sem administrador real, sem uuid interno", async () => {
    const { token } = await setup();
    await seedEvery();
    const { entries, raw } = await historyAll(token, { limit: 50 });
    const kinds = new Set(entries.map((e) => e.kind));
    for (const kind of ["created", "title_changed", "description_changed", "status_changed", "priority_changed", "parent_changed", "assignee_added", "assignee_removed", "dependency_added", "dependency_removed", "summary_updated", "contribution_added", "contribution_removed", "contribution_text_changed", "contribution_status_changed", "contribution_person_added", "contribution_person_removed", "agent_work_started", "agent_work_ended", "idea_registered", "idea_stage_changed", "idea_accepted", "idea_discarded", "idea_reopened", "comment"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    for (const needle of ["TOKEN-ID-SECRETO", "gh-login-secreto", "424242", "githubLogin", "tokenId", "realPersonId", "act-as", P().admin, NAMES["admin"]!, "@exemplo.test"]) expect(raw, needle).not.toContain(needle);
    // Só uuid de pessoa (autor de evento e pessoa afetada) pode aparecer.
    const ids = new Set(raw.match(new RegExp(UUID.source, "gi")) ?? []);
    for (const id of ids) expect([P().manager, P().reader, P().target], id).toContain(id);
    const status = entries.find((e) => e.kind === "status_changed");
    expect(status).toMatchObject({ from: "todo", to: "done", automatic: true, causedBy: "PRIV-2", actor: { id: P().manager, name: NAMES["manager"] } });
    expect(entries.find((e) => e.kind === "parent_changed")).toMatchObject({ from: null, to: "PRIV-1" });
    expect(entries.find((e) => e.kind === "assignee_added")?.person).toEqual({ id: P().reader, name: NAMES["reader"] });
    expect(entries.find((e) => e.kind === "dependency_added")?.ticket).toBe("PRIV-2");
    expect(entries.find((e) => e.kind === "contribution_status_changed")).toMatchObject({ area: "Jurídico", from: "todo", to: "done" });
    expect(entries.find((e) => e.kind === "title_changed")).toMatchObject({ from: "Antes", to: "Depois" });
    for (const e of entries) expect(typeof e.at).toBe("string");
    expect(entries.find((e) => e.kind === "comment")).not.toHaveProperty("body");
  });
  it("evento feito em 'entrar como' mostra só o ator exibido; o administrador real não sai", async () => {
    const { token } = await setup();
    await event(3, P().manager, "ticket.updated", { fields: ["priority"], priority: { from: 0, to: 2 }, via: "act-as", realPersonId: P().admin });
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, via, via_person_id) values ($1,$2,$3,$4,'feito por outro',$5,$6)", [ORG, priv(), await ticketId(3), P().manager, "act-as", P().admin]);
    const history = await historyAll(token);
    const comments = await call(token, "list_comments", { key: "PRIV-3" });
    for (const text of [history.raw, comments.text]) {
      expect(text).not.toContain(P().admin);
      expect(text).not.toContain(NAMES["admin"]!);
      expect(text).not.toContain("act-as");
    }
    expect(history.entries.find((e) => e.kind === "priority_changed")?.actor).toEqual({ id: P().manager, name: NAMES["manager"] });
    expect((comments.json?.comments as any[])[0].author).toEqual({ id: P().manager, name: NAMES["manager"] });
  });
  it("evento de tipo desconhecido não entra; o que a tela mostra com campos extras sai só com a lista do tipo", async () => {
    const { token } = await setup();
    await event(3, P().manager, "ticket.priority_boosted", { githubLogin: "gh-login-secreto" });
    await event(3, P().manager, "ticket.idea_accepted", { githubLogin: "gh-login-secreto", extra: "campo novo" });
    const { entries, raw } = await historyAll(token);
    // A tela também mostra o "criado" do ticket que não tem evento de criação (entrada sintética).
    expect(entries.map((e) => e.kind)).toEqual(["idea_accepted", "created"]);
    expect(entries[0]).toEqual({ at: expect.any(String), kind: "idea_accepted", actor: { id: P().manager, name: NAMES["manager"] } });
    expect(raw).not.toContain("gh-login-secreto");
    expect(raw).not.toContain("campo novo");
  });
  it("estrutural: todo tipo de entrada da atividade tem uma entrada na lista do que pode sair", () => {
    const types = (activityEntrySchema as any).options.map((option: any) => option.shape.type.value as string);
    expect(types.length).toBeGreaterThan(20);
    expect(Object.keys(HISTORY_FIELDS).sort()).toEqual([...types].sort());
  });
  it("paginação por cursor, cursor inválido e cursor de outro ticket", async () => {
    const { token } = await setup();
    for (let i = 1; i <= 7; i += 1) await event(3, P().manager, "ticket.updated", { fields: ["priority"], priority: { from: i - 1, to: i } });
    await event(1, P().manager, "ticket.idea_accepted", {});
    const { entries, pages } = await historyAll(token, { limit: 3 });
    expect(entries.filter((e) => e.kind === "priority_changed").map((e) => e.to)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
    const cursor = (await call(token, "get_ticket_history", { key: "PRIV-3", limit: 3 })).json?.next as string;
    expect((await call(token, "get_ticket_history", { key: "PRIV-3", after: "lixo" })).isError).toBe(true);
    expect((await call(token, "get_ticket_history", { key: "PRIV-1", after: cursor })).isError).toBe(true);
    expect((await call(token, "get_ticket_history", { key: "PRIV-99" })).isError).toBe(true);
  });
  it("paridade com a tela: a mesma sequência de entradas que a rota de atividade devolve", async () => {
    const { token } = await setup();
    await seedEvery();
    const id = await ticketId(3);
    const screen: any[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const res = await h.call("GET", `/api/tickets/${id}/activity?limit=4${before ? `&before=${before}` : ""}`, as("contributor"));
      screen.push(...res.body.entries);
      before = res.body.before ?? undefined;
      if (!before) break;
    }
    const { entries } = await historyAll(token, { limit: 4 });
    expect(entries.map((e) => e.kind)).toEqual(screen.map((e) => e.type));
    expect(entries.map((e) => e.at)).toEqual(screen.map((e) => e.occurredAt));
  });
  it("quem foi removido da organização some do ator e continua sem e-mail", async () => {
    const { token } = await setup();
    await h.pool.query("update people set display_name = email where id = $1", [P().target]);
    await event(3, P().target, "ticket.idea_accepted", {});
    const { entries, raw } = await historyAll(token);
    expect(entries[0].actor).toEqual({ id: P().target, name: "Unnamed person" });
    expect(raw).not.toContain("@exemplo.test");
  });
  it("M6: título, área e nome de área guardado passam pelo limpador; causedBy e dependsOnKey fora do formato de chave são omitidos", async () => {
    const { token } = await setup();
    const area = (await h.rows("insert into areas (org_id, name) values ($1,$2) returning id", [ORG, hostile()]))[0]?.["id"] as string;
    const contribution = (await h.rows("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'texto',$5) returning id", [ORG, priv(), await ticketId(3), area, P().manager]))[0]?.["id"] as string;
    await event(3, P().manager, "ticket.updated", { fields: ["title", "status"], title: { from: hostile(), to: hostile() }, status: { from: "todo", to: "done" }, automatic: true, causedBy: hostile() });
    await event(3, P().manager, "ticket.dependency_added", { dependsOnTicketId: randomUuid(), dependsOnKey: hostile() });
    await event(3, P().manager, "ticket.contribution_added", { contributionId: contribution, areaId: area });
    await event(3, P().manager, "ticket.contribution_removed", { contributionId: randomUuid(), areaId: randomUuid(), areaName: hostile() });
    const { entries, raw } = await historyAll(token, { limit: 50 });
    expectNoLeak(raw);
    expect(entries.find((e) => e.kind === "title_changed")).toMatchObject({ from: CLEANED(), to: CLEANED() });
    expect(entries.find((e) => e.kind === "contribution_added")?.area).toBe(CLEANED());
    expect(entries.find((e) => e.kind === "contribution_removed")?.area).toBe(CLEANED());
    const status = entries.find((e) => e.kind === "status_changed");
    expect(status).toMatchObject({ from: "todo", to: "done" });
    expect(status).not.toHaveProperty("causedBy");
    const dependency = entries.find((e) => e.kind === "dependency_added");
    expect(dependency).toBeDefined();
    expect(dependency).not.toHaveProperty("ticket");
  });
  it("M6: todo cursor emitido paginando de um em um é aceito; cursores forjados respondem 'Invalid cursor.' sem log de erro", async () => {
    const { token } = await setup();
    await seedEvery();
    // Todo cursor que a ferramenta emite, de um em um até o fim, é aceito pelo esquema estrito.
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(token, "get_ticket_history", { key: "PRIV-3", limit: 1, ...(next ? { after: next } : {}) });
      expect(res.isError, res.text).toBe(false);
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 60);
    expect(next).toBeNull();
    expect(pages).toBeGreaterThan(20);
    const real = JSON.parse(Buffer.from((await call(token, "get_ticket_history", { key: "PRIV-3", limit: 1 })).json?.next as string, "base64url").toString()) as { k: string; t: string; b: string };
    const inner = JSON.parse(Buffer.from(real.b, "base64url").toString()) as { t: number; e: string; s: number };
    const forged = [
      { ...inner, t: 9e15 },
      { ...inner, t: -1e15 },
      { ...inner, e: "x" },
      { ...inner, t: "x" },
      { ...inner, s: 1e15 },
      { ...inner, extra: 1 },
    ].map((value) => b64({ ...real, b: b64(value) }));
    const log = spyErrors();
    try {
      for (const after of forged) {
        const res = await call(token, "get_ticket_history", { key: "PRIV-3", after });
        expect(res.isError, after).toBe(true);
        expect(res.text, after).toBe("Invalid cursor.");
      }
      expect(log.errors()).toBe(0);
    } finally {
      log.restore();
    }
  });
  it("M6: um único evento maior que o teto sai cortado, com a marca de corte, e a resposta cabe no teto", async () => {
    const { token } = await setup();
    const giant = `${"t".repeat(60_000)} ${personLink(P().target, "x@y.test")} ${"u".repeat(60_000)}`;
    await event(3, P().manager, "ticket.updated", { fields: ["title"], title: { from: giant, to: giant } });
    const res = await call(token, "get_ticket_history", { key: "PRIV-3", limit: 1 });
    expect(res.isError, res.text.slice(0, 200)).toBe(false);
    expect(res.text.length).toBeLessThanOrEqual(80_000);
    const first = (res.json?.events as any[])[0];
    expect(first).toMatchObject({ kind: "title_changed", truncated: true });
    expectNoLeak(res.text);
    expect(res.json?.next).not.toBeNull();
  });
});

describe("conversas", () => {
  const sql = (q: string, p: unknown[] = []) => h.rows(q, p);
  async function seedMessage(conv: string, by: string | null, body: string, model: string | null = by === null ? "m" : null): Promise<string> {
    return (await sql("insert into conversation_messages (org_id, conversation_id, author_person_id, body, model) values ($1,$2,$3,$4,$5) returning id", [ORG, conv, by, body, model]))[0]?.["id"] as string;
  }
  async function world() {
    const out = await setup({ scope: "read" });
    const t3 = await ticketId(3);
    const main = await openTicket(chat, "contributor", t3);
    await seedMessage(main, P().contributor, "pergunta da dona");
    await seedMessage(main, null, "resposta do assistente");
    const thread = (await post(chat, "contributor", main, `para ${personLink(P().reader, NAMES["reader"]!)} ver PRIV-2`, [P().reader])).body.thread.id as string;
    await post(chat, "reader", thread, "resposta do Xerxes");
    // Conversa de outra pessoa no mesmo ticket, nunca visível à dona do token.
    const others = await openTicket(chat, "manager", t3);
    await seedMessage(others, P().manager, "SEGREDO-DO-GESTOR");
    // Meu chat da dona, com uma thread que cita um ticket do projeto.
    const general = await openGeneral(chat, "contributor");
    await seedMessage(general, P().contributor, "SEGREDO-DO-MEU-CHAT PRIV-3");
    const generalThread = (await post(chat, "contributor", general, "thread no Meu chat sobre PRIV-3", [P().reader], t3)).body.thread.id as string;
    // Outro projeto.
    await sql("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'manager') on conflict do nothing", [ORG, h.world().projects.org, P().contributor]);
    const openTicketId = (await sql("insert into tickets (org_id, project_id, number, title, description, status, created_by_person_id) values ($1,$2,1,'Aberto','', 'todo', $3) returning id", [ORG, h.world().projects.org, P().manager]))[0]?.["id"] as string;
    const elsewhere = await openTicket(chat, "contributor", openTicketId);
    await seedMessage(elsewhere, P().contributor, "SEGREDO-DE-OUTRO-PROJETO");
    return { ...out, t3, main, thread, others, general, generalThread, elsewhere };
  }
  const listAll = async (token: string): Promise<any[]> => {
    const items: any[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(token, "list_conversations", { limit: 2, ...(next ? { after: next } : {}) });
      expect(res.isError, res.text).toBe(false);
      items.push(...(res.json?.conversations as any[]));
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 20);
    return items;
  };

  it("lista só as conversas do projeto do token de que a dona participa; Meu chat, outro projeto e conversa alheia ficam fora", async () => {
    const w = await world();
    const items = await listAll(w.token);
    expect(items.map((c) => c.id).sort()).toEqual([w.main, w.thread].sort());
    const main = items.find((c) => c.id === w.main);
    expect(main).toMatchObject({ kind: "ticket", ticket: "PRIV-3", closed: false, participants: [{ id: P().contributor, name: NAMES["contributor"] }] });
    expect(main.parentId).toBeUndefined();
    const thread = items.find((c) => c.id === w.thread);
    expect(thread).toMatchObject({ kind: "thread", parentId: w.main, closed: false });
    expect(thread.participants.map((p: any) => p.id).sort()).toEqual([P().contributor, P().reader].sort());
    expect(thread.title).toBe(`@${NAMES["reader"]} ver PRIV-2`.replace(/^/, "para ").trim());
    expect(typeof thread.lastMessageAt).toBe("string");
    const raw = JSON.stringify(items);
    for (const needle of ["SEGREDO-DO-GESTOR", "SEGREDO-DO-MEU-CHAT", "SEGREDO-DE-OUTRO-PROJETO", w.others, w.general, w.generalThread, w.elsewhere, "person:", "@exemplo.test"]) expect(raw, needle).not.toContain(needle);
  });
  it("inclui as que a dona fechou, marcadas com closed: true", async () => {
    const w = await world();
    expect((await h.call("POST", `/api/conversations/${w.thread}/close`, as("contributor"))).status).toBe(200);
    const items = await listAll(w.token);
    expect(items.find((c) => c.id === w.thread)?.closed).toBe(true);
    expect(items.find((c) => c.id === w.main)?.closed).toBe(false);
  });
  it("thread de Meu chat nunca aparece, nem lida pelo id, mesmo citando ticket do projeto", async () => {
    const w = await world();
    const same = await call(w.token, "get_conversation", { id: w.generalThread });
    const general = await call(w.token, "get_conversation", { id: w.general });
    const other = await call(w.token, "get_conversation", { id: w.others });
    const elsewhere = await call(w.token, "get_conversation", { id: w.elsewhere });
    const missing = await call(w.token, "get_conversation", { id: "00000000-0000-4000-8000-0000000000aa" });
    for (const res of [same, general, other, elsewhere, missing]) expect(res.isError).toBe(true);
    expect(new Set([same.text, general.text, other.text, elsewhere.text, missing.text]).size).toBe(1);
    expect((await call(w.token, "get_conversation", { id: "nao-e-uuid" })).isError).toBe(true);
  });
  it("outra pessoa da mesma organização, com token e alcance, não lê as conversas privadas da primeira", async () => {
    const w = await world();
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'contributor') on conflict do nothing", [ORG, priv(), P().manager]);
    const res = await h.create("manager", priv(), { scope: "read", people: true });
    expect(res.status).toBe(201);
    const mine = await call(res.body.token as string, "list_conversations");
    const ids = (mine.json?.conversations as any[]).map((c) => c.id);
    expect(ids).toContain(w.others);
    expect(ids).not.toContain(w.main);
    expect(ids).not.toContain(w.thread);
    for (const id of [w.main, w.thread]) expect((await call(res.body.token as string, "get_conversation", { id })).isError).toBe(true);
    expect(JSON.stringify(mine.raw)).not.toContain("pergunta da dona");
  });
  it("thread em que a pessoa não está: nem lista nem lê", async () => {
    const w = await world();
    const hidden = (await post(chat, "contributor", w.main, "só entre nós", [P().target])).body.thread.id as string;
    const reader = (await h.create("reader", priv(), { scope: "read", people: true })).body.token as string;
    const items = (await call(reader, "list_conversations")).json?.conversations as any[];
    expect(items.map((c) => c.id)).toContain(w.thread);
    expect(items.map((c) => c.id)).not.toContain(hidden);
    expect((await call(reader, "get_conversation", { id: hidden })).isError).toBe(true);
    expect((await call(reader, "get_conversation", { id: w.main })).isError, "a de cima também fica fora para quem não participa").toBe(true);
    // E o parentId da thread dela não mostra a conversa de cima que ela não lê.
    const mine = items.find((c) => c.id === w.thread);
    expect(mine.parentId).toBeUndefined();
  });
  it("organização B: outra organização nunca lê", async () => {
    const w = await world();
    const other = await h.issueOther();
    const res = await h.tool(other.token, "OTHERKEY", "list_conversations");
    expect(JSON.stringify(res.raw)).not.toContain(w.main);
    const crossing = await h.tool(other.token, "OTHERKEY", "get_conversation", { id: w.main });
    expect(JSON.stringify(crossing.raw)).not.toContain("pergunta da dona");
  });
  it("get_conversation: mensagens do mais antigo ao mais novo, assistente marcado, marcador sem texto, menções limpas", async () => {
    const w = await world();
    await sql("insert into conversation_messages (org_id, conversation_id, body) values ($1,$2,$3)", [ORG, w.main, "[creation_opened:00000000-0000-4000-8000-0000000000bb]\nPedido que NÃO deve sair"]);
    await seedMessage(w.main, P().contributor, `oi ${personLink(P().target, "Cássio")} e ${personLink(P().plain, "x@exemplo.test")} veja PRIV-2`);
    const res = await call(w.token, "get_conversation", { id: w.main });
    expect(res.isError, res.text).toBe(false);
    const messages = res.json?.messages as any[];
    // A mensagem que abriu a thread (a terceira) também aparece na conversa de cima, como na tela.
    expect(messages.map((m) => m.kind)).toEqual(["message", "message", "message", "creation_opened", "message"]);
    expect(messages[0]).toMatchObject({ author: { id: P().contributor, name: NAMES["contributor"] }, body: "pergunta da dona" });
    expect(messages[1]).toMatchObject({ author: "assistant", body: "resposta do assistente" });
    expect(messages[3]).toMatchObject({ author: "assistant" });
    expect(messages[3].body).toBeUndefined();
    expect(messages[4].body).toBe(`oi @${NAMES["target"]} e @${NAMES["plain"]} veja PRIV-2`);
    expect(res.json?.conversation).toMatchObject({ id: w.main, kind: "ticket", ticket: "PRIV-3", closed: false });
    const raw = JSON.stringify(res.raw);
    for (const needle of ["Pedido que NÃO", "creation_opened:", P().target, P().plain, "person:", "@exemplo.test"]) expect(raw, needle).not.toContain(needle);
    // A mensagem que abriu a thread também faz parte da thread.
    const threadRes = await call(w.token, "get_conversation", { id: w.thread });
    expect((threadRes.json?.messages as any[]).map((m) => m.body)).toEqual([`para @${NAMES["reader"]} ver PRIV-2`, "resposta do Xerxes"]);
  });
  it("get_conversation: paginação por cursor, cursor inválido e de outra conversa", async () => {
    const w = await world();
    for (let i = 1; i <= 5; i += 1) await seedMessage(w.thread, P().reader, `t${i}`);
    const bodies: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(w.token, "get_conversation", { id: w.thread, limit: 3, ...(next ? { after: next } : {}) });
      expect(res.isError, res.text).toBe(false);
      bodies.push(...(res.json?.messages as any[]).map((m) => m.body));
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 10);
    expect(bodies).toEqual([`para @${NAMES["reader"]} ver PRIV-2`, "resposta do Xerxes", "t1", "t2", "t3", "t4", "t5"]);
    expect(pages).toBe(3);
    const cursor = (await call(w.token, "get_conversation", { id: w.thread, limit: 2 })).json?.next as string;
    expect((await call(w.token, "get_conversation", { id: w.thread, after: "lixo" })).isError).toBe(true);
    const crossed = await call(w.token, "get_conversation", { id: w.main, after: cursor });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/cursor/i);
    expect((await call(w.token, "list_conversations", { after: "lixo" })).isError).toBe(true);
  });
  it("paridade com a tela: as mesmas mensagens que a rota da conversa devolve à mesma pessoa", async () => {
    const w = await world();
    for (let i = 1; i <= 6; i += 1) await seedMessage(w.thread, i % 2 ? P().reader : P().contributor, `m${i}`);
    const screen: any[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await h.call("GET", `/api/conversations/${w.thread}?limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}`, as("contributor"));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      screen.push(...res.body.messages.items);
      before = res.body.messages.nextBefore ?? undefined;
      if (!before) break;
    }
    const mine: any[] = [];
    let next: string | null = null;
    do {
      const res = await call(w.token, "get_conversation", { id: w.thread, limit: 4, ...(next ? { after: next } : {}) });
      mine.push(...(res.json?.messages as any[]));
      next = res.json?.next as string | null;
    } while (next !== null);
    expect(mine.map((m) => m.id)).toEqual(screen.map((m) => m.id).reverse());
    // A lista também: as conversas do projeto que a árvore da tela mostra à mesma pessoa.
    // O Meu chat (primeiro item) e o que está debaixo dele ficam fora do MCP, mesmo citando ticket do projeto.
    const tree = ((await h.call("GET", "/api/conversations", as("contributor"))).body.items as any[]).filter((n) => n.kind !== "general");
    const flat = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
    const onScreen = flat(tree).flatMap((n) => (n.id && n.ticket?.key?.startsWith("PRIV-") ? [n.id] : []));
    const listed = (await listAll(w.token)).map((c) => c.id);
    expect(listed.sort()).toEqual(onScreen.sort());
  });
  it("pessoa que perdeu o acesso ao projeto não lê mais as conversas dele", async () => {
    const w = await world();
    await h.pool.query("delete from project_memberships where project_id = $1 and person_id = $2", [priv(), P().contributor]);
    const list = await call(w.token, "list_conversations");
    const get = await call(w.token, "get_conversation", { id: w.main });
    expect(JSON.stringify([list.raw, get.raw])).not.toContain("pergunta da dona");
  });
  it("teto de tamanho: mensagens grandes cortam a página e o cursor continua dali", async () => {
    const w = await world();
    for (let i = 0; i < 30; i += 1) await seedMessage(w.main, P().contributor, `${String(i).padStart(2, "0")}${"y".repeat(3_900)}`);
    let next: string | null = null;
    let pages = 0;
    let count = 0;
    do {
      const res = await call(w.token, "get_conversation", { id: w.main, limit: 50, ...(next ? { after: next } : {}) });
      expect(res.text.length).toBeLessThanOrEqual(80_000 + 2_000);
      count += (res.json?.messages as any[]).length;
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 10);
    expect(count).toBe(33);
    expect(pages).toBeGreaterThan(1);
  });
  it("thread de criação aberta: sai o estado e o título que a barra mostra; nunca a descrição do rascunho nem o id da conversa de ticket", async () => {
    const w = await world();
    const opening = await seedMessage(w.main, P().contributor, "Faça um ticket sobre SEGREDO-DO-PEDIDO");
    const draft = (await sql("insert into ticket_conversations (org_id, project_id, author_person_id, status, draft_title, draft_description) values ($1,$2,$3,'open','Título visível na barra','Descrição SEGREDO-DO-RASCUNHO') returning id", [ORG, priv(), P().contributor]))[0]?.["id"] as string;
    const threadId = (await sql("with t as (insert into conversations (org_id, id, kind, purpose, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id, ticket_conversation_id) select org_id, app_uuid_v7(), 'thread', 'creation', owner_person_id, project_id, ticket_id, id, root_id, 1, $2, $4 from conversations where id = $1 returning id, org_id), p as (insert into conversation_participants (org_id, conversation_id, person_id) select org_id, id, $3::uuid from t) select id from t", [w.main, opening, P().contributor, draft]))[0]?.["id"] as string;
    const created = (await listAll(w.token)).find((c) => c.id === threadId);
    expect(created).toMatchObject({ kind: "thread", purpose: "creation", creation: { state: "draft" }, parentId: w.main, title: "Título visível na barra" });
    const raw = JSON.stringify((await call(w.token, "get_conversation", { id: threadId })).raw) + JSON.stringify(created);
    // A mensagem que abriu a thread é uma mensagem comum da pessoa (também está na conversa de cima); o rascunho em si não sai.
    for (const needle of ["SEGREDO-DO-RASCUNHO", draft]) expect(raw, needle).not.toContain(needle);
  });
  it("thread de criação descartada some da lista, como da barra", async () => {
    const w = await world();
    const opening = await seedMessage(w.main, P().contributor, "Faça um ticket sobre SEGREDO-DO-PEDIDO");
    const threadId = (await sql("with t as (insert into conversations (org_id, id, kind, purpose, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) select org_id, app_uuid_v7(), 'thread', 'creation', owner_person_id, project_id, ticket_id, id, root_id, 1, $2 from conversations where id = $1 returning id, org_id), p as (insert into conversation_participants (org_id, conversation_id, person_id) select org_id, id, $3::uuid from t) select id from t", [w.main, opening, P().contributor]))[0]?.["id"] as string;
    expect((await listAll(w.token)).find((c) => c.id === threadId)).toBeUndefined();
    expect((await call(w.token, "get_conversation", { id: threadId })).isError).toBe(true);
  });
  /** Uma thread de criação pendurada em `parent`, com o rascunho dado (opcional). */
  const creationThread = async (parent: string, opening: string, draft: string | null): Promise<string> =>
    (await sql("with t as (insert into conversations (org_id, id, kind, purpose, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id, ticket_conversation_id) select org_id, app_uuid_v7(), 'thread', 'creation', owner_person_id, project_id, ticket_id, id, root_id, 1, $2, $4 from conversations where id = $1 returning id, org_id), p as (insert into conversation_participants (org_id, conversation_id, person_id) select org_id, id, $3::uuid from t) select id from t", [parent, opening, P().contributor, draft]))[0]?.["id"] as string;
  it("M6: título de conversa, assunto da thread, título do rascunho e corpo de mensagem passam pelo limpador", async () => {
    const w = await world();
    // Tudo plantado: pela tela, mencionar a pessoa a poria entre os participantes (e o id dela sairia como participante, o que vale).
    await sql("update conversations set title = $2 where id = $1", [w.main, hostile()]);
    const opening = await seedMessage(w.main, P().contributor, hostile());
    const thread = (await sql("with t as (insert into conversations (org_id, id, kind, purpose, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) select org_id, app_uuid_v7(), 'thread', 'people', owner_person_id, project_id, ticket_id, id, root_id, 1, $2 from conversations where id = $1 returning id, org_id), p as (insert into conversation_participants (org_id, conversation_id, person_id) select org_id, id, $3::uuid from t) select id from t", [w.main, opening, P().contributor]))[0]?.["id"] as string;
    const draftOpening = await seedMessage(w.main, P().contributor, "Faça um ticket");
    const draft = (await sql("insert into ticket_conversations (org_id, project_id, author_person_id, status, draft_title, draft_description) values ($1,$2,$3,'open',$4,'') returning id", [ORG, priv(), P().contributor, hostile()]))[0]?.["id"] as string;
    const creation = await creationThread(w.main, draftOpening, draft);
    await seedMessage(w.main, null, hostile());
    const items = await listAll(w.token);
    const raws = [JSON.stringify(items)];
    for (const id of [w.main, creation, thread]) raws.push((await call(w.token, "get_conversation", { id })).text);
    for (const raw of raws) expectNoLeak(raw);
    expect(items.find((c) => c.id === w.main)?.title).toBe(CLEANED());
    expect(items.find((c) => c.id === creation)?.title).toBe(CLEANED());
    expect(items.find((c) => c.id === thread)?.title).toBe(CLEANED());
    const messages = (await call(w.token, "get_conversation", { id: w.main, limit: 50 })).json?.messages as any[];
    expect(messages.filter((m) => m.body === CLEANED()).length).toBeGreaterThanOrEqual(2);
  });
  it("M6: nome de pessoa em forma de menção sai como o rótulo neutro", async () => {
    const w = await world();
    await h.pool.query("update people set display_name = $2 where id = $1", [P().reader, `Xerxes [@Bia](person:${P().target})`]);
    const raws = [JSON.stringify(await listAll(w.token)), (await call(w.token, "get_conversation", { id: w.thread })).text];
    for (const raw of raws) expectNoLeak(raw);
    expect(raws[1]).toContain("Unnamed person");
  });
  it("M6: rascunho de outro projeto numa thread de criação: nem título nem estado; a thread não aparece", async () => {
    const w = await world();
    // A dona do token enxerga o outro projeto (é gestora dele no mundo): não é o caso "projeto que ela não vê".
    const opening = await seedMessage(w.main, P().contributor, "Faça um ticket");
    const draft = (await sql("insert into ticket_conversations (org_id, project_id, author_person_id, status, draft_title, draft_description) values ($1,$2,$3,'open','RASCUNHO-DE-OUTRO-PROJETO','') returning id", [ORG, h.world().projects.org, P().contributor]))[0]?.["id"] as string;
    const threadId = await creationThread(w.main, opening, draft);
    const items = await listAll(w.token);
    const read = await call(w.token, "get_conversation", { id: threadId });
    expect(items.find((c) => c.id === threadId)).toBeUndefined();
    expect(read.isError).toBe(true);
    expect(read.text).toBe("Conversation not found.");
    expect(JSON.stringify(items) + read.text).not.toContain("RASCUNHO-DE-OUTRO-PROJETO");
  });
  it("M6: cursor forjado da lista e da conversa responde 'Invalid cursor.' sem log de erro", async () => {
    const w = await world();
    const forged = [b64({ k: "l", a: 9e15, i: w.main }), b64({ k: "l", a: -1e15, i: w.main }), b64({ k: "l", a: "x", i: w.main }), b64({ k: "l", a: 1.5, i: w.main })];
    const messageCursors = [b64({ k: "m", c: w.main, s: "x" }), b64({ k: "m", c: w.main, s: 5 }), b64({ k: "m", c: w.main, s: "99999999999999999999" })];
    const log = spyErrors();
    try {
      for (const after of forged) expect((await call(w.token, "list_conversations", { after })).text, after).toBe("Invalid cursor.");
      for (const after of messageCursors) expect((await call(w.token, "get_conversation", { id: w.main, after })).text, after).toBe("Invalid cursor.");
      expect(log.errors()).toBe(0);
    } finally {
      log.restore();
    }
  });
  it("M6: o cabeçalho (participantes) entra no teto; nada passa de 80.000 caracteres", async () => {
    const w = await world();
    await sql(
      "with p as (insert into people (org_id, clerk_user_id, display_name, email, clerk_role) select $1, 'u_massa_' || g, 'Participante com um nome bem comprido número ' || g, 'massa' || g || '@exemplo.test', 'member' from generate_series(1, 1500) g returning id) insert into conversation_participants (org_id, conversation_id, person_id) select $1, $2, id from p",
      [ORG, w.thread],
    );
    for (let i = 0; i < 25; i += 1) await seedMessage(w.thread, P().contributor, `${String(i).padStart(2, "0")}${"y".repeat(3_900)}`);
    let next: string | null = null;
    let pages = 0;
    do {
      const res = await call(w.token, "get_conversation", { id: w.thread, limit: 50, ...(next ? { after: next } : {}) });
      expect(res.json?.conversation).toMatchObject({ truncated: true });
      expect(res.isError, res.text.slice(0, 200)).toBe(false);
      expect(res.text.length).toBeLessThanOrEqual(80_000);
      expect((res.json?.messages as any[]).length).toBeGreaterThan(0);
      next = res.json?.next as string | null;
      pages += 1;
    } while (next !== null && pages < 30);
    expect(next).toBeNull();
    // Na lista, a conversa sozinha (participantes demais) também sai cortada e marcada.
    for (const limit of [1, 50]) {
      const list = await call(w.token, "list_conversations", { limit });
      expect(list.isError, list.text.slice(0, 200)).toBe(false);
      expect(list.text.length).toBeLessThanOrEqual(80_000);
      expect((list.json?.conversations as any[]).find((c) => c.id === w.thread)).toMatchObject({ truncated: true });
    }
  });
});

describe("M6: comentários e rotas da tela", () => {
  const plant = async (number: number, bodies: string[]): Promise<void> => {
    await h.pool.query(
      "insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, created_at) select $1, project_id, id, $2, b, now() + (o || ' milliseconds')::interval from tickets, unnest($3::text[]) with ordinality as u(b, o) where project_id = $4 and number = $5",
      [ORG, P().reader, bodies, priv(), number],
    );
  };
  const fill = (unit: string, prefix = "", suffix = "", size = 10_000): string => `${prefix}${unit.repeat(size)}`.slice(0, size - suffix.length) + suffix;
  it("list_comments com 50 comentários hostis de 10.000 caracteres custa o mesmo que com texto comum", async () => {
    const { token } = await setup();
    const patterns = [fill("[", "[a](person:x)"), fill(" ", "[a](person:x)]:", "x"), fill(" ", "[a](person:x)href=", "x"), fill("[@a\\", "[a](person:x)")];
    await h.pool.query("insert into tickets (org_id, project_id, number, title, description, status, created_by_person_id) values ($1,$2,5,'Quinto','','todo',$3)", [ORG, priv(), P().manager]);
    await plant(1, Array.from({ length: 50 }, () => fill("Um texto comum com palavras. ")));
    for (const [index, pattern] of patterns.entries()) await plant(index + 2, Array.from({ length: 50 }, () => pattern));
    await call(token, "list_comments", { key: "PRIV-1", limit: 50 });
    const plain = (await timed(() => call(token, "list_comments", { key: "PRIV-1", limit: 50 }))).ms;
    for (const key of ["PRIV-2", "PRIV-3", "PRIV-4", "PRIV-5"]) {
      const { ms, value } = await timed(() => call(token, "list_comments", { key, limit: 50 }));
      expect(value.isError, value.text.slice(0, 200)).toBe(false);
      expect(ms, `${key}: ${ms.toFixed(0)} ms contra ${plain.toFixed(0)} ms`).toBeLessThan(plain * 3 + 300);
    }
  });
  it("área do comentário passa pelo limpador", async () => {
    const { token } = await setup();
    const area = (await h.rows("insert into areas (org_id, name) values ($1,$2) returning id", [ORG, hostile()]))[0]?.["id"] as string;
    const contribution = (await h.rows("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'texto',$5) returning id", [ORG, priv(), await ticketId(3), area, P().manager]))[0]?.["id"] as string;
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, contribution_id) values ($1,$2,$3,$4,$5,$6)", [ORG, priv(), await ticketId(3), P().manager, hostile(), contribution]);
    const res = await call(token, "list_comments", { key: "PRIV-3" });
    expectNoLeak(res.text);
    expect((res.json?.comments as any[])[0]).toMatchObject({ area: CLEANED(), body: CLEANED() });
  });
  it("cursor forjado com instante fora de faixa responde 'Invalid cursor.' sem log de erro", async () => {
    const { token } = await setup();
    const t = await ticketId(3);
    const log = spyErrors();
    try {
      for (const a of [9e15, -1e15, 1.5, "x"]) {
        const res = await call(token, "list_comments", { key: "PRIV-3", after: b64({ k: "c", t, a, i: t }) });
        expect(res.text, String(a)).toBe("Invalid cursor.");
      }
      expect(log.errors()).toBe(0);
    } finally {
      log.restore();
    }
  });
  it("um comentário único maior que o teto (nome de área gigante plantado) sai cortado com a marca; o corte não deixa o elo pela metade", async () => {
    const { token } = await setup();
    const giant = `${"c".repeat(79_900)}${personLink(P().target, "x@y.test")}${"d".repeat(120_000)}`;
    const area = (await h.rows("insert into areas (org_id, name) values ($1,$2) returning id", [ORG, giant]))[0]?.["id"] as string;
    const contribution = (await h.rows("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'texto',$5) returning id", [ORG, priv(), await ticketId(3), area, P().manager]))[0]?.["id"] as string;
    // Datas distintas: com as duas em `now()` a ordem dependia do id (TREEPM-509).
    await h.pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, contribution_id, created_at) values ($1,$2,$3,$4,'oi',$5,'2026-01-01T00:00:00Z')", [ORG, priv(), await ticketId(3), P().manager, contribution]);
    await comment(3, P().reader, "depois", { at: "2026-01-01T00:00:01Z" });
    const res = await call(token, "list_comments", { key: "PRIV-3", limit: 1 });
    expect(res.isError, res.text.slice(0, 200)).toBe(false);
    expect(res.text.length).toBeLessThanOrEqual(80_000);
    expect((res.json?.comments as any[])[0]).toMatchObject({ truncated: true, body: "oi" });
    expect(res.json?.next).not.toBeNull();
    expectNoLeak(res.text);
  });
  it("rotas da tela: editar descrição, criar ticket e comentar com texto hostil não demoram", async () => {
    await setup();
    const id = await ticketId(3);
    const size = 95_000;
    const texts = { plain: fill("Um texto comum. ", "", "", size), colon: fill(" ", "]:", "x", size), href: fill(" ", "href=", "x", size), angle: fill(" ", "]:<", "x", size) };
    const run = async (text: string): Promise<number> => {
      let total = 0;
      total += (await timed(() => h.call("PATCH", `/api/tickets/${id}`, as("manager"), { description: text }))).ms;
      total += (await timed(() => h.call("POST", `/api/projects/${priv()}/tickets`, as("manager"), { title: "Novo", description: text, parentId: null }))).ms;
      total += (await timed(() => h.call("POST", `/api/tickets/${id}/comments`, as("manager"), { body: text.slice(0, 9_000) }))).ms;
      return total;
    };
    await run(texts.plain);
    const plain = await run(texts.plain);
    for (const [name, text] of Object.entries(texts)) {
      if (name === "plain") continue;
      const ms = await run(text);
      expect(ms, `${name}: ${ms.toFixed(0)} ms contra ${plain.toFixed(0)} ms`).toBeLessThan(plain * 3 + 300);
    }
  });
});
