import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

// Migration 0032 (ADR 0054, adendo): a criação registra de que tipo foi a escolha do lugar. É a única coluna da decisão que o
// papel da aplicação edita além das duas de dono (ticket_id e conversation_id).
const ORG = "org_DEC32";
const prisma = appPrisma();
let owner: pg.Pool;
let ids: Ids;

beforeAll(async () => {
  owner = ownerPool();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const decided = async (): Promise<string> => {
  const conversation = (await owner.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id) values ($1,$2,$3) returning id", [ORG, ids.project, ids.person])).rows[0]?.id ?? "";
  await owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain) values ($1,$2,$3,false)", [ORG, ids.project, conversation]);
  return conversation;
};

describe("placement_decisions 0032", () => {
  it("`placed_by` nasce nula: decisão sem criação e linhas anteriores seguem válidas", async () => {
    const conversation = await decided();
    expect((await owner.query("select placed_by from placement_decisions where conversation_id = $1", [conversation])).rows[0]).toEqual({ placed_by: null });
  });

  it("só os cinco tipos de escolha valem", async () => {
    const conversation = await decided();
    for (const value of ["search", "option", "stay", "recent", "map"]) {
      await owner.query("update placement_decisions set placed_by = $2 where conversation_id = $1", [conversation, value]);
    }
    await expect(owner.query("update placement_decisions set placed_by = 'outro' where conversation_id = $1", [conversation])).rejects.toThrow(/placed_by_check/);
    await expect(owner.query("update placement_decisions set placed_by = '' where conversation_id = $1", [conversation])).rejects.toThrow(/placed_by_check/);
  });

  it("o papel da aplicação edita `placed_by` e continua sem poder editar o resultado da decisão", async () => {
    const conversation = await decided();
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set placed_by = 'map' where conversation_id = ${conversation}::uuid`);
    expect((await owner.query("select placed_by from placement_decisions where conversation_id = $1", [conversation])).rows[0]).toEqual({ placed_by: "map" });
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set uncertain = true where conversation_id = ${conversation}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update placement_decisions set placed_by = 'nenhum' where conversation_id = ${conversation}::uuid`)).rejects.toThrow(/placed_by_check/);
  });
});
