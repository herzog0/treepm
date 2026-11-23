import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0027 (ADR 0049): ticket_chats, ticket_chat_messages, ticket_chat_thread_members.
const ORG = "org_CHAT";
const OTHER = "org_CHAT_B";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let otherIds: Ids;
let second: string;
let number = 100;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
  otherIds = await seedOrg(owner, OTHER);
  second = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'u2','Segunda','s@x.io','member') returning id", [ORG])).rows[0]?.id ?? "";
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const newTicket = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'T',$4) returning id", [ORG, ids.project, ++number, ids.person])).rows[0]?.id ?? "";
const newChat = async (ticket: string, person: string): Promise<string> =>
  (await owner.query<{ id: string }>("insert into ticket_chats (org_id, project_id, ticket_id, person_id) values ($1,$2,$3,$4) returning id", [ORG, ids.project, ticket, person])).rows[0]?.id ?? "";
const chatMessage = (ticket: string, chat: string, author: string | null, body = "oi", model: string | null = null) =>
  owner.query("insert into ticket_chat_messages (org_id, project_id, ticket_id, chat_id, author_person_id, body, model) values ($1,$2,$3,$4,$5,$6,$7)", [ORG, ids.project, ticket, chat, author, body, model]);
const root = async (ticket: string, author: string): Promise<string> => {
  const id = randomUUID();
  await owner.query("insert into ticket_chat_messages (org_id, id, project_id, ticket_id, thread_id, author_person_id, body) values ($1,$2,$3,$4,$2,$5,'raiz')", [ORG, id, ids.project, ticket, author]);
  return id;
};
const reply = (ticket: string, thread: string, author: string, body = "resposta") =>
  owner.query("insert into ticket_chat_messages (org_id, project_id, ticket_id, thread_id, author_person_id, body) values ($1,$2,$3,$4,$5,$6)", [ORG, ids.project, ticket, thread, author, body]);

describe("ticket_chats", () => {
  it("um chat por pessoa e ticket", async () => {
    const t = await newTicket();
    await newChat(t, ids.person);
    await expect(newChat(t, ids.person)).rejects.toThrow(/ticket_chats_org_id_ticket_id_person_id_key/);
    await expect(newChat(t, second)).resolves.toBeTruthy();
  });

  it("o ponto de leitura nasce em 0 e não aceita negativo", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    expect((await owner.query("select last_read_seq::int as n from ticket_chats where id = $1", [chat])).rows[0].n).toBe(0);
    await expect(owner.query("update ticket_chats set last_read_seq = -1 where id = $1", [chat])).rejects.toThrow(/ticket_chats_read_check/);
  });

  it("o papel da aplicação só altera o ponto de leitura e a última atividade", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chats set last_read_seq = 5, last_activity_at = now() where id = ${chat}::uuid`);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chats set person_id = ${second}::uuid where id = ${chat}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from ticket_chats where id = ${chat}::uuid`)).rejects.toThrow(/permission denied/);
  });
});

describe("ticket_chat_messages", () => {
  it("a conversa do chat: pessoa (da dona), assistente (com modelo)", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person, "pergunta");
    await chatMessage(t, chat, null, "resposta", "claude-opus-5-5");
  });

  it("mensagem de pessoa no chat tem de ser da dona do chat", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await expect(chatMessage(t, chat, second)).rejects.toThrow(/ticket_chat_messages_chat_owner_fkey/);
  });

  it("o chat tem de ser do mesmo ticket da mensagem", async () => {
    const t1 = await newTicket();
    const t2 = await newTicket();
    const chat = await newChat(t1, ids.person);
    await expect(chatMessage(t2, chat, ids.person)).rejects.toThrow(/ticket_chat_messages_chat_fkey/);
  });

  it("mora no chat ou na thread, nunca nos dois nem em nenhum", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    const id = randomUUID();
    await expect(owner.query("insert into ticket_chat_messages (org_id, id, project_id, ticket_id, chat_id, thread_id, author_person_id, body) values ($1,$2,$3,$4,$5,$2,$6,'x')", [ORG, id, ids.project, t, chat, ids.person])).rejects.toThrow(/ticket_chat_messages_home_check/);
    await expect(owner.query("insert into ticket_chat_messages (org_id, project_id, ticket_id, author_person_id, body) values ($1,$2,$3,$4,'x')", [ORG, ids.project, t, ids.person])).rejects.toThrow(/ticket_chat_messages_home_check/);
  });

  it("mensagem de thread nunca é do assistente", async () => {
    const t = await newTicket();
    const id = randomUUID();
    await expect(owner.query("insert into ticket_chat_messages (org_id, id, project_id, ticket_id, thread_id, body) values ($1,$2,$3,$4,$2,'x')", [ORG, id, ids.project, t])).rejects.toThrow(/ticket_chat_messages_thread_author_check/);
  });

  it("tamanho: pessoa até 4.000, assistente até 8.000, nunca vazio; modelo só no assistente", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person, "a".repeat(4000));
    await expect(chatMessage(t, chat, ids.person, "a".repeat(4001))).rejects.toThrow(/ticket_chat_messages_body_check/);
    await chatMessage(t, chat, null, "a".repeat(8000), "m");
    await expect(chatMessage(t, chat, null, "a".repeat(8001), "m")).rejects.toThrow(/ticket_chat_messages_body_check/);
    await expect(chatMessage(t, chat, ids.person, "")).rejects.toThrow(/ticket_chat_messages_body_check/);
    await expect(chatMessage(t, chat, ids.person, "x", "claude")).rejects.toThrow(/ticket_chat_messages_model_check/);
  });

  it("seq só cresce, inclusive entre duas mensagens da mesma transação (mesmo created_at)", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    const rows = await asTenant(prisma, ORG, async (tx) => {
      await tx.$executeRaw`insert into ticket_chat_messages (org_id, project_id, ticket_id, chat_id, author_person_id, body) values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${chat}::uuid, ${ids.person}::uuid, 'a')`;
      await tx.$executeRaw`insert into ticket_chat_messages (org_id, project_id, ticket_id, chat_id, body, model) values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${chat}::uuid, 'b', 'm')`;
      return tx.$queryRaw<{ seq: bigint; created_at: Date }[]>`select seq, created_at from ticket_chat_messages where chat_id = ${chat}::uuid order by seq`;
    });
    expect(rows[1]!.seq > rows[0]!.seq).toBe(true);
    expect(rows[1]!.created_at.getTime()).toBe(rows[0]!.created_at.getTime());
  });

  it("o seq não pode ser escolhido por quem insere", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await expect(owner.query("insert into ticket_chat_messages (org_id, seq, project_id, ticket_id, chat_id, author_person_id, body) values ($1,1,$2,$3,$4,$5,'x')", [ORG, ids.project, t, chat, ids.person])).rejects.toThrow(/non-DEFAULT/);
  });

  it("o papel da aplicação lê, insere e apaga mensagem, mas nunca a edita", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person, "pergunta");
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chat_messages set body = 'editada' where chat_id = ${chat}::uuid`)).rejects.toThrow(/permission denied/);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from ticket_chat_messages where chat_id = ${chat}::uuid`);
    expect((await owner.query("select count(*)::int as n from ticket_chat_messages where chat_id = $1", [chat])).rows[0].n).toBe(0);
  });
});

describe("threads", () => {
  it("a raiz aponta para si e a resposta aponta para a raiz", async () => {
    const t = await newTicket();
    const r = await root(t, ids.person);
    await reply(t, r, second);
    expect((await owner.query("select count(*)::int as n from ticket_chat_messages where thread_id = $1", [r])).rows[0].n).toBe(2);
  });

  it("uma resposta não pode apontar para outra resposta", async () => {
    const t = await newTicket();
    const r = await root(t, ids.person);
    await reply(t, r, second);
    const other = (await owner.query<{ id: string }>("select id from ticket_chat_messages where thread_id = $1 and id <> $1", [r])).rows[0]?.id ?? "";
    await expect(reply(t, other, ids.person)).rejects.toThrow(/ticket_chat_messages_thread_root/);
  });

  it("uma resposta não atravessa de um ticket para outro", async () => {
    const t1 = await newTicket();
    const t2 = await newTicket();
    const r = await root(t1, ids.person);
    await expect(reply(t2, r, ids.person)).rejects.toThrow(/ticket_chat_messages_thread_root/);
  });

  it("participantes: entram uma vez, de pessoa do mesmo ticket, e o papel da aplicação não os apaga nem muda", async () => {
    const t = await newTicket();
    const r = await root(t, ids.person);
    const add = (person: string) => owner.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ($1,$2,$3,$4,$5)", [ORG, r, person, ids.project, t]);
    await add(ids.person);
    await add(second);
    await expect(add(second)).rejects.toThrow(/ticket_chat_thread_members_pkey/);
    const t2 = await newTicket();
    const third = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'u3','Terceira','t@x.io','member') returning id", [ORG])).rows[0]?.id ?? "";
    await expect(owner.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ($1,$2,$3,$4,$5)", [ORG, r, third, ids.project, t2])).rejects.toThrow(/ticket_chat_thread_members_thread_fkey/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from ticket_chat_thread_members where thread_id = ${r}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chat_thread_members set person_id = ${ids.person}::uuid where thread_id = ${r}::uuid`)).rejects.toThrow(/permission denied/);
  });

  it("remover o ticket remove chats, mensagens (da conversa e das threads) e participantes", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person);
    const r = await root(t, ids.person);
    await reply(t, r, second);
    await owner.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ($1,$2,$3,$4,$5)", [ORG, r, ids.person, ids.project, t]);
    await owner.query("delete from tickets where id = $1", [t]);
    for (const table of ["ticket_chats", "ticket_chat_messages", "ticket_chat_thread_members"]) {
      expect((await owner.query(`select count(*)::int as n from ${table} where ticket_id = $1`, [t])).rows[0].n, table).toBe(0);
    }
  });

  it("a pessoa que escreveu numa thread não se apaga (a autoria sobrevive)", async () => {
    const t = await newTicket();
    const r = await root(t, second);
    await expect(owner.query("delete from people where id = $1", [second])).rejects.toThrow(/ticket_chat_messages_org_id_author_person_id_fkey/);
    expect(r).toBeTruthy();
  });
});

describe("isolamento por organização", () => {
  it("outra organização não vê nada, nem escreve", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person);
    const r = await root(t, ids.person);
    await owner.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ($1,$2,$3,$4,$5)", [ORG, r, ids.person, ids.project, t]);
    for (const table of ["ticket_chats", "ticket_chat_messages", "ticket_chat_thread_members"]) {
      const n = await asTenant(prisma, OTHER, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`));
      expect(n[0]?.n, table).toBe(0);
    }
    await expect(asTenant(prisma, OTHER, (tx) => tx.$executeRaw`insert into ticket_chats (org_id, project_id, ticket_id, person_id) values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${ids.person}::uuid)`)).rejects.toThrow(/row-level security/);
    expect(otherIds.person).toBeTruthy();
  });
});

describe("ticket_assignees: índice por pessoa (a lista \"Meus chats\")", () => {
  it("existe o índice (org_id, person_id, ticket_id)", async () => {
    const r = await owner.query("select 1 from pg_indexes where tablename = 'ticket_assignees' and indexname = 'ticket_assignees_org_id_person_id_ticket_id_idx'");
    expect(r.rowCount).toBe(1);
  });
});

describe("Revisão 1: o banco protege o que a ADR proíbe", () => {
  it("o papel da aplicação só apaga mensagem da conversa do chat: a de thread fica, mesmo pedida", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await chatMessage(t, chat, ids.person, "da conversa");
    const r = await root(t, ids.person);
    await reply(t, r, second);
    const gone = await asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from ticket_chat_messages where ticket_id = ${t}::uuid`);
    expect(gone).toBe(1);
    expect((await owner.query("select count(*)::int as n from ticket_chat_messages where thread_id = $1", [r])).rows[0].n).toBe(2);
    const direct = await asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from ticket_chat_messages where thread_id = ${r}::uuid`);
    expect(direct).toBe(0);
  });

  it("remover o ticket continua levando as mensagens de thread (a cascata não depende da política)", async () => {
    const t = await newTicket();
    await root(t, ids.person);
    await owner.query("delete from tickets where id = $1", [t]);
    expect((await owner.query("select count(*)::int as n from ticket_chat_messages where ticket_id = $1", [t])).rows[0].n).toBe(0);
  });

  it("participante só pode ser de uma RAIZ: apontar para uma resposta é recusado", async () => {
    const t = await newTicket();
    const r = await root(t, ids.person);
    await reply(t, r, second);
    const answer = (await owner.query<{ id: string }>("select id from ticket_chat_messages where thread_id = $1 and id <> $1", [r])).rows[0]?.id ?? "";
    const add = (thread: string) => owner.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ($1,$2,$3,$4,$5)", [ORG, thread, ids.person, ids.project, t]);
    await expect(add(answer)).rejects.toThrow(/ticket_chat_thread_members_root/);
    await expect(add(r)).resolves.toBeTruthy();
  });

  it("turn_started_at: o papel da aplicação altera só ele, além do ponto de leitura e da atividade", async () => {
    const t = await newTicket();
    const chat = await newChat(t, ids.person);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chats set turn_started_at = now() where id = ${chat}::uuid`);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_chats set turn_started_at = null where id = ${chat}::uuid`);
  });
});
