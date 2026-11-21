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
async function insertAsApp(
  orgId: string,
  ids: Ids,
  kind: "ticket" | "group",
  parentId: string | null,
  options: { parentKind?: "group" | null } = {},
): Promise<string> {
  const parentKind = parentId === null ? null : options.parentKind === undefined ? "group" : options.parentKind;
  const number = ++counter;
  return asTenant(prisma, orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into tickets (org_id, project_id, number, title, kind, parent_id, parent_kind, created_by_person_id)
      values (${orgId}, ${ids.project}::uuid, ${number}, 'T', ${kind}, ${parentId}::uuid,
              ${parentKind}, ${ids.person}::uuid)
      returning id`;
    return rows[0]?.id ?? "";
  });
}

async function updateAsApp(orgId: string, sql: string, params: unknown[]): Promise<void> {
  await asTenant(prisma, orgId, (tx) => tx.$executeRawUnsafe(sql, ...params));
}

describe("tickets.kind: tipo declarado e garantido pelo banco", () => {
  it("o tipo padrão é ticket e só aceita ticket ou group (23514)", async () => {
    const r = await owner.query<{ kind: string }>("select kind from tickets where org_id = $1 and id = $2", [
      ORG_K1,
      k1.ticket,
    ]);
    expect(r.rows[0]?.kind).toBe("ticket");
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, kind, created_by_person_id) values ($1, $2, 900, 'T', 'folder', $3)",
        [ORG_K1, k1.project, k1.person],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("o tipo continua guardado e aceito como antes (ADR 0034: as colunas ficam até a migration seguinte)", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    const r = await owner.query<{ kind: string }>("select kind from tickets where org_id = $1 and id = $2", [ORG_K1, group]);
    expect(r.rows[0]?.kind).toBe("group");
  });

  it("parent_kind aceita nulo com pai (o código novo não o grava) e não é mais exigido", async () => {
    const parent = await insertAsApp(ORG_K1, k1, "ticket", null);
    const child = await insertAsApp(ORG_K1, k1, "ticket", parent, { parentKind: null });
    expect(child).toBeTruthy();
    const r = await owner.query<{ parent_kind: string | null }>("select parent_kind from tickets where id = $1", [child]);
    expect(r.rows[0]?.parent_kind).toBeNull();
  });

  it("como treepm_app: filho de uma linha kind='ticket' com parent_kind nulo passa", async () => {
    const parent = await insertAsApp(ORG_K1, k1, "ticket", null);
    const child = await insertAsApp(ORG_K1, k1, "ticket", parent, { parentKind: null });
    const grandchild = await insertAsApp(ORG_K1, k1, "ticket", child, { parentKind: null });
    expect(grandchild).toBeTruthy();
  });

  it("como treepm_app: o jeito antigo (parent_kind='group' sob kind='group') também passa", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    const inner = await insertAsApp(ORG_K1, k1, "group", group);
    const ticket = await insertAsApp(ORG_K1, k1, "ticket", inner);
    expect([group, inner, ticket].every(Boolean)).toBe(true);
  });

  it("como treepm_app: mudar kind de um nó que tem filhos, e mover para dentro de um ticket, passam", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await insertAsApp(ORG_K1, k1, "ticket", group);
    await updateAsApp(ORG_K1, "update tickets set kind = 'ticket' where org_id = $1 and id = $2::uuid", [ORG_K1, group]);
    const target = await insertAsApp(ORG_K1, k1, "ticket", null);
    const mover = await insertAsApp(ORG_K1, k1, "ticket", null);
    await updateAsApp(ORG_K1, "update tickets set parent_id = $2::uuid, parent_kind = null where org_id = $1 and id = $3::uuid", [
      ORG_K1,
      target,
      mover,
    ]);
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
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await insertAsApp(ORG_K1, k1, "ticket", group);
    const seen = await asTenant(prisma, ORG_K2, (tx) =>
      tx.$queryRaw<{ id: string }[]>`select id from tickets where kind = 'group' or parent_kind = 'group'`,
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
    const parent = await insertAsApp(ORG_K1, k1, "ticket", null);
    await insertAsApp(ORG_K1, k1, "ticket", parent, { parentKind: null });
    await expect(owner.query("delete from tickets where id = $1", [parent])).rejects.toMatchObject({ code: "23503" });
  });
});
