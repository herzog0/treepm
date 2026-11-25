import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0036 (ADR 0059, TREEPM-417): conversation_participants.closed_seq, a marca de quem fechou a conversa.
const ORG = "org_CONV36";
let owner: pg.Pool;
let prisma: PrismaClient;
let person: string;
let conv: string;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  const ids = await seedOrg(owner, ORG);
  person = ids.person;
  conv = randomUUID();
  const c = await owner.connect();
  try {
    await c.query("begin");
    await c.query("insert into conversations (org_id, id, kind, owner_person_id, root_id) values ($1,$2,'general',$3,$2)", [ORG, conv, person]);
    await c.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, conv, person]);
    await c.query("commit");
  } finally {
    c.release();
  }
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

describe("migration 0036: closed_seq", () => {
  it("nasce nula: tudo o que existe está aberto", async () => {
    const row = (await owner.query<{ closed_seq: string | null }>("select closed_seq from conversation_participants where conversation_id = $1", [conv])).rows[0];
    expect(row?.closed_seq).toBeNull();
  });

  it("o papel da aplicação altera closed_seq e last_read_seq, e só elas", async () => {
    await asTenant(prisma, ORG, async (tx) => {
      await tx.conversationParticipant.updateMany({ where: { conversationId: conv, personId: person }, data: { closedSeq: 7n } });
      await tx.conversationParticipant.updateMany({ where: { conversationId: conv, personId: person }, data: { lastReadSeq: 3n } });
    });
    const row = (await owner.query<{ closed_seq: string; last_read_seq: string }>("select closed_seq, last_read_seq from conversation_participants where conversation_id = $1", [conv])).rows[0];
    expect(row).toEqual({ closed_seq: "7", last_read_seq: "3" });
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update conversation_participants set added_at = now() where conversation_id = $1::uuid", conv))).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update conversation_participants set person_id = person_id where conversation_id = $1::uuid", conv))).rejects.toThrow(/permission denied/);
  });

  it("recusa marca negativa e aceita voltar a nula", async () => {
    await expect(owner.query("update conversation_participants set closed_seq = -1 where conversation_id = $1", [conv])).rejects.toThrow(/closed_check/);
    await asTenant(prisma, ORG, (tx) => tx.conversationParticipant.updateMany({ where: { conversationId: conv, personId: person }, data: { closedSeq: null } }));
    const row = (await owner.query<{ closed_seq: string | null }>("select closed_seq from conversation_participants where conversation_id = $1", [conv])).rows[0];
    expect(row?.closed_seq).toBeNull();
  });
});
