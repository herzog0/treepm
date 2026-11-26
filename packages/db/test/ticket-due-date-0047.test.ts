import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0047 (ADR 0064): `tickets.due_date`, data de calendário (tipo `date`, sem hora), nula por padrão, de 2000-01-01 a 2100-12-31.
const ORG = "org_DUE";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 900;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function insert(dueDate?: string): Promise<string> {
  const number = ++counter;
  return asTenant(prisma, ORG, async (tx) => {
    const rows =
      dueDate === undefined
        ? await tx.$queryRaw<{ id: string }[]>`
            insert into tickets (org_id, project_id, number, title, created_by_person_id)
            values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${ids.person}::uuid) returning id`
        : await tx.$queryRaw<{ id: string }[]>`
            insert into tickets (org_id, project_id, number, title, due_date, created_by_person_id)
            values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${dueDate}::date, ${ids.person}::uuid) returning id`;
    return rows[0]?.id ?? "";
  });
}

const read = async (id: string): Promise<string | null> =>
  (await owner.query("select to_char(due_date, 'YYYY-MM-DD') as d from tickets where id = $1", [id])).rows[0].d as string | null;

describe("tickets.due_date (migration 0047)", () => {
  it("a coluna é do tipo date e aceita nulo", async () => {
    const r = await owner.query("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'tickets' and column_name = 'due_date'");
    expect(r.rows[0]).toEqual({ data_type: "date", is_nullable: "YES", column_default: null });
  });

  it("ticket novo nasce sem prazo", async () => {
    expect(await read(await insert())).toBeNull();
  });

  it.each(["2026-12-12", "2000-01-01", "2100-12-31"])("aceita %s e devolve a mesma data", async (value) => {
    expect(await read(await insert(value))).toBe(value);
  });

  it.each(["1999-12-31", "2101-01-01"])("recusa %s (check da faixa)", async (value) => {
    await expect(insert(value)).rejects.toThrow(/tickets_due_date_range_check/);
  });

  it("o papel da aplicação põe e tira o prazo", async () => {
    const id = await insert();
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set due_date = '2026-12-12'::date where id = ${id}::uuid`);
    expect(await read(id)).toBe("2026-12-12");
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set due_date = null where id = ${id}::uuid`);
    expect(await read(id)).toBeNull();
  });

  it("pelo Prisma, a data volta como meia-noite UTC do mesmo dia (sem fuso)", async () => {
    const id = await insert("2026-12-12");
    const row = await asTenant(prisma, ORG, (tx) => tx.ticket.findFirstOrThrow({ where: { id }, select: { dueDate: true } }));
    expect(row.dueDate?.toISOString()).toBe("2026-12-12T00:00:00.000Z");
  });
});
