import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { chatShowCommand } from "../scripts/placement-rebuild/chat-commands.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import type { TicketContext } from "../scripts/placement-rebuild/ticket-commands.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// TREEPM-403: `chat-show` lê as conversas do usuário da ferramenta, só pelas rotas da API.
describe("chat-show", () => {
  const pool = ownerPoolWithCleanup();
  let booted: Booted;
  let client: ApiClient;
  let lines: string[];
  let ctx: TicketContext;

  beforeAll(async () => {
    booted = await bootApp({ org: "org_cs", user: "user_cs", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
    client = new ApiClient(booted.baseUrl, booted.token);
  });
  afterAll(async () => {
    await booted.close();
    await pool.end();
  });
  const run = async (project: string, input: Parameters<typeof chatShowCommand>[1]): Promise<string[]> => {
    lines = [];
    ctx = { client, project, log: (line) => lines.push(line) };
    await chatShowCommand(ctx, input);
    return lines;
  };
  const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  it("argumentos: exatamente um de --general, --ticket, --thread; --ticket pede --project", () => {
    expect(parseCliArgs(["chat-show", "--org", "o", "--user", "u", "--general"]).ok).toBe(true);
    expect(parseCliArgs(["chat-show", "--org", "o", "--user", "u", "--thread", "abc"]).ok).toBe(true);
    expect(parseCliArgs(["chat-show", "--org", "o", "--user", "u", "--ticket", "3", "--project", "p"]).ok).toBe(true);
    for (const bad of [[], ["--general", "--thread", "x"], ["--ticket", "3"], ["--general", "--project", "p"], ["--ticket", "0", "--project", "p"]]) {
      expect(parseCliArgs(["chat-show", "--org", "o", "--user", "u", ...bad]).ok, bad.join(" ")).toBe(false);
    }
    expect(parseCliArgs(["ticket-list", "--org", "o", "--user", "u", "--project", "p", "--general"]).ok).toBe(false);
  });

  it("Meu chat e threads: mensagens em ordem, autor pessoa/assistente e as threads com título e respostas; sem nome", async () => {
    await expect(run("", { general: true })).rejects.toThrow("Meu chat ainda não existe");
    const general = (await client.request("POST", "/conversations/general")).body as { id: string };
    const me = (await sql("select id from people where clerk_user_id = 'user_cs'"))[0].id as string;
    const other = (await sql("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_cs','u_other','Fulana Secreta','fulana@exemplo.test','member') returning id"))[0].id as string;
    await sql("insert into conversation_messages (org_id, conversation_id, author_person_id, body, created_at) values ('org_cs',$1,$2,'Primeira pergunta', now() - interval '2 minutes')", [general.id, me]);
    await sql("insert into conversation_messages (org_id, conversation_id, body, model, created_at) values ('org_cs',$1,'Primeira resposta','m', now() - interval '1 minute')", [general.id]);
    const opened = await client.request("POST", `/conversations/${general.id}/messages`, { body: "Fulana, olha isto", mentions: [other] });
    expect(opened.status).toBe(201);
    const thread = (opened.body as { thread: { id: string } }).thread.id;
    expect((await client.request("POST", `/conversations/${thread}/messages`, { body: "Resposta na thread" })).status).toBe(201);

    const out = await run("", { general: true });
    expect(out[0]).toBe("Meu chat");
    const body = out.join("\n");
    expect(body.indexOf("pessoa: Primeira pergunta")).toBeGreaterThan(-1);
    expect(body.indexOf("assistente: Primeira resposta")).toBeGreaterThan(body.indexOf("pessoa: Primeira pergunta"));
    expect(out.find((line) => line.startsWith("Threads"))).toBe("Threads (1):");
    expect(out.find((line) => line.startsWith("- "))).toBe(`- ${thread} «Fulana, olha isto» 1 resposta`);
    for (const secret of ["Fulana Secreta", "fulana@exemplo", other, me]) expect(body.includes(secret), secret).toBe(false);

    const inThread = (await run("", { thread: thread })).join("\n");
    expect(inThread).toContain("Resposta na thread");
    expect(inThread).toContain("(abertura): Fulana, olha isto");
    expect(inThread.indexOf("(abertura)")).toBeLessThan(inThread.indexOf("Resposta na thread"));
  });

  it("thread de assunto: mostra o propósito e o título, na lista de threads e na própria thread", async () => {
    const me = (await sql("select id from people where clerk_user_id = 'user_cs'"))[0].id as string;
    const general = (await sql("select id from conversations where kind = 'general' and owner_person_id = $1", [me]))[0].id as string;
    const opening = (await sql("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_cs',$1,$2,'Como planejo a release?') returning id", [general, me]))[0].id as string;
    const thread = (await sql("with t as (insert into conversations (org_id, id, kind, purpose, title, owner_person_id, parent_id, root_id, depth, opening_message_id) values ('org_cs', app_uuid_v7(), 'thread','topic','Plano da release',$1,$2,$2,1,$3) returning id, org_id), p as (insert into conversation_participants (org_id, conversation_id, person_id) select org_id, id, $1::uuid from t) select id from t", [me, general, opening]))[0].id as string;
    await sql("insert into conversation_messages (org_id, conversation_id, body, model) values ('org_cs',$1,'Comece pelo escopo','m')", [thread]);
    const list = (await run("", { general: true })).join("\n");
    expect(list).toContain(`- ${thread} [assunto] «Plano da release» 1 resposta`);
    const inside = (await run("", { thread })).join("\n");
    expect(inside).toContain("Propósito: assunto; título: «Plano da release»");
    expect(inside).toContain("assistente: Comece pelo escopo");
  });

  it("thread fechada pela pessoa: o cabeçalho e a lista mostram [fechada]; reaberta, não", async () => {
    const thread = (await sql("select id from conversations where title = 'Plano da release'"))[0].id as string;
    await client.request("POST", `/conversations/${thread}/close`);
    expect((await run("", { thread }))[0]).toContain("[fechada]");
    expect((await run("", { general: true })).join("\n")).toContain("[assunto] «Plano da release» [fechada] 1 resposta");
    await client.request("POST", `/conversations/${thread}/reopen`);
    expect((await run("", { thread })).join("\n")).not.toContain("[fechada]");
  });

  it("--thread só aceita uuid (o id vai no caminho da rota)", async () => {
    for (const bad of ["../tickets", "abc", "x?y=1"]) await expect(run("", { thread: bad })).rejects.toThrow("uuid");
  });

  it("chat de um ticket: pelo número, só leitura (não cria conversa)", async () => {
    const project = (await client.request("POST", "/projects", { key: "CSH", name: "Chat show" })).body as { id: string };
    const ticket = (await client.request("POST", `/projects/${project.id}/tickets`, { title: "Ticket do chat", parentId: null, status: "todo" })).body as { id: string; number: number };
    await expect(run(project.id, { ticket: ticket.number })).rejects.toThrow("não tem conversa em CSH-1");
    expect((await sql("select count(*)::int as n from conversations where ticket_id = $1", [ticket.id]))[0].n).toBe(0);
    const chat = (await client.request("POST", `/tickets/${ticket.id}/conversation`)).body as { id: string };
    const me = (await sql("select id from people where clerk_user_id = 'user_cs'"))[0].id as string;
    await sql("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_cs',$1,$2,'Como começo?')", [chat.id, me]);
    const out = await run(project.id, { ticket: ticket.number });
    expect(out[0]).toBe("Chat de CSH-1 — Ticket do chat");
    expect(out.join("\n")).toContain("pessoa: Como começo?");
  });
});
