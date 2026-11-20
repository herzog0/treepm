import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/index.js";
import { ORG_A, ORG_B, appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

let owner: pg.Pool;
let app: PrismaClient;
let a: Ids;
let b: Ids;

beforeAll(() => {
  owner = ownerPool();
  app = appPrisma();
});
afterAll(async () => {
  await app.$disconnect();
  await owner.end();
});
beforeEach(async () => {
  await owner.query("truncate organizations cascade");
  a = await seedOrg(owner, ORG_A);
  b = await seedOrg(owner, ORG_B);
});

const FK = { code: "23503" };
const CHECK = { code: "23514" };
const UNIQUE = { code: "23505" };

describe("conversas de criação — chaves estrangeiras compostas com org_id", () => {
  it("a mensagem não aponta para conversa de outra organização", async () => {
    await expect(
      owner.query(
        "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ($1, $2, 1, 'person', 'x')",
        [ORG_A, b.conversation],
      ),
    ).rejects.toMatchObject(FK);
  });

  it("a conversa não tem autora nem projeto de outra organização", async () => {
    await expect(
      owner.query(
        "insert into ticket_conversations (org_id, project_id, author_person_id, status) values ($1, $2, $3, 'open')",
        [ORG_A, a.project, b.person],
      ),
    ).rejects.toMatchObject(FK);
    await expect(
      owner.query(
        "insert into ticket_conversations (org_id, project_id, author_person_id, status) values ($1, $2, $3, 'open')",
        [ORG_A, b.project, a.person],
      ),
    ).rejects.toMatchObject(FK);
  });

  it("o ticket criado precisa ser do projeto da conversa", async () => {
    const other = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Outro', 'OUT') returning id",
      [ORG_A],
    );
    const otherTicket = await owner.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1, 'T', $3) returning id",
      [ORG_A, other.rows[0]?.id, a.person],
    );
    await expect(
      owner.query("update ticket_conversations set created_ticket_id = $2 where id = $1", [
        a.conversation,
        otherTicket.rows[0]?.id,
      ]),
    ).rejects.toMatchObject(FK);
  });

  it("o resumo só existe para ticket do projeto informado e da mesma organização", async () => {
    const other = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Outro', 'OUT') returning id",
      [ORG_A],
    );
    const bare = await owner.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 2, 'Sem resumo', $3) returning id",
      [ORG_A, a.project, a.person],
    );
    await expect(
      owner.query(
        "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, model) values ($1, $2, $3, 's', 'm', 'x')",
        [ORG_A, other.rows[0]?.id, bare.rows[0]?.id],
      ),
    ).rejects.toMatchObject(FK);
    await expect(
      owner.query(
        "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, model) values ($1, $2, $3, 's', 'm', 'x')",
        [ORG_A, a.project, b.ticket],
      ),
    ).rejects.toMatchObject(FK);
  });
});

describe("conversas de criação — remoções em cascata", () => {
  it("apagar a conversa apaga as mensagens e mantém o ticket criado", async () => {
    await owner.query("update ticket_conversations set created_ticket_id = $2, status = 'ticket_created' where id = $1", [
      a.conversation,
      a.ticket,
    ]);
    await asTenant(app, ORG_A, (tx) => tx.$executeRaw`delete from ticket_conversations where id = ${a.conversation}::uuid`);
    const messages = await owner.query("select 1 from ticket_conversation_messages where conversation_id = $1", [a.conversation]);
    expect(messages.rowCount).toBe(0);
    const ticket = await owner.query("select 1 from tickets where id = $1", [a.ticket]);
    expect(ticket.rowCount).toBe(1);
  });

  it("remover um ticket remove o resumo do ramo dele", async () => {
    await asTenant(app, ORG_A, (tx) => tx.$executeRaw`delete from tickets where id = ${a.ticket}::uuid`);
    const summary = await owner.query("select 1 from branch_summaries where ticket_id = $1", [a.ticket]);
    expect(summary.rowCount).toBe(0);
  });

  it("remover o ticket criado mantém a conversa e desfaz só a referência", async () => {
    await owner.query("update ticket_conversations set created_ticket_id = $2, status = 'ticket_created' where id = $1", [
      a.conversation,
      a.ticket,
    ]);
    await asTenant(app, ORG_A, (tx) => tx.$executeRaw`delete from tickets where id = ${a.ticket}::uuid`);
    const row = await owner.query("select status, created_ticket_id, project_id from ticket_conversations where id = $1", [
      a.conversation,
    ]);
    expect(row.rows).toEqual([{ status: "ticket_created", created_ticket_id: null, project_id: a.project }]);
  });

  it("remover a pessoa ou o projeto leva as conversas dela junto", async () => {
    await owner.query("delete from projects where id = $1", [a.project]);
    expect((await owner.query("select 1 from ticket_conversations where org_id = $1", [ORG_A])).rowCount).toBe(0);
    expect((await owner.query("select 1 from ticket_conversation_messages where org_id = $1", [ORG_A])).rowCount).toBe(0);
  });
});

describe("conversas de criação — regras no banco", () => {
  it("rejeita situação inválida", async () => {
    await expect(owner.query("update ticket_conversations set status = 'qualquer' where id = $1", [a.conversation])).rejects.toMatchObject(CHECK);
  });

  it("o rascunho é completo ou ausente, com os limites do ticket", async () => {
    await expect(owner.query("update ticket_conversations set draft_title = 'x' where id = $1", [a.conversation])).rejects.toMatchObject(CHECK);
    await expect(
      owner.query("update ticket_conversations set draft_title = '   ', draft_description = '' where id = $1", [a.conversation]),
    ).rejects.toMatchObject(CHECK);
    await expect(
      owner.query("update ticket_conversations set draft_title = $2, draft_description = '' where id = $1", [a.conversation, "x".repeat(201)]),
    ).rejects.toMatchObject(CHECK);
    await expect(
      owner.query("update ticket_conversations set draft_title = 't', draft_description = $2 where id = $1", [a.conversation, "x".repeat(20_001)]),
    ).rejects.toMatchObject(CHECK);
    await owner.query("update ticket_conversations set draft_title = $2, draft_description = $3 where id = $1", [
      a.conversation,
      "x".repeat(200),
      "y".repeat(20_000),
    ]);
  });

  it("um ticket vem de no máximo uma conversa", async () => {
    await owner.query("update ticket_conversations set created_ticket_id = $2 where id = $1", [a.conversation, a.ticket]);
    const second = await owner.query<{ id: string }>(
      "insert into ticket_conversations (org_id, project_id, author_person_id, status) values ($1, $2, $3, 'open') returning id",
      [ORG_A, a.project, a.person],
    );
    await expect(
      owner.query("update ticket_conversations set created_ticket_id = $2 where id = $1", [second.rows[0]?.id, a.ticket]),
    ).rejects.toMatchObject(UNIQUE);
  });

  it("mensagens têm posição única por conversa, autor válido e texto não vazio", async () => {
    await expect(
      owner.query(
        "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ($1, $2, 1, 'assistant', 'x')",
        [ORG_A, a.conversation],
      ),
    ).rejects.toMatchObject(UNIQUE);
    await expect(
      owner.query(
        "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ($1, $2, 2, 'robo', 'x')",
        [ORG_A, a.conversation],
      ),
    ).rejects.toMatchObject(CHECK);
    await expect(
      owner.query(
        "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ($1, $2, 2, 'person', '')",
        [ORG_A, a.conversation],
      ),
    ).rejects.toMatchObject(CHECK);
  });

  it("o resumo cabe em 600 caracteres e é único por ticket", async () => {
    await expect(
      owner.query("update branch_summaries set summary = $2 where ticket_id = $1", [a.ticket, "x".repeat(601)]),
    ).rejects.toMatchObject(CHECK);
    await owner.query("update branch_summaries set summary = $2 where ticket_id = $1", [a.ticket, "x".repeat(600)]);
    await expect(
      owner.query(
        "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, model) values ($1, $2, $3, 's', 'm', 'x')",
        [ORG_A, a.project, a.ticket],
      ),
    ).rejects.toMatchObject(UNIQUE);
  });

  it("o papel de aplicação lê, escreve e apaga as três tabelas na própria organização", async () => {
    const counts = await asTenant(app, ORG_A, async (tx) => ({
      conversations: await tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from ticket_conversations`,
      messages: await tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from ticket_conversation_messages`,
      summaries: await tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from branch_summaries`,
    }));
    expect(counts.conversations[0]?.n).toBe(1);
    expect(counts.messages[0]?.n).toBe(1);
    expect(counts.summaries[0]?.n).toBe(1);
  });
});
