import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_K1 = "org_K1";
const ORG_K2 = "org_K2";

let owner: pg.Pool;
let prisma: PrismaClient;
let k1: Ids;
let k2: Ids;
let counter = 100;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  k1 = await seedOrg(owner, ORG_K1);
  k2 = await seedOrg(owner, ORG_K2);
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

/** Insere pelo papel de aplicação (`treepm_app`), com RLS, como a API faz. */
async function insertAsApp(orgId: string, ids: Ids, parentId: string | null): Promise<string> {
  const number = ++counter;
  return asTenant(prisma, orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id)
      values (${orgId}, ${ids.project}::uuid, ${number}, 'T', ${parentId}::uuid, ${ids.person}::uuid)
      returning id`;
    return rows[0]?.id ?? "";
  });
}

describe("tickets: tipo antigo removido (migration 0010)", () => {
  it("as colunas kind e parent_kind não existem mais", async () => {
    const r = await owner.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'tickets' and column_name in ('kind', 'parent_kind')",
    );
    expect(r.rows).toEqual([]);
  });

  it("o índice único com kind e a CHECK do tipo não existem mais", async () => {
    const idx = await owner.query("select 1 from pg_indexes where tablename = 'tickets' and indexname = 'tickets_org_id_project_id_id_kind_key'");
    expect(idx.rows).toEqual([]);
    const chk = await owner.query(
      "select conname from pg_constraint where conrelid = 'tickets'::regclass and conname in ('tickets_kind_check', 'tickets_parent_kind_check')",
    );
    expect(chk.rows).toEqual([]);
  });

  it("a chave do pai (org, projeto, id) e o índice que ela usa continuam", async () => {
    const fk = await owner.query("select 1 from pg_constraint where conrelid = 'tickets'::regclass and conname = 'tickets_org_id_project_id_parent_id_fkey'");
    expect(fk.rows).toHaveLength(1);
    const idx = await owner.query("select 1 from pg_indexes where tablename = 'tickets' and indexname = 'tickets_org_id_project_id_id_key'");
    expect(idx.rows).toHaveLength(1);
  });
});

describe("tickets.parent_id: chave do pai garantida pelo banco", () => {
  it("como treepm_app: filho de qualquer ticket, em qualquer nível", async () => {
    const parent = await insertAsApp(ORG_K1, k1, null);
    const child = await insertAsApp(ORG_K1, k1, parent);
    const grandchild = await insertAsApp(ORG_K1, k1, child);
    expect(grandchild).toBeTruthy();
  });

  it("como treepm_app: mover para dentro de outro ticket passa", async () => {
    const target = await insertAsApp(ORG_K1, k1, null);
    const mover = await insertAsApp(ORG_K1, k1, null);
    await asTenant(prisma, ORG_K1, (tx) =>
      tx.$executeRawUnsafe("update tickets set parent_id = $2::uuid where org_id = $1 and id = $3::uuid", ORG_K1, target, mover),
    );
    const r = await owner.query<{ parent_id: string }>("select parent_id from tickets where id = $1", [mover]);
    expect(r.rows[0]?.parent_id).toBe(target);
  });

  it("pai de outro projeto da mesma organização continua falhando (23503)", async () => {
    const other = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Outro', 'OUT') returning id",
      [ORG_K1],
    );
    const otherProject = other.rows[0]?.id ?? "";
    const foreign = await owner.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1, 'X', $3) returning id",
      [ORG_K1, otherProject, k1.person],
    );
    const parent = foreign.rows[0]?.id ?? "";
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id) values ($1, $2, 950, 'T', $3, $4)",
        [ORG_K1, k1.project, parent, k1.person],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("pai de outra organização continua falhando (23503) e o isolamento continua valendo", async () => {
    const group = await insertAsApp(ORG_K1, k1, null);
    await insertAsApp(ORG_K1, k1, group);
    const seen = await asTenant(prisma, ORG_K2, (tx) =>
      tx.$queryRaw<{ id: string }[]>`select id from tickets where parent_id is not null`,
    );
    expect(seen).toHaveLength(0);
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id) values ($1, $2, 904, 'T', $3, $4)",
        [ORG_K2, k2.project, group, k2.person],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("remover um pai que tem filhos continua falhando (23503)", async () => {
    const parent = await insertAsApp(ORG_K1, k1, null);
    await insertAsApp(ORG_K1, k1, parent);
    await expect(owner.query("delete from tickets where id = $1", [parent])).rejects.toMatchObject({ code: "23503" });
  });
});
