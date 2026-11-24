import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0035 (ADR 0056, fatia 2): conversations.purpose, title, ticket_conversation_id; thread de assunto com um participante só.
const ORG = "org_CONV35";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let second: string;
let number = 100;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
  second = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'u2','u2','u2@x.io','member') returning id", [ORG])).rows[0]?.id ?? "";
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function inTx<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("begin");
    const out = await run(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function principal(kind: "ticket" | "general", person: string, withTicket = false): Promise<string> {
  const id = randomUUID();
  let ticket: string | null = null;
  if (withTicket) ticket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'T',$4) returning id", [ORG, ids.project, ++number, ids.person])).rows[0]?.id ?? null;
  await inTx(async (c) => {
    await c.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, root_id) values ($1,$2,$3,$4,$5,$6,$2)", [ORG, id, kind, person, ticket ? ids.project : null, ticket]);
    await c.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, id, person]);
  });
  return id;
}

/** Abre uma thread sob `parent`; os participantes (e o propósito) são o que o teste pedir. */
async function thread(parent: string, openedBy: string, purpose: string | null, participants: string[], extra: { title?: string | null; openingBy?: string } = {}): Promise<string> {
  const id = randomUUID();
  await inTx(async (c) => {
    const opening = (await c.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ($1,$2,$3,'abre') returning id", [ORG, parent, extra.openingBy ?? openedBy])).rows[0]?.id;
    const p = (await c.query<{ depth: number; root_id: string; project_id: string | null; ticket_id: string | null }>("select depth, root_id, project_id, ticket_id from conversations where id = $1", [parent])).rows[0]!;
    await c.query("insert into conversations (org_id, id, kind, purpose, title, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$7,$8,$9,$10,$11)", [ORG, id, purpose, extra.title ?? null, openedBy, p.project_id, p.ticket_id, parent, p.root_id, p.depth + 1, opening]);
    for (const person of participants) await c.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, id, person]);
  });
  return id;
}

describe("purpose", () => {
  it("nas principais é nulo; nas threads é people, topic ou creation (CHECK de forma)", async () => {
    const p = await principal("ticket", ids.person, true);
    await expect(owner.query("update conversations set purpose = 'topic' where id = $1", [p])).rejects.toThrow(/conversations_purpose_check/);
    await expect(thread(p, ids.person, null, [ids.person])).rejects.toThrow(/conversations_purpose_check/);
    await expect(thread(p, ids.person, "outro", [ids.person])).rejects.toThrow(/conversations_purpose_check/);
    await expect(thread(p, ids.person, "people", [ids.person])).resolves.toBeTruthy();
    await expect(thread(p, ids.person, "topic", [ids.person])).resolves.toBeTruthy();
    await expect(thread(p, ids.person, "creation", [ids.person])).resolves.toBeTruthy();
  });

  it("o papel da aplicação não altera purpose nem o elo da conversa de criação, mas altera title", async () => {
    const p = await principal("ticket", ids.person, true);
    const t = await thread(p, ids.person, "topic", [ids.person]);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set purpose = 'people' where id = ${t}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set ticket_conversation_id = null where id = ${t}::uuid`)).rejects.toThrow(/permission denied/);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set title = 'Meu assunto' where id = ${t}::uuid`);
    const row = (await owner.query<{ title: string }>("select title from conversations where id = $1", [t])).rows[0];
    expect(row?.title).toBe("Meu assunto");
  });

  it("title: 1 a 60 caracteres, aparado, sem ponto final, só em thread de assunto ou de criação", async () => {
    const p = await principal("ticket", ids.person, true);
    await expect(thread(p, ids.person, "topic", [ids.person], { title: "x".repeat(61) })).rejects.toThrow(/conversations_title_check/);
    await expect(thread(p, ids.person, "topic", [ids.person], { title: "" })).rejects.toThrow(/conversations_title_check/);
    await expect(thread(p, ids.person, "topic", [ids.person], { title: "Acaba em ponto." })).rejects.toThrow(/conversations_title_check/);
    await expect(thread(p, ids.person, "topic", [ids.person], { title: " com espaço " })).rejects.toThrow(/conversations_title_check/);
    await expect(thread(p, ids.person, "people", [ids.person], { title: "Não cabe aqui" })).rejects.toThrow(/conversations_title_check/);
    await expect(thread(p, ids.person, "topic", [ids.person], { title: "x".repeat(60) })).resolves.toBeTruthy();
  });

  it("ticket_conversation_id só vale em thread creation, na mesma organização", async () => {
    const p = await principal("ticket", ids.person, true);
    const t = await thread(p, ids.person, "topic", [ids.person]);
    const tc = (await owner.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id) values ($1,$2,$3) returning id", [ORG, ids.project, ids.person])).rows[0]?.id;
    await expect(owner.query("update conversations set ticket_conversation_id = $2 where id = $1", [t, tc])).rejects.toThrow(/conversations_ticket_conversation_check/);
    const c = await thread(p, ids.person, "creation", [ids.person]);
    await owner.query("update conversations set ticket_conversation_id = $2 where id = $1", [c, tc]);
    await expect(owner.query("update conversations set ticket_conversation_id = $2 where id = $1", [c, randomUUID()])).rejects.toThrow(/conversations_ticket_conversation_fkey/);
    // Apagar a conversa de novo ticket solta o elo.
    await owner.query("delete from ticket_conversations where id = $1", [tc]);
    expect((await owner.query("select ticket_conversation_id from conversations where id = $1", [c])).rows[0]?.ticket_conversation_id).toBeNull();
  });
});

describe("thread de assunto: um participante só", () => {
  it("nasce com a dona e mais ninguém; segunda pessoa é recusada por inserção direta", async () => {
    const p = await principal("ticket", ids.person, true);
    for (const purpose of ["topic", "creation"]) {
      await expect(thread(p, ids.person, purpose, [ids.person, second])).rejects.toThrow(/conversation_participants_private/);
      const t = await thread(p, ids.person, purpose, [ids.person]);
      await expect(owner.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, t, second])).rejects.toThrow(/conversation_participants_private/);
    }
  });

  it("segunda pessoa é recusada também pela transação do papel da aplicação", async () => {
    const p = await principal("ticket", ids.person, true);
    const t = await thread(p, ids.person, "topic", [ids.person]);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`insert into conversation_participants (org_id, conversation_id, person_id, added_by_person_id) values (${ORG}, ${t}::uuid, ${second}::uuid, ${ids.person}::uuid)`)).rejects.toThrow(/conversation_participants_private/);
    // Uma thread entre pessoas, ao contrário, aceita.
    const people = await thread(p, ids.person, "people", [ids.person]);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`insert into conversation_participants (org_id, conversation_id, person_id, added_by_person_id) values (${ORG}, ${people}::uuid, ${second}::uuid, ${ids.person}::uuid)`);
  });

  it("só nasce dentro de conversa principal da própria pessoa", async () => {
    const mine = await principal("ticket", ids.person, true);
    const others = await principal("ticket", second, true);
    // A thread de outra pessoa dentro da principal alheia (a dona da thread não é a da principal).
    await expect(thread(others, ids.person, "topic", [ids.person], { openingBy: second })).rejects.toThrow(/conversations_purpose_parent/);
    // Dentro de uma thread (de qualquer propósito), não.
    const people = await thread(mine, ids.person, "people", [ids.person]);
    await expect(thread(people, ids.person, "topic", [ids.person])).rejects.toThrow(/conversations_purpose_parent/);
    const topic = await thread(mine, ids.person, "topic", [ids.person]);
    await expect(thread(topic, ids.person, "topic", [ids.person])).rejects.toThrow(/conversations_purpose_parent/);
    // Mas uma thread entre pessoas cabe dentro de uma de assunto (as pessoas marcadas ficam na filha, não na de assunto).
    await expect(thread(topic, ids.person, "people", [ids.person, second])).resolves.toBeTruthy();
  });

  it("o assistente escreve em topic e continua proibido em people", async () => {
    const p = await principal("ticket", ids.person, true);
    const topic = await thread(p, ids.person, "topic", [ids.person]);
    const people = await thread(p, ids.person, "people", [ids.person]);
    await owner.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body, model) values ($1,$2,null,'oi','m')", [ORG, topic]);
    await expect(owner.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body, model) values ($1,$2,null,'oi','m')", [ORG, people])).rejects.toThrow(/conversation_messages_author/);
    // Thread de criação (fatia 3) ainda não: o assistente só fala em assunto.
    const creation = await thread(p, ids.person, "creation", [ids.person]);
    await expect(owner.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body, model) values ($1,$2,null,'oi','m')", [ORG, creation])).rejects.toThrow(/conversation_messages_author/);
  });
});
