/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MINUTE } from "./access-token-support.js";
import { ProjectTools } from "../src/mcp/mcp-tools.js";
import { rpcBody, rpcHeaders, seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0043, fatia 2: MCP com escrita (alcance do token, chave da organização, três ferramentas, limites, autoria).
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const WRITE_TOOLS = ["update_ticket_status", "add_comment", "set_agent_work", "set_ticket_priority", "create_ticket", "update_ticket", "move_ticket", "add_dependency", "remove_dependency"];

async function writeOn(on = true, org = ORG): Promise<void> {
  await h.pool.query("update organizations set mcp_write_enabled = $2 where org_id = $1", [org, on]);
}
/** Semeia o projeto, liga as duas chaves e cria um token de ESCRITA da pessoa. */
async function setup(who: Who = "contributor", scope: "read" | "write" = "write"): Promise<{ token: string; id: string }> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  await writeOn();
  const res = await h.create(who, priv(), { scope });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.token as string, id: res.body.id as string };
}
const status = async (key: string) => (await h.rows("select status from tickets where project_id = $1 and number = $2", [priv(), Number(key.split("-")[1])]))[0]?.status as string;
const countRows = async (sql: string) => Number((await h.rows(sql))[0]?.n);
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;

describe("alcance do token e chave de escrita", () => {
  it("o alcance é read por padrão, aceita write, recusa outro valor, e a lista mostra o alcance", async () => {
    await h.enableMcp();
    const a = await h.create("contributor", priv());
    const b = await h.create("contributor", priv(), { scope: "write" });
    const c = await h.create("contributor", priv(), { scope: "admin" });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 400]);
    expect(a.body.scope).toBe("read");
    expect(b.body.scope).toBe("write");
    const list = (await h.call("GET", "/api/access-tokens", as("contributor"))).body as { scope: string }[];
    expect(list.map((t) => t.scope).sort()).toEqual(["read", "write"]);
  });

  it("criar token de escrita com a escrita desligada na organização é permitido", async () => {
    await h.enableMcp();
    expect((await h.create("contributor", priv(), { scope: "write" })).status).toBe(201);
  });

  it("a chave da organização: só administrador liga; grava evento; aparece em /api/me", async () => {
    const path = "/api/organization/mcp-write";
    expect((await h.call("PATCH", path, as("manager"), { mcpWriteEnabled: true })).status).toBe(403);
    const on = await h.call("PATCH", path, as("admin"), { mcpWriteEnabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ mcp: { writeEnabled: true } });
    expect((await h.call("GET", "/api/me", as("reader"))).body.mcp.writeEnabled).toBe(true);
    await h.call("PATCH", path, as("admin"), { mcpWriteEnabled: true });
    expect(await countRows("select count(*)::int n from activity_events where kind = 'organization.mcp_write_changed'")).toBe(1);
    expect((await h.call("PATCH", path, as("admin"), { mcpWriteEnabled: "sim" })).status).toBe(400);
  });
});

describe("tools/list", () => {
  const names = async (token: string) => ((await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; annotations: any }[]);

  it("token de escrita com a chave ligada vê as nove ferramentas, marcadas como de escrita; as de leitura continuam de leitura", async () => {
    const { token } = await setup();
    const tools = await names(token);
    expect(tools.map((t) => t.name).sort()).toEqual([...WRITE_TOOLS, "get_project_overview", "get_ticket", "get_work_queue", "list_tickets", "search_tickets"].sort());
    for (const t of tools) expect(t.annotations.readOnlyHint, t.name).toBe(!WRITE_TOOLS.includes(t.name));
    expect(tools.find((t) => t.name === "add_comment")?.annotations.destructiveHint).toBe(false);
  });
  it("token read não vê as ferramentas de escrita", async () => {
    const { token } = await setup("contributor", "read");
    expect((await names(token)).map((t) => t.name).filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
  });
  it("token write com a chave da organização desligada também não vê", async () => {
    const { token } = await setup();
    await writeOn(false);
    expect((await names(token)).map((t) => t.name).filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
  });
});

describe("chamadas recusadas sem efeito", () => {
  it("token read e chave desligada: a chamada é recusada, nada é gravado e nada do projeto vaza", async () => {
    const read = await setup("contributor", "read");
    const r1 = await h.tool(read.token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "in_progress" });
    const r2 = await h.tool(read.token, "PRIV", "add_comment", { key: "PRIV-3", body: "oi" });
    expect(refused(r1) && refused(r2)).toBe(true);
    const write = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    await writeOn(false);
    const r3 = await h.tool(write, "PRIV", "set_agent_work", { key: "PRIV-3", working: true });
    expect(refused(r3)).toBe(true);
    for (const r of [r1, r2, r3]) expect(JSON.stringify(r.raw)).not.toMatch(/Filho B|relat/);
    expect(await status("PRIV-3")).toBe("todo");
    expect(await countRows("select count(*)::int n from ticket_comments")).toBe(0);
    expect(await countRows("select count(*)::int n from tickets where agent_work_until is not null")).toBe(0);
  });

  it("token revogado e token vencido: 401", async () => {
    const a = await setup();
    await h.call("DELETE", `/api/access-tokens/${a.id}`, as("contributor"));
    expect((await h.tool(a.token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "done" })).status).toBe(401);
    const b = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    h.clock.advance(91 * 24 * 60 * MINUTE);
    expect((await h.tool(b, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "done" })).status).toBe(401);
    expect(await status("PRIV-3")).toBe("todo");
  });

  it("pessoa que saiu da organização escreve zero vezes, mesmo dentro da janela de 5 minutos", async () => {
    const { token } = await setup();
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200); // aquece a memória de 5 minutos
    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    h.clock.advance(MINUTE);
    const res = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "in_progress" });
    expect(res.status).toBe(401);
    expect(await status("PRIV-3")).toBe("todo");
    expect(await countRows("select count(*)::int n from activity_events where kind = 'ticket.updated'")).toBe(0);
  });

  it("lote com escrita: recusado inteiro, antes de executar qualquer item", async () => {
    const { token } = await setup();
    const batch = [rpcBody("tools/call", { name: "get_ticket", arguments: { key: "PRIV-3" } }, 1), rpcBody("tools/call", { name: "update_ticket_status", arguments: { key: "PRIV-3", status: "done" } }, 2)];
    const res = await h.post(token, "PRIV", batch, rpcHeaders("tools/call", { name: "update_ticket_status" }));
    expect(res.status).toBe(400);
    expect(await status("PRIV-3")).toBe("todo");
  });

  it("limite de 20 escritas por minuto por token; a leitura não é afetada", async () => {
    const { token } = await setup();
    for (let i = 0; i < 20; i += 1) expect((await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: i % 2 === 0 })).status, `#${i}`).toBe(200);
    expect((await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true })).status).toBe(429);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    h.clock.advance(61_000);
    expect((await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: false })).status).toBe(200);
  });

  // TREEPM-197: além do limite por token, 40 escritas por minuto por pessoa (organização + pessoa), somando todos os tokens dela.
  it("limite de 40 escritas por minuto por pessoa, somando os tokens; pessoas diferentes não se afetam; a leitura não é afetada", async () => {
    const first = await setup();
    const second = await h.create("contributor", priv(), { scope: "write" });
    const third = await h.create("contributor", priv(), { scope: "write" });
    const other = await h.create("manager", priv(), { scope: "write" });
    for (const r of [second, third, other]) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const write = (token: string) => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true });
    for (let i = 0; i < 20; i += 1) expect((await write(first.token)).status, `a#${i}`).toBe(200);
    for (let i = 0; i < 20; i += 1) expect((await write(second.body.token as string)).status, `b#${i}`).toBe(200);
    // O terceiro token da mesma pessoa está com a própria cota vazia, mas a pessoa já escreveu 40 vezes.
    const call = { name: "set_agent_work", arguments: { key: "PRIV-3", working: true } };
    const refusedByPerson = await h.post(third.body.token as string, "PRIV", rpcBody("tools/call", call), rpcHeaders("tools/call", { name: "set_agent_work" }));
    expect(refusedByPerson.status).toBe(429);
    expect(Number(refusedByPerson.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // Outra pessoa não é afetada; a leitura da pessoa que estourou também não.
    expect((await write(other.body.token as string)).status).toBe(200);
    expect((await h.tool(third.body.token as string, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    // A janela passa e a pessoa volta a escrever.
    h.clock.advance(61_000);
    expect((await write(third.body.token as string)).status).toBe(200);
  });
});

describe("a mesma tabela de recusas pelas duas portas (HTTP e MCP)", () => {
  type Case = { name: string; prepare: () => Promise<{ who: Who; key: string }> ; code?: string };
  const cases: Case[] = [
    { name: "leitor do projeto", prepare: async () => ({ who: "reader", key: "PRIV-3" }) },
    { name: "projeto arquivado", prepare: async () => { await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]); return { who: "contributor", key: "PRIV-3" }; } },
    { name: "concluir com filho aberto", prepare: async () => ({ who: "contributor", key: "PRIV-1" }) },
    { name: "ticket dentro de ideia", prepare: async () => { await h.pool.query("update tickets set status = 'todo', idea_stage = 'new' where project_id = $1 and number = 1", [priv()]); return { who: "contributor", key: "PRIV-3" }; } },
    { name: "pessoa sem acesso (papel removido depois do token)", prepare: async () => { await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]); await h.pool.query("delete from project_teams where project_id = $1", [priv()]); return { who: "contributor", key: "PRIV-3" }; } },
    { name: "ticket inexistente", prepare: async () => ({ who: "contributor", key: "PRIV-99" }) },
  ];
  const target = (c: Case) => (c.name === "concluir com filho aberto" ? "done" : "in_progress");

  for (const c of cases) {
    it(c.name, async () => {
      const { token } = await setup(c.name === "leitor do projeto" ? "reader" : "contributor");
      const { who, key } = await c.prepare();
      const ticket = (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), Number(key.split("-")[1])]))[0]?.id as string | undefined;
      const viaMcp = await h.tool(token, "PRIV", "update_ticket_status", { key, status: target(c) });
      expect(refused(viaMcp), `MCP: ${JSON.stringify(viaMcp.raw)}`).toBe(true);
      const viaHttp = await h.call("PATCH", `/api/tickets/${ticket ?? "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"}`, as(who), { status: target(c) });
      expect(viaHttp.status, `HTTP: ${JSON.stringify(viaHttp.body)}`).toBeGreaterThanOrEqual(400);
      if (ticket) expect((await h.rows("select status from tickets where id = $1", [ticket]))[0]?.status).not.toBe(target(c));
    });
  }

  it("ticket de outro projeto e outra organização", async () => {
    const { token } = await setup();
    expect(refused(await h.tool(token, "PRIV", "update_ticket_status", { key: "OPEN-1", status: "done" }))).toBe(true);
    const other = await h.issueOther();
    const res = await h.tool(other.token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "done" });
    expect(refused(res)).toBe(true);
    expect(await status("PRIV-3")).toBe("todo");
    void OTHER_ORG;
  });
});

describe("comentar: a mesma tabela de recusas pelas duas portas (rota HTTP e add_comment)", () => {
  const UNKNOWN = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
  const ticketId = async (project: string, n: number) => (await h.rows("select id from tickets where project_id = $1 and number = $2", [project, n]))[0]?.id as string | undefined;
  type Case = { name: string; who: Who; org?: string; prepare?: () => Promise<{ token?: string; key: string; ticket: string | undefined }> };
  const comment = (key: string, extra: Record<string, unknown> = {}) => ({ key, body: "paridade-de-comentario", ...extra });

  const cases: Case[] = [
    { name: "projeto arquivado", who: "contributor", prepare: async () => { await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]); return { key: "PRIV-3", ticket: await ticketId(priv(), 3) }; } },
    { name: "pessoa sem acesso (papel removido depois do token)", who: "contributor", prepare: async () => {
      await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]);
      await h.pool.query("delete from project_teams where project_id = $1", [priv()]);
      return { key: "PRIV-3", ticket: await ticketId(priv(), 3) };
    } },
    { name: "ticket inexistente", who: "contributor", prepare: async () => ({ key: "PRIV-99", ticket: undefined }) },
    { name: "ticket de outro projeto, que a pessoa não vê", who: "contributor", prepare: async () => {
      const project = (await h.rows("insert into projects (org_id, name, key, visibility) values ($1, 'Fechado', 'CLS', 'private') returning id", [ORG]))[0]?.id as string;
      await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1, 'Fechado 1', $3)", [ORG, project, h.world().people.manager]);
      return { key: "CLS-1", ticket: await ticketId(project, 1) };
    } },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { token } = await setup(c.who);
      const target = c.prepare ? await c.prepare() : { key: "PRIV-3", ticket: await ticketId(priv(), 3) };
      const viaMcp = await h.tool(token, "PRIV", "add_comment", comment(target.key));
      expect(refused(viaMcp), `MCP: ${JSON.stringify(viaMcp.raw)}`).toBe(true);
      const viaHttp = await h.call("POST", `/api/tickets/${target.ticket ?? UNKNOWN}/comments`, as(c.who), { body: "paridade-de-comentario" });
      expect(viaHttp.status, `HTTP: ${JSON.stringify(viaHttp.body)}`).toBeGreaterThanOrEqual(400);
      expect(await countRows("select count(*)::int n from ticket_comments")).toBe(0);
      expect(await countRows("select count(*)::int n from activity_events where kind = 'ticket.comment_added'")).toBe(0);
      expect(JSON.stringify(viaMcp.raw)).not.toMatch(/Filho B|Fechado|paridade-de-comentario/);
    });
  }

  it("outra organização: o token de lá e a sessão de lá não comentam no ticket daqui", async () => {
    await setup();
    const other = await h.issueOther();
    const ticket = await ticketId(priv(), 3);
    const viaMcp = await h.tool(other.token, "PRIV", "add_comment", comment("PRIV-3"));
    expect(refused(viaMcp)).toBe(true);
    const viaHttp = await h.call("POST", `/api/tickets/${ticket}/comments`, as("outsider", OTHER_ORG), { body: "paridade-de-comentario" });
    expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBeGreaterThanOrEqual(400);
    expect(await countRows("select count(*)::int n from ticket_comments")).toBe(0);
  });

  it("o leitor do projeto comenta pelas duas portas (ADR 0040, adendo de 2026-11-23), mas só no ticket, não em área", async () => {
    const { token } = await setup("reader");
    const viaMcp = await h.tool(token, "PRIV", "add_comment", comment("PRIV-3"));
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    const viaHttp = await h.call("POST", `/api/tickets/${await ticketId(priv(), 3)}/comments`, as("reader"), { body: "paridade-de-comentario" });
    expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBe(201);
    expect(await countRows(`select count(*)::int n from ticket_comments where author_person_id = '${h.world().people.reader}'`)).toBe(2);
    // O token de leitura continua sem escrever, mesmo de quem lê o projeto.
    const readOnly = await h.create("reader", priv(), { scope: "read" });
    expect(refused(await h.tool(readOnly.body.token as string, "PRIV", "add_comment", comment("PRIV-3")))).toBe(true);
  });

  it("controle: quem pode comentar comenta pelas duas portas, no mesmo ticket", async () => {
    const { token } = await setup();
    const viaMcp = await h.tool(token, "PRIV", "add_comment", comment("PRIV-3"));
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    const viaHttp = await h.call("POST", `/api/tickets/${await ticketId(priv(), 3)}/comments`, as("contributor"), { body: "paridade-de-comentario" });
    expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBe(201);
    expect(await countRows("select count(*)::int n from ticket_comments")).toBe(2);
  });
});

describe("corridas do marcador de trabalho pela IA", () => {
  const ticketId = async (n: number) => (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), n]))[0]?.id as string;
  const marker = async (id: string) =>
    (await h.rows("select status, agent_work_started_at s, agent_work_until u, agent_work_person_id p, agent_work_note n from tickets where id = $1", [id]))[0] as Record<string, any>;
  const eventCount = (kind: string, id: string) => countRows(`select count(*)::int n from activity_events where kind = '${kind}' and subject_id = '${id}'`);

  /**
   * Segura a linha do ticket numa transação do dono, dispara as chamadas (que ficam esperando a trava) e só então solta: as
   * chamadas disputam a linha ao mesmo tempo, em vez de depender da sorte do escalonador.
   */
  async function raceBehindLock<T>(id: string, calls: (() => Promise<T>)[]): Promise<T[]> {
    const holder = await h.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from tickets where id = $1 for update", [id]);
      const pending = Promise.all(calls.map((call) => call()));
      for (let i = 0; i < 40; i += 1) {
        const waiting = Number((await holder.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")).rows[0]?.n);
        if (waiting >= calls.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await holder.query("commit");
      return await pending;
    } finally {
      holder.release();
    }
  }
  const insertTicket = async (number: number): Promise<string> =>
    (await h.rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'Corrida', $4) returning id",
      [ORG, priv(), number, h.world().people.manager],
    ))[0]?.id as string;

  it("duas set_agent_work simultâneas no mesmo ticket: sobra um marcador coerente e no máximo um evento de início", async () => {
    const { token } = await setup();
    const id = await ticketId(3);
    const [a, b] = await raceBehindLock(id, [
      () => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, minutes: 30, note: "primeira" }),
      () => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, minutes: 90, note: "segunda" }),
    ]);
    expect([a?.status, b?.status], `${a?.text} / ${b?.text}`).toEqual([200, 200]);
    expect([a?.isError, b?.isError]).toEqual([false, false]);
    const row = await marker(id);
    expect(row["s"]).not.toBeNull();
    expect(row["u"]).not.toBeNull();
    expect(row["p"]).toBe(h.world().people.contributor);
    expect(["primeira", "segunda"]).toContain(row["n"]);
    // a nota e o prazo vêm da MESMA chamada (o marcador não mistura as duas)
    const minutes = (Date.parse(row["u"]) - Date.parse(row["s"])) / MINUTE;
    expect(row["n"] === "primeira" ? minutes <= 30.01 : minutes <= 90.01).toBe(true);
    expect(await eventCount("ticket.agent_work_started", id)).toBe(1);
    expect(await eventCount("ticket.agent_work_ended", id)).toBe(0);
    const read = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    expect(read.json?.["agentWork"]).toEqual({ until: new Date(row["u"]).toISOString() });
  });

  it("duas chamadas simultâneas, uma ligando e outra desligando: o estado final é um dos dois, nunca meio-ligado", async () => {
    const { token } = await setup();
    const id = await ticketId(3);
    const results = await raceBehindLock(id, [
      () => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note: "ligando" }),
      () => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: false }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const row = await marker(id);
    const columns = [row["s"], row["u"], row["p"], row["n"]];
    expect(columns.every((c) => c === null) || columns.every((c) => c !== null)).toBe(true);
    const started = await eventCount("ticket.agent_work_started", id);
    const ended = await eventCount("ticket.agent_work_ended", id);
    expect(started).toBeLessThanOrEqual(1);
    expect(started - ended).toBe(row["u"] === null ? 0 : 1);
  });

  it("concluir o ticket e ligar o marcador ao mesmo tempo: nunca sobra ticket concluído com marcador valendo", async () => {
    const { token } = await setup();
    let ligouPrimeiro = 0;
    let concluiuPrimeiro = 0;
    for (let i = 0; i < 8; i += 1) {
      const id = await insertTicket(10 + i);
      const key = `PRIV-${10 + i}`;
      const concluir = () => (i % 2 === 0
        ? h.tool(token, "PRIV", "update_ticket_status", { key, status: "done" })
        : h.call("PATCH", `/api/tickets/${id}`, as("contributor"), { status: "done" }));
      const [, set] = await raceBehindLock<{ status: number; isError?: boolean; text?: string }>(id, [
        async () => { const r = await concluir(); return { status: r.status }; },
        () => h.tool(token, "PRIV", "set_agent_work", { key, working: true, note: "corrida" }),
      ]);
      const row = await marker(id);
      expect(row["status"], `#${i}`).toBe("done");
      expect([row["s"], row["u"], row["p"], row["n"]], `#${i}: marcador valendo num ticket concluído`).toEqual([null, null, null, null]);
      expect((await h.call("GET", `/api/tickets/${id}`, as("admin"))).body.agentWork, `#${i}`).toBeNull();
      expect((await h.tool(token, "PRIV", "get_ticket", { key })).json?.["agentWork"], `#${i}`).toBeNull();
      const started = await eventCount("ticket.agent_work_started", id);
      const ended = await eventCount("ticket.agent_work_ended", id);
      // ligou antes (início + fim por conclusão) ou a conclusão veio antes (recusa 409 e nenhum evento do marcador)
      if (started === 1) { ligouPrimeiro += 1; expect(ended, `#${i}`).toBe(1); } else { concluiuPrimeiro += 1; expect([started, ended, set?.isError], `#${i}`).toEqual([0, 0, true]); }
    }
    expect(ligouPrimeiro + concluiuPrimeiro).toBe(8);
  });

  it("cancelar o ticket também desliga o marcador, mesmo disputando a trava com quem liga", async () => {
    const { token } = await setup();
    const id = await insertTicket(30);
    await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-30", working: true });
    await raceBehindLock(id, [
      () => h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-30", status: "cancelled" }),
      () => h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-30", working: true, note: "tarde" }),
    ]);
    const row = await marker(id);
    expect(row["status"]).toBe("cancelled");
    expect([row["s"], row["u"], row["p"], row["n"]]).toEqual([null, null, null, null]);
  });
});

describe("um só analisador de chave, e a resposta da escrita não falha depois de gravar (revisão 2, item 2)", () => {
  it("zeros à esquerda (PRIV-03) são recusados pelas três ferramentas de escrita, sem gravar nada", async () => {
    const { token } = await setup();
    const a = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-03", status: "in_progress" });
    const b = await h.tool(token, "PRIV", "add_comment", { key: "PRIV-03", body: "oi" });
    const c = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-03", working: true });
    for (const r of [a, b, c]) expect(r.isError, r.text).toBe(true);
    expect(await status("PRIV-3")).toBe("todo");
    expect(await countRows("select count(*)::int n from ticket_comments")).toBe(0);
    expect(await countRows("select count(*)::int n from tickets where agent_work_until is not null")).toBe(0);
    expect(await countRows("select count(*)::int n from activity_events where kind in ('ticket.updated','ticket.comment_added','ticket.agent_work_started')")).toBe(0);
  });

  it("minúsculas e espaços em volta continuam valendo, nas leituras e nas escritas, e a chave devolvida é a canônica", async () => {
    const { token } = await setup();
    const res = await h.tool(token, "PRIV", "update_ticket_status", { key: " priv-3 ", status: "in_progress" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json?.["key"]).toBe("PRIV-3");
    const c = await h.tool(token, "PRIV", "add_comment", { key: "priv-3", body: "oi" });
    expect(c.json?.["key"]).toBe("PRIV-3");
    expect((await h.tool(token, "PRIV", "set_agent_work", { key: "Priv-3", working: true })).json?.["key"]).toBe("PRIV-3");
  });

  it("update_ticket_status monta a resposta dentro da própria transação: uma segunda leitura que falha não vira erro depois de gravar", async () => {
    const { token } = await setup();
    const spy = vi.spyOn(ProjectTools.prototype, "getTicket").mockRejectedValue(new Error("falha da segunda leitura"));
    try {
      const res = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "in_progress" });
      expect(res.isError, res.text).toBe(false);
      expect(res.json).toMatchObject({ key: "PRIV-3", status: "in_progress" });
      expect(await status("PRIV-3")).toBe("in_progress");
    } finally {
      spy.mockRestore();
    }
  });
});

async function waitForLockWaiters(client: { query: (sql: string) => Promise<{ rows: Record<string, any>[] }> }, count: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const waiting = Number((await client.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")).rows[0]?.n);
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("ninguém ficou esperando a trava");
}

describe("corridas do marcador com a mudança de pai (revisão 2, item 3)", () => {
  const rowOf = async (id: string) => (await h.rows("select parent_id, agent_work_until u from tickets where id = $1", [id]))[0] as Record<string, any>;
  const add = async (number: number, title: string, parentId: string | null, stage: string | null = null): Promise<string> =>
    (await h.rows(
      "insert into tickets (org_id, project_id, number, parent_id, title, idea_stage, created_by_person_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [ORG, priv(), number, parentId, title, stage, h.world().people.manager],
    ))[0]?.id as string;

  /** Solta `sql` (um bloqueio feito por uma transação do dono) só depois de as chamadas estarem esperando. */
  async function raceBehind<T>(sql: string, waiters: number, calls: (() => Promise<T>)[]): Promise<T[]> {
    const holder = await h.pool.connect();
    try {
      await holder.query("begin");
      await holder.query(sql);
      const pending = Promise.all(calls.map((call) => call()));
      for (let i = 0; i < 60; i += 1) {
        const waiting = Number((await holder.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")).rows[0]?.n);
        if (waiting >= waiters) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await holder.query("commit");
      return await pending;
    } finally {
      holder.release();
    }
  }

  it("mover o próprio ticket para dentro de uma ideia e ligar o marcador ao mesmo tempo: nunca sobra marcador dentro da ideia", async () => {
    const { token } = await setup();
    for (let i = 0; i < 8; i += 1) {
      const idea = await add(100 + i * 3, "Ideia", null, "new");
      const ticket = await add(101 + i * 3, "Solto", null);
      await raceBehind<unknown>(`select 1 from tickets where id = '${ticket}' for update`, 2, [
        async () => (await h.call("PATCH", `/api/tickets/${ticket}`, as("contributor"), { parentId: idea })).status,
        () => h.tool(token, "PRIV", "set_agent_work", { key: `PRIV-${101 + i * 3}`, working: true, note: "corrida" }),
      ]);
      const row = await rowOf(ticket);
      expect(row["parent_id"], `#${i}`).toBe(idea);
      expect(row["u"], `#${i}: marcador valendo dentro de uma ideia`).toBeNull();
    }
  });

  it("mover um ANCESTRAL para dentro de uma ideia e ligar o marcador num descendente ao mesmo tempo: nunca sobra marcador dentro da ideia", async () => {
    const { token } = await setup();
    for (let i = 0; i < 4; i += 1) {
      const idea = await add(200 + i * 3, "Ideia", null, "new");
      const ancestor = await add(201 + i * 3, "Ancestral", null);
      const child = await add(202 + i * 3, "Filho", ancestor);
      // O marcador grava `agent_work_person_id`, e a chave estrangeira pede KEY SHARE na linha da pessoa: segurando essa linha, o
      // `set` para DEPOIS de ler os ancestrais e ANTES de gravar. Quem move é outra pessoa (o gerente) e não é atingida.
      const holder = await h.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select 1 from people where id = $1 for update", [h.world().people.contributor]);
        const set = h.tool(token, "PRIV", "set_agent_work", { key: `PRIV-${202 + i * 3}`, working: true, note: "corrida" });
        await waitForLockWaiters(holder, 1);
        const move = h.call("PATCH", `/api/tickets/${ancestor}`, as("manager"), { parentId: idea });
        await new Promise((resolve) => setTimeout(resolve, 500)); // sem a trava da subárvore a mudança termina aqui; com ela, espera o `set`
        await holder.query("commit");
        const [setRes, moveRes] = await Promise.all([set, move]);
        expect(moveRes.status, `#${i}: ${JSON.stringify(moveRes.body)}`).toBe(200);
        expect([200, 409]).toContain(setRes.status === 200 && setRes.isError ? 409 : setRes.status);
      } finally {
        holder.release();
      }
      expect((await rowOf(ancestor))["parent_id"], `#${i}`).toBe(idea);
      expect((await rowOf(child))["u"], `#${i}: marcador valendo dentro de uma ideia`).toBeNull();
    }
  });
});

describe("as três ferramentas", () => {
  it("update_ticket_status devolve o ticket como get_ticket e grava o evento com via mcp e o id do token", async () => {
    const { token, id } = await setup();
    const res = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "in_progress" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-3", status: "in_progress", agentWork: null });
    const read = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    expect(res.json).toEqual(read.json);
    const events = await h.rows("select payload, actor_person_id from activity_events where kind = 'ticket.updated' order by occurred_at desc limit 1");
    expect(events[0]?.payload).toMatchObject({ via: "mcp", tokenId: id, status: { from: "todo", to: "in_progress" } });
    expect(events[0]?.actor_person_id).toBe(h.world().people.contributor);
  });

  it("add_comment devolve só a chave e o id; a leitura não devolve comentário; a autoria sobrevive à revogação do token", async () => {
    const { token, id } = await setup();
    const res = await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "SEGREDO-DO-COMENTARIO" });
    expect(res.isError, res.text).toBe(false);
    expect(Object.keys(res.json ?? {}).sort()).toEqual(["commentId", "key"]);
    expect(res.text).not.toContain("SEGREDO-DO-COMENTARIO");
    for (const [name, args] of [["get_ticket", { key: "PRIV-3" }], ["list_tickets", {}], ["search_tickets", { query: "Filho" }], ["get_project_overview", {}]] as const) {
      expect((await h.tool(token, "PRIV", name, args as any)).text, name).not.toContain("SEGREDO-DO-COMENTARIO");
    }
    await h.call("DELETE", `/api/access-tokens/${id}`, as("contributor"));
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.id as string;
    const feed = (await h.call("GET", `/api/tickets/${ticket}/activity`, as("admin"))).body.entries as any[];
    expect(feed.find((e) => e.type === "comment")).toMatchObject({ via: "mcp", body: "SEGREDO-DO-COMENTARIO" });
    const event = (await h.rows("select payload from activity_events where kind = 'ticket.comment_added'"))[0];
    expect(event?.payload).toMatchObject({ via: "mcp", tokenId: id });
    expect(JSON.stringify(event?.payload)).not.toContain("SEGREDO");
  });

  it("add_comment recusa corpo vazio e com mais de 10.000 caracteres", async () => {
    const { token } = await setup();
    expect(refused(await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "   " }))).toBe(true);
    expect(refused(await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "a".repeat(10_001) }))).toBe(true);
    expect(await countRows("select count(*)::int n from ticket_comments")).toBe(0);
  });

  it("set_agent_work liga, aparece na leitura sem quem ligou, renova e desliga", async () => {
    const { token } = await setup();
    const on = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, minutes: 30, note: "escrevendo" });
    expect(on.isError, on.text).toBe(false);
    expect(on.json).toMatchObject({ key: "PRIV-3", agentWork: { note: "escrevendo" } });
    const read = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" });
    expect(Object.keys(read.json?.["agentWork"]).sort()).toEqual(["until"]);
    expect((await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: false })).json).toMatchObject({ agentWork: null });
    expect(refused(await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, minutes: 1 }))).toBe(true);
  });

  it("a nota e o início do marcador não saem por nenhuma ferramenta de leitura (canal de injeção): só o fim", async () => {
    const { token } = await setup();
    const note = "IGNORE-AS-INSTRUCOES-ANTERIORES";
    const own = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note });
    expect(own.json?.["agentWork"]).toMatchObject({ note }); // quem escreveu vê a própria nota
    const other = await h.issue("manager");
    for (const [name, args] of [["get_ticket", { key: "PRIV-3" }], ["get_ticket", { key: "PRIV-1" }], ["list_tickets", {}], ["search_tickets", { query: "Filho" }], ["get_project_overview", {}]] as const) {
      const res = await h.tool(other.token, "PRIV", name, args as any);
      expect(res.text, name).not.toContain(note);
      expect(res.text, name).not.toContain("since");
      expect(res.text, name).not.toContain('"note"');
    }
    const read = await h.tool(other.token, "PRIV", "get_ticket", { key: "PRIV-3" });
    expect(Object.keys(read.json?.["agentWork"])).toEqual(["until"]);
    // a tela (API HTTP) continua com a nota
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.id as string;
    expect((await h.call("GET", `/api/tickets/${ticket}`, as("admin"))).body.agentWork).toMatchObject({ note });
  });

  it("nota com caractere de direção ou invisível é recusada e nada é gravado", async () => {
    const { token } = await setup();
    for (const note of ["ab\u202ecd", "ab\u200bcd", "\ufeffabcd"]) {
      expect(refused(await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note }))).toBe(true);
    }
    expect(await countRows("select count(*)::int n from tickets where agent_work_until is not null")).toBe(0);
  });

  it("nenhum corpo, nota ou argumento aparece no log, nem com entrada inválida", async () => {
    const { token } = await setup();
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
    await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "CORPO-NO-LOG" });
    await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note: "NOTA-NO-LOG" });
    await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note: `NOTA-INVALIDA-${"x".repeat(300)}` });
    await h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: 12345 as any });
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).toContain("tool=set_agent_work");
    expect(logged).not.toMatch(/CORPO-NO-LOG|NOTA-NO-LOG|NOTA-INVALIDA|12345|tpm_/);
  });
});

describe("add_comment repetido com requestId (idempotência, ADR 0043)", () => {
  const add = (token: string, args: Record<string, unknown>) => h.tool(token, "PRIV", "add_comment", { key: "PRIV-3", body: "repetido", ...args });
  const comments = () => countRows("select count(*)::int n from ticket_comments");
  const events = () => countRows("select count(*)::int n from activity_events where kind = 'ticket.comment_added'");

  it("a segunda chamada do mesmo token, ticket e requestId devolve o mesmo commentId, sem outro comentário e sem novo evento", async () => {
    const { token } = await setup();
    const first = await add(token, { requestId: "pedido-0001" });
    const second = await add(token, { requestId: "pedido-0001" });
    expect(first.isError, first.text).toBe(false);
    expect(second.isError, second.text).toBe(false);
    expect(second.json).toEqual(first.json);
    expect(await comments()).toBe(1);
    expect(await events()).toBe(1);
  });

  it("o mesmo requestId com texto DIFERENTE responde erro claro, não devolve o comentário antigo e não grava nada", async () => {
    const { token } = await setup();
    const first = await add(token, { requestId: "pedido-texto-1", body: "texto original" });
    const second = await add(token, { requestId: "pedido-texto-1", body: "outro texto" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("requestId already used with a different request");
    expect(second.text).not.toContain("outro texto");
    expect(second.text).not.toContain(first.json?.["commentId"]);
    expect(await comments()).toBe(1);
    expect(await events()).toBe(1);
    expect((await h.rows("select body from ticket_comments"))[0]?.["body"]).toBe("texto original");
    // com o mesmo texto continua devolvendo o mesmo comentário
    expect((await add(token, { requestId: "pedido-texto-1", body: "texto original" })).json?.["commentId"]).toBe(first.json?.["commentId"]);
  });

  it("se o comentário foi removido nesse meio-tempo, a repetição cria um novo (com o mesmo texto ou outro)", async () => {
    const { token } = await setup();
    const first = await add(token, { requestId: "pedido-removido" });
    expect((await h.call("DELETE", `/api/comments/${first.json?.["commentId"]}`, as("contributor"))).status).toBeLessThan(300);
    const again = await add(token, { requestId: "pedido-removido" });
    expect(again.isError, again.text).toBe(false);
    expect(again.json?.["commentId"]).not.toBe(first.json?.["commentId"]);
    expect(await countRows("select count(*)::int n from ticket_comments where removed_at is null")).toBe(1);
    const other = await add(token, { requestId: "pedido-removido", body: "texto diferente agora" });
    expect(other.isError, other.text).toBe(true); // o novo comentário vale: agora o texto diferente conflita com ele
  });

  it("duas chamadas simultâneas com o mesmo requestId criam um comentário só", async () => {
    const { token } = await setup();
    const [a, b] = await Promise.all([add(token, { requestId: "pedido-corrida" }), add(token, { requestId: "pedido-corrida" })]);
    expect(a.json?.["commentId"]).toBe(b.json?.["commentId"]);
    expect(await comments()).toBe(1);
    expect(await events()).toBe(1);
  });

  it("depois de 10 minutos a repetição já vale como comentário novo", async () => {
    const { token } = await setup();
    const first = await add(token, { requestId: "pedido-janela" });
    h.clock.advance(9 * MINUTE);
    expect((await add(token, { requestId: "pedido-janela" })).json?.["commentId"]).toBe(first.json?.["commentId"]);
    h.clock.advance(2 * MINUTE);
    const late = await add(token, { requestId: "pedido-janela" });
    expect(late.json?.["commentId"]).not.toBe(first.json?.["commentId"]);
    expect(await comments()).toBe(2);
  });

  it("outro requestId, outro token da mesma pessoa e outro ticket criam comentário novo; sem requestId nunca repete", async () => {
    const { token } = await setup();
    const base = await add(token, { requestId: "pedido-base1" });
    const otherId = await add(token, { requestId: "pedido-base2" });
    const otherTicket = await add(token, { requestId: "pedido-base1", key: "PRIV-2" });
    const secondToken = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    const otherToken = await add(secondToken, { requestId: "pedido-base1" });
    const none1 = await add(token, {});
    const none2 = await add(token, {});
    const ids = [base, otherId, otherTicket, otherToken, none1, none2].map((r) => r.json?.["commentId"]);
    expect(new Set(ids).size).toBe(6);
    expect(await comments()).toBe(6);
  });

  it("requestId fora do formato (curto, longo ou com caractere proibido) é recusado sem gravar e sem repetir o valor", async () => {
    const { token } = await setup();
    for (const bad of ["curto", "x".repeat(65), "tem espaco aqui", "acento-não-vale", "semi;colon-1"]) {
      const res = await add(token, { requestId: bad });
      expect(refused(res), bad).toBe(true);
      expect(JSON.stringify(res.raw), bad).not.toContain(bad);
    }
    expect(await comments()).toBe(0);
    expect(refused(await add(token, { requestId: 12345678 as any }))).toBe(true);
    expect((await add(token, { requestId: "x".repeat(64) })).isError).toBe(false);
    expect((await add(token, { requestId: "oito-ok8" })).isError).toBe(false);
  });

  it("o requestId não vai a log, a evento, à resposta nem ao feed", async () => {
    const { token } = await setup();
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
    const ok = await add(token, { requestId: "REQ-NO-LOG-1" });
    await add(token, { requestId: "REQ-NO-LOG-1" });
    await add(token, { requestId: "REQ INVALIDO NO LOG" });
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).toContain("tool=add_comment");
    expect(logged).not.toMatch(/REQ-NO-LOG|REQ INVALIDO/);
    expect(ok.text).not.toContain("REQ-NO-LOG");
    const payloads = JSON.stringify((await h.rows("select payload from activity_events")).map((r) => r.payload));
    expect(payloads).not.toContain("REQ-NO-LOG");
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.id as string;
    expect(JSON.stringify((await h.call("GET", `/api/tickets/${ticket}/activity`, as("admin"))).body)).not.toContain("REQ-NO-LOG");
  });

  it("o comentário repetido não escapa às recusas: leitor, arquivado e token revogado continuam recusados", async () => {
    const { token, id } = await setup();
    await add(token, { requestId: "pedido-recusa" });
    await h.call("DELETE", `/api/access-tokens/${id}`, as("contributor"));
    expect((await add(token, { requestId: "pedido-recusa" })).status).toBe(401);
    const live = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(refused(await add(live, { requestId: "pedido-recusa" }))).toBe(true);
    expect(await comments()).toBe(1);
  });
});
