import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0028 (ADR 0052, item 5): placement_decisions. Só identificadores e números; o dono é a conversa ou o ticket criado.
const ORG = "org_DEC";
const OTHER = "org_DEC_B";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let otherIds: Ids;
let number = 500;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
  otherIds = await seedOrg(owner, OTHER);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const newTicket = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'T',$4) returning id", [ORG, ids.project, ++number, ids.person])).rows[0]?.id ?? "";
const newConversation = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id) values ($1,$2,$3) returning id", [ORG, ids.project, ids.person])).rows[0]?.id ?? "";
const decide = (conversation: string | null, ticket: string | null) =>
  owner.query("insert into placement_decisions (org_id, project_id, conversation_id, ticket_id, uncertain) values ($1,$2,$3,$4,false)", [ORG, ids.project, conversation, ticket]);

describe("placement_decisions", () => {
  it("tem sempre dono: a conversa ou o ticket criado", async () => {
    await expect(decide(null, null)).rejects.toThrow(/placement_decisions_owner_check/);
  });

  it("uma decisão por conversa, e a procura nova a substitui (índice único)", async () => {
    const conversation = await newConversation();
    await decide(conversation, null);
    await expect(decide(conversation, null)).rejects.toThrow(/placement_decisions_org_id_conversation_id_key/);
  });

  it("o motivo da parada e a forma do JSON são conferidos", async () => {
    const conversation = await newConversation();
    await expect(owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain, stop_reason) values ($1,$2,$3,false,'qualquer')", [ORG, ids.project, conversation])).rejects.toThrow(/stop_reason_check/);
    await expect(owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain, levels) values ($1,$2,$3,false,'{}')", [ORG, ids.project, conversation])).rejects.toThrow(/levels_check/);
    await expect(owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain, scope_fit) values ($1,$2,$3,false,1.5)", [ORG, ids.project, conversation])).rejects.toThrow(/scope_fit_check/);
  });

  it("apagar a conversa apaga a decisão dela; a que já passou ao ticket criado sobrevive", async () => {
    const kept = await newConversation();
    const dropped = await newConversation();
    const ticket = await newTicket();
    await decide(kept, null);
    await decide(dropped, null);
    // Troca de dono ao criar o ticket: o papel da aplicação pode mudar só estas duas colunas.
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set ticket_id = ${ticket}::uuid, conversation_id = null where conversation_id = ${kept}::uuid`);
    await owner.query("delete from ticket_conversations where id = any($1::uuid[])", [[kept, dropped]]);
    expect((await owner.query("select 1 from placement_decisions where ticket_id = $1", [ticket])).rowCount).toBe(1);
    expect((await owner.query("select 1 from placement_decisions where conversation_id = any($1::uuid[])", [[kept, dropped]])).rowCount).toBe(0);
    await owner.query("delete from tickets where id = $1", [ticket]);
    expect((await owner.query("select 1 from placement_decisions where ticket_id = $1", [ticket])).rowCount).toBe(0);
  });

  it("o papel da aplicação não edita o resultado da decisão", async () => {
    const conversation = await newConversation();
    await decide(conversation, null);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set uncertain = true where conversation_id = ${conversation}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set levels = '[]' where conversation_id = ${conversation}::uuid`)).rejects.toThrow(/permission denied/);
  });

  it("isolamento por organização: outra organização não lê, não grava e não apaga", async () => {
    const conversation = await newConversation();
    await decide(conversation, null);
    const seen = await asTenant(prisma, OTHER, (tx) => tx.placementDecision.findMany({ where: { conversationId: conversation } }));
    expect(seen).toEqual([]);
    await expect(
      asTenant(prisma, OTHER, (tx) => tx.$executeRaw`insert into placement_decisions (org_id, project_id, conversation_id, uncertain) values (${ORG}, ${ids.project}::uuid, ${conversation}::uuid, false)`),
    ).rejects.toThrow();
    const removed = await asTenant(prisma, OTHER, (tx) => tx.$executeRaw`delete from placement_decisions where conversation_id = ${conversation}::uuid`);
    expect(removed).toBe(0);
    expect(otherIds.project).not.toBe(ids.project);
    expect((await owner.query("select 1 from placement_decisions where conversation_id = $1", [conversation])).rowCount).toBe(1);
  });
});
