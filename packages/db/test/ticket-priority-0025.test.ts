import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0025 (ADR 0047): `tickets.priority`, inteiro de -999 a 999, 0 por padrão.
const ORG = "org_PRIO";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 700;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function insert(priority?: number): Promise<string> {
  const number = ++counter;
  return asTenant(prisma, ORG, async (tx) => {
    const rows =
      priority === undefined
        ? await tx.$queryRaw<{ id: string }[]>`
            insert into tickets (org_id, project_id, number, title, created_by_person_id)
            values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${ids.person}::uuid) returning id`
        : await tx.$queryRaw<{ id: string }[]>`
            insert into tickets (org_id, project_id, number, title, priority, created_by_person_id)
            values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${priority}, ${ids.person}::uuid) returning id`;
    return rows[0]?.id ?? "";
  });
}

describe("tickets.priority (migration 0025)", () => {
  it("ticket novo nasce com prioridade 0", async () => {
    const id = await insert();
    const r = await owner.query("select priority from tickets where id = $1", [id]);
    expect(r.rows[0].priority).toBe(0);
  });

  it.each([0, 1, -1, 999, -999])("aceita %i", async (value) => {
    const id = await insert(value);
    const r = await owner.query("select priority from tickets where id = $1", [id]);
    expect(r.rows[0].priority).toBe(value);
  });

  it.each([1000, -1000])("recusa %i (check do intervalo)", async (value) => {
    await expect(insert(value)).rejects.toThrow(/tickets_priority_range_check/);
  });

  it("a coluna não aceita nulo", async () => {
    await expect(
      asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set priority = null where org_id = ${ORG}`),
    ).rejects.toThrow(/null value|not-null|violates/i);
  });

  it("o papel da aplicação consegue mudar a prioridade de um ticket", async () => {
    const id = await insert();
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set priority = 7 where id = ${id}::uuid`);
    const r = await owner.query("select priority from tickets where id = $1", [id]);
    expect(r.rows[0].priority).toBe(7);
  });
});
