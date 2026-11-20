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
): Promise<string> {
  const number = ++counter;
  return asTenant(prisma, orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into tickets (org_id, project_id, number, title, kind, parent_id, parent_kind, created_by_person_id)
      values (${orgId}, ${ids.project}::uuid, ${number}, 'T', ${kind}, ${parentId}::uuid,
              ${parentId === null ? null : "group"}, ${ids.person}::uuid)
      returning id`;
    return rows[0]?.id ?? "";
  });
}

/** O SQLSTATE do erro do Prisma com o adaptador pg (`meta.driverAdapterError.cause.originalCode`). */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta;
    return meta?.driverAdapterError?.cause?.originalCode ?? "outro";
  }
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

  it("parent_kind é nulo se e só se parent_id é nulo, e só aceita group (23514)", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, parent_kind, created_by_person_id) values ($1, $2, 901, 'T', $3, null, $4)",
        [ORG_K1, k1.project, group, k1.person],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, parent_kind, created_by_person_id) values ($1, $2, 902, 'T', null, 'group', $3)",
        [ORG_K1, k1.project, k1.person],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, parent_kind, created_by_person_id) values ($1, $2, 903, 'T', $3, 'ticket', $4)",
        [ORG_K1, k1.project, group, k1.person],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("como treepm_app: filho de agrupador, agrupador dentro de agrupador e ticket na raiz passam", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    const inner = await insertAsApp(ORG_K1, k1, "group", group);
    const ticket = await insertAsApp(ORG_K1, k1, "ticket", inner);
    const root = await insertAsApp(ORG_K1, k1, "ticket", null);
    expect([group, inner, ticket, root].every(Boolean)).toBe(true);
  });

  it("como treepm_app: inserir filho de um nó ticket falha (23503)", async () => {
    const ticket = await insertAsApp(ORG_K1, k1, "ticket", null);
    expect(await sqlState(insertAsApp(ORG_K1, k1, "ticket", ticket))).toBe("23503");
    expect(await sqlState(insertAsApp(ORG_K1, k1, "group", ticket))).toBe("23503");
  });

  it("como treepm_app: mudar para ticket um nó que tem filhos falha", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await insertAsApp(ORG_K1, k1, "ticket", group);
    const code = await sqlState(
      updateAsApp(ORG_K1, "update tickets set kind = 'ticket' where org_id = $1 and id = $2::uuid", [ORG_K1, group]),
    );
    expect(["23001", "23503"]).toContain(code);
  });

  it("como treepm_app: mudar para ticket um agrupador vazio, e voltar a agrupador, passa", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await updateAsApp(ORG_K1, "update tickets set kind = 'ticket' where org_id = $1 and id = $2::uuid", [ORG_K1, group]);
    await updateAsApp(ORG_K1, "update tickets set kind = 'group' where org_id = $1 and id = $2::uuid", [ORG_K1, group]);
  });

  it("como treepm_app: mover um nó para dentro de um ticket falha; para dentro de um agrupador passa", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    const ticket = await insertAsApp(ORG_K1, k1, "ticket", null);
    const mover = await insertAsApp(ORG_K1, k1, "ticket", null);
    expect(
      await sqlState(
        updateAsApp(
          ORG_K1,
          "update tickets set parent_id = $2::uuid, parent_kind = 'group' where org_id = $1 and id = $3::uuid",
          [ORG_K1, ticket, mover],
        ),
      ),
    ).toBe("23503");
    await updateAsApp(
      ORG_K1,
      "update tickets set parent_id = $2::uuid, parent_kind = 'group' where org_id = $1 and id = $3::uuid",
      [ORG_K1, group, mover],
    );
  });

  it("o isolamento entre organizações continua valendo para tickets com kind e parent_kind", async () => {
    const group = await insertAsApp(ORG_K1, k1, "group", null);
    await insertAsApp(ORG_K1, k1, "ticket", group);
    const seen = await asTenant(prisma, ORG_K2, (tx) =>
      tx.$queryRaw<{ id: string }[]>`select id from tickets where kind = 'group' or parent_kind = 'group'`,
    );
    expect(seen).toHaveLength(0);
    // pai de outra organização continua impossível (23503), mesmo sendo agrupador.
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, parent_id, parent_kind, created_by_person_id) values ($1, $2, 904, 'T', $3, 'group', $4)",
        [ORG_K2, k2.project, group, k2.person],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
