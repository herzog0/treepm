import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

// Migration 0033 (ADR 0055) sobre um banco que já tem o chat da 0027: dados semeados no formato antigo.
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0033";
const url = (db: string) => OWNER_URL.replace(/\/[^/]+$/, `/${db}`);

let admin: pg.Client;
let db: pg.Client;
const who: Record<string, string> = {};
const ticket: Record<string, string> = {};
const msg: Record<string, string> = {};
/** O que cada pessoa tinha de não lidas, pela conta da 0027 (resposta do assistente no chat e mensagem de outra pessoa nas threads). */
const oldUnread: Record<string, number> = {};
const oldSeq: Record<string, string> = {};

const one = async (sql: string, params: unknown[] = []): Promise<string> => ((await db.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
const person = (user: string) => one("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', $1, $1, $2, 'member') returning id", [user, `${user}@x.io`]);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  db = new pg.Client({ connectionString: url(DB_NAME) });
  await db.connect();
  const names = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_/.test(n)).sort();
  for (const name of names.filter((n) => n < "0033")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));

  await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
  for (const user of ["ana", "bia", "caio", "davi"]) who[user] = await person(user);
  const project = await one("insert into projects (org_id, name, key) values ('o', 'P', 'K') returning id");
  const newTicket = async (number: number) => one("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('o', $1, $2, $3, $4) returning id", [project, number, `T${number}`, who["ana"]]);
  ticket["t1"] = await newTicket(1);
  ticket["t2"] = await newTicket(2);
  const chat = (t: string, p: string) => one("insert into ticket_chats (org_id, project_id, ticket_id, person_id) values ('o', $1, $2, $3) returning id", [project, t, p]);
  const anaChat = await chat(ticket["t1"] as string, who["ana"] as string);
  const biaChat = await chat(ticket["t1"] as string, who["bia"] as string);
  await chat(ticket["t1"] as string, who["caio"] as string);
  // Todo participante de thread tinha o chat do ticket (a 0027 o criava ao incluí-lo).
  await chat(ticket["t2"] as string, who["ana"] as string);
  const chatMsg = async (key: string, chatId: string, t: string, author: string | null, body: string) => {
    msg[key] = await one("insert into ticket_chat_messages (org_id, project_id, ticket_id, chat_id, author_person_id, body, model) values ('o', $1, $2, $3, $4, $5, $6) returning id", [project, t, chatId, author, body, author === null ? "m" : null]);
  };
  const t1 = ticket["t1"] as string;
  await chatMsg("q1", anaChat, t1, who["ana"] as string, "q1");
  await chatMsg("a1", anaChat, t1, null, "a1");
  await chatMsg("q2", anaChat, t1, who["ana"] as string, "q2");
  await chatMsg("a2", anaChat, t1, null, "a2");
  await chatMsg("b1", biaChat, t1, null, "resposta ao chat da Bia");
  const root = async (key: string, t: string, author: string, body: string) => {
    const id = (await db.query<{ id: string }>("select app_uuid_v7() as id")).rows[0]?.id as string;
    await db.query("insert into ticket_chat_messages (org_id, id, project_id, ticket_id, thread_id, author_person_id, body) values ('o', $1, $2, $3, $1, $4, $5)", [id, project, t, author, body]);
    msg[key] = id;
    return id;
  };
  const member = (thread: string, p: string, t: string) => db.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ('o', $1, $2, $3, $4)", [thread, p, project, t]);
  const replyIn = async (key: string, thread: string, t: string, author: string, body: string) => {
    msg[key] = await one("insert into ticket_chat_messages (org_id, project_id, ticket_id, thread_id, author_person_id, body) values ('o', $1, $2, $3, $4, $5) returning id", [project, t, thread, author, body]);
  };
  // Thread 1: Ana abriu, Bia e Caio participam; três respostas (Bia, Caio, Ana).
  const thread1 = await root("root1", t1, who["ana"] as string, "ana abre");
  for (const p of ["ana", "bia", "caio"]) await member(thread1, who[p] as string, t1);
  await replyIn("r1", thread1, t1, who["bia"] as string, "bia responde");
  await replyIn("r2", thread1, t1, who["caio"] as string, "caio responde");
  await replyIn("r3", thread1, t1, who["ana"] as string, "ana responde");
  // Thread 2, noutro ticket: Davi (sem chat nenhum) abriu e Ana participa.
  const t2 = ticket["t2"] as string;
  const thread2 = await root("root2", t2, who["davi"] as string, "davi abre");
  await member(thread2, who["davi"] as string, t2);
  await member(thread2, who["ana"] as string, t2);
  await replyIn("r4", thread2, t2, who["ana"] as string, "ana responde ao davi");
  // "Lido até" no meio: Ana leu até a1; Bia, até a raiz da thread 1; Caio, nada.
  await db.query("update ticket_chats set last_read_seq = (select seq from ticket_chat_messages where id = $1) where id = $2", [msg["a1"], anaChat]);
  await db.query("update ticket_chats set last_read_seq = (select seq from ticket_chat_messages where id = $1) where id = $2", [msg["root1"], biaChat]);

  // A conta da 0027 para cada pessoa (as de cada chat dela): respostas do assistente no chat + mensagens de outros nas threads, depois do lido.
  const before = await db.query<{ person_id: string; unread: number }>(`
    select c.person_id,
      sum((select count(*) from ticket_chat_messages m where m.chat_id = c.id and m.seq > c.last_read_seq and m.author_person_id is null)
        + (select count(*) from ticket_chat_thread_members tm join ticket_chat_messages m on m.thread_id = tm.thread_id
            where tm.person_id = c.person_id and tm.ticket_id = c.ticket_id and m.seq > c.last_read_seq and m.author_person_id <> c.person_id))::int as unread
    from ticket_chats c group by c.person_id`);
  for (const r of before.rows) oldUnread[Object.keys(who).find((k) => who[k] === r.person_id) as string] = r.unread;
  const seqs = await db.query<{ id: string; seq: string }>("select id, seq::text from ticket_chat_messages");
  for (const r of seqs.rows) oldSeq[r.id] = r.seq;

  await db.query(readFileSync(`${MIGRATIONS}0033_conversations_in_levels/migration.sql`, "utf8"));
});

afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

describe("migration 0033 sobre dados no formato da 0027", () => {
  it("as tabelas antigas saem e as novas entram", async () => {
    const t = await rows<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name like any (array['ticket_chat%', 'conversation%'])");
    expect(t.map((r) => r.table_name).sort()).toEqual(["conversation_messages", "conversation_participants", "conversations"]);
  });

  it("cada chat vira conversa principal da pessoa, no mesmo ticket", async () => {
    const principals = await rows<{ owner: string; ticket_id: string; depth: number; parent_id: string | null; root_id: string; id: string }>("select owner_person_id as owner, ticket_id, depth, parent_id, root_id, id from conversations where kind = 'ticket'");
    // Os quatro chats, mais a principal criada para o Davi (que abriu uma thread sem ter chat).
    expect(principals).toHaveLength(5);
    for (const c of principals) {
      expect(c.depth).toBe(0);
      expect(c.parent_id).toBeNull();
      expect(c.root_id).toBe(c.id);
    }
    const davi = principals.find((c) => c.owner === who["davi"]);
    expect(davi?.ticket_id).toBe(ticket["t2"]);
  });

  it("cada thread vira thread de nível 1 sob a principal de quem a abriu, com o id e a mensagem de abertura da raiz", async () => {
    const threads = await rows<{ id: string; owner: string; parent_owner: string; depth: number; opening: string; ticket_id: string; root_id: string; parent_id: string }>(
      "select t.id, t.owner_person_id as owner, p.owner_person_id as parent_owner, t.depth, t.opening_message_id as opening, t.ticket_id, t.root_id, t.parent_id from conversations t join conversations p on p.id = t.parent_id and p.org_id = t.org_id where t.kind = 'thread' order by t.created_at",
    );
    expect(threads).toHaveLength(2);
    const one = threads.find((t) => t.id === msg["root1"]);
    expect(one).toMatchObject({ owner: who["ana"], parent_owner: who["ana"], depth: 1, opening: msg["root1"], ticket_id: ticket["t1"] });
    expect(one?.root_id).toBe(one?.parent_id);
    const two = threads.find((t) => t.id === msg["root2"]);
    expect(two).toMatchObject({ owner: who["davi"], parent_owner: who["davi"], ticket_id: ticket["t2"] });
  });

  it("as mensagens mudam de conversa: a raiz vai para a de cima, as respostas para a thread, as do chat ficam; o seq não muda", async () => {
    const where = async (key: string) => (await rows<{ conversation_id: string }>("select conversation_id from conversation_messages where id = $1", [msg[key]]))[0]?.conversation_id;
    const parentOf = async (thread: string) => (await rows<{ parent_id: string }>("select parent_id from conversations where id = $1", [thread]))[0]?.parent_id;
    expect(await where("root1")).toBe(await parentOf(msg["root1"] as string));
    for (const r of ["r1", "r2", "r3"]) expect(await where(r)).toBe(msg["root1"]);
    expect(await where("r4")).toBe(msg["root2"]);
    const q1 = await where("q1");
    for (const k of ["a1", "q2", "a2"]) expect(await where(k)).toBe(q1);
    const after = await rows<{ id: string; seq: string }>("select id, seq::text from conversation_messages");
    expect(after).toHaveLength(Object.keys(oldSeq).length);
    for (const r of after) expect(r.seq).toBe(oldSeq[r.id]);
  });

  it("os participantes de hoje continuam, com a dona incluída, e os da thread incluem os da conversa de cima", async () => {
    const members = async (thread: string) => (await rows<{ person_id: string }>("select person_id from conversation_participants where conversation_id = $1", [thread])).map((r) => r.person_id).sort();
    expect(await members(msg["root1"] as string)).toEqual([who["ana"], who["bia"], who["caio"]].sort());
    expect(await members(msg["root2"] as string)).toEqual([who["ana"], who["davi"]].sort());
    const broken = await rows("select 1 from conversations c join conversation_participants up on up.conversation_id = c.parent_id where not exists (select 1 from conversation_participants me where me.conversation_id = c.id and me.person_id = up.person_id)");
    expect(broken).toHaveLength(0);
  });

  it("o 'lido até' do chat vai para a principal e para cada thread da pessoa", async () => {
    const read = async (conversation: string, p: string) => (await rows<{ seq: string }>("select last_read_seq::text as seq from conversation_participants where conversation_id = $1 and person_id = $2", [conversation, who[p]]))[0]?.seq;
    expect(await read(msg["root1"] as string, "ana")).toBe(oldSeq[msg["a1"] as string]);
    expect(await read(msg["root1"] as string, "bia")).toBe(oldSeq[msg["root1"] as string]);
    expect(await read(msg["root1"] as string, "caio")).toBe("0");
    // A Ana tem duas principais (T1, com o chat que ela já tinha, e T2, criada pela 0027 ao incluí-la): filtra o ticket.
    const principalOf = async (t: string) => (await rows<{ id: string }>("select id from conversations where kind = 'ticket' and owner_person_id = $1 and ticket_id = $2", [who["ana"], ticket[t]]))[0]?.id as string;
    expect(await read(await principalOf("t1"), "ana")).toBe(oldSeq[msg["a1"] as string]);
    expect(await read(await principalOf("t2"), "ana")).toBe("0");
  });

  it("a soma das não lidas por pessoa é a mesma da conta antiga", async () => {
    const now = await rows<{ person_id: string; unread: number }>(`
      select p.person_id,
        sum((select count(*) from conversation_messages m
              where (m.conversation_id = c.id or m.id = c.opening_message_id) and m.seq > p.last_read_seq and m.author_person_id is distinct from p.person_id
                and not exists (select 1 from conversations o where o.opening_message_id = m.id and o.parent_id = c.id)))::int as unread
      from conversation_participants p join conversations c on c.id = p.conversation_id group by p.person_id`);
    for (const user of ["ana", "bia", "caio"]) {
      expect(now.find((r) => r.person_id === who[user])?.unread, user).toBe(oldUnread[user]);
    }
    expect(oldUnread["ana"]).toBeGreaterThan(0);
    expect(oldUnread["caio"]).toBeGreaterThan(0);
  });

  it("a invariante vale para sempre depois: inserir sem os participantes de cima falha no fim da transação", async () => {
    const parent = (await rows<{ id: string; org_id: string }>("select id, org_id from conversations where kind = 'ticket' and owner_person_id = $1", [who["ana"]]))[0] as { id: string; org_id: string };
    await db.query("begin");
    try {
      const opening = await one("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('o', $1, $2, 'abre') returning id", [parent.id, who["ana"]]);
      const id = (await db.query<{ id: string }>("select app_uuid_v7() as id")).rows[0]?.id as string;
      await db.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) select 'o', $1, 'thread', $2, project_id, ticket_id, id, root_id, 1, $3 from conversations where id = $4", [id, who["ana"], opening, parent.id]);
      // Sem a dona entre os participantes da thread, o fim da transação recusa.
      await expect(db.query("set constraints all immediate")).rejects.toThrow(/conversations_owner/);
    } finally {
      await db.query("rollback");
    }
  });
});
