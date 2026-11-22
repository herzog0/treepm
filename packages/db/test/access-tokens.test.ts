import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_T1 = "org_T1";
const ORG_T2 = "org_T2";

let owner: pg.Pool;
let prisma: PrismaClient;
let t1: Ids;
let t2: Ids;
let counter = 0;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  t1 = await seedOrg(owner, ORG_T1);
  t2 = await seedOrg(owner, ORG_T2);
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const hash = (): string => `${String(++counter).padStart(8, "0")}`.repeat(8);

/** Grava um token pelo papel de aplicação (`treepm_app`), com RLS, como a API faz. */
const insert = (orgId: string, ids: Ids, tokenHash: string = hash(), name = "Meu token") =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at)
      values (${orgId}, ${ids.person}::uuid, ${ids.project}::uuid, ${name}, 'abcd1234', ${tokenHash}, now() + interval '90 days')
      returning id`,
  );

const countFor = async (column: "person_id" | "project_id", id: string): Promise<number> => {
  const r = await owner.query<{ n: number }>(`select count(*)::int as n from access_tokens where ${column} = $1`, [id]);
  return r.rows[0]?.n ?? -1;
};

describe("access_tokens: gravar e ler", () => {
  it("grava e lê, com id v7, datas, revogação e último uso nulos", async () => {
    const [row] = await insert(ORG_T1, t1);
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const rows = await asTenant(prisma, ORG_T1, (tx) => tx.accessToken.findMany({ where: { id: row?.id ?? "" } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Meu token", tokenPrefix: "abcd1234", revokedAt: null, lastUsedAt: null });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.expiresAt).toBeInstanceOf(Date);
  });

  it("recusa resumo repetido, mesmo em outra organização", async () => {
    const shared = hash();
    await insert(ORG_T1, t1, shared);
    await expect(insert(ORG_T1, t1, shared)).rejects.toThrow();
    await expect(insert(ORG_T2, t2, shared)).rejects.toThrow();
  });

  it("recusa nome vazio e nome com mais de 80 caracteres, e aceita 80", async () => {
    await expect(insert(ORG_T1, t1, hash(), "")).rejects.toThrow();
    await expect(insert(ORG_T1, t1, hash(), "x".repeat(81))).rejects.toThrow();
    await expect(insert(ORG_T1, t1, hash(), "x".repeat(80))).resolves.toHaveLength(1);
  });
});

describe("access_tokens: cascata", () => {
  it("remover a pessoa remove os tokens dela", async () => {
    const person = (await owner.query<{ id: string }>(
      "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_cascade_p', 'C', 'c@x.io', 'member') returning id",
      [ORG_T1],
    )).rows[0]?.id ?? "";
    await insert(ORG_T1, { ...t1, person });
    expect(await countFor("person_id", person)).toBe(1);
    await owner.query("delete from people where id = $1", [person]);
    expect(await countFor("person_id", person)).toBe(0);
  });

  it("remover o projeto remove os tokens dele", async () => {
    const project = (await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Casc', 'CASC') returning id",
      [ORG_T1],
    )).rows[0]?.id ?? "";
    await insert(ORG_T1, { ...t1, project });
    expect(await countFor("project_id", project)).toBe(1);
    await owner.query("delete from projects where id = $1", [project]);
    expect(await countFor("project_id", project)).toBe(0);
  });
});

describe("access_tokens: isolamento entre organizações", () => {
  it("uma organização não enxerga nem altera os tokens da outra", async () => {
    const [row] = await insert(ORG_T1, t1);
    const id = row?.id ?? "";
    expect(await asTenant(prisma, ORG_T2, (tx) => tx.accessToken.findMany({ where: { id } }))).toHaveLength(0);
    const updated = await asTenant(prisma, ORG_T2, (tx) => tx.accessToken.updateMany({ where: { id }, data: { revokedAt: new Date() } }));
    expect(updated.count).toBe(0);
    const deleted = await asTenant(prisma, ORG_T2, (tx) => tx.accessToken.deleteMany({ where: { id } }));
    expect(deleted.count).toBe(0);
    expect(await asTenant(prisma, ORG_T1, (tx) => tx.accessToken.findMany({ where: { id } }))).toHaveLength(1);
  });

  it("recusa gravar com a organização de outra no contexto", async () => {
    await expect(
      asTenant(prisma, ORG_T2, (tx) =>
        tx.$queryRaw`insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at)
          values (${ORG_T1}, ${t1.person}::uuid, ${t1.project}::uuid, 'x', 'abcd1234', ${hash()}, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe("organizations.mcp_enabled", () => {
  it("nasce falso e muda só pela organização do contexto", async () => {
    const before = await asTenant(prisma, ORG_T1, (tx) => tx.organization.findUnique({ where: { orgId: ORG_T1 } }));
    expect(before?.mcpEnabled).toBe(false);
    await asTenant(prisma, ORG_T1, (tx) => tx.organization.update({ where: { orgId: ORG_T1 }, data: { mcpEnabled: true } }));
    const after = await asTenant(prisma, ORG_T1, (tx) => tx.organization.findUnique({ where: { orgId: ORG_T1 } }));
    expect(after?.mcpEnabled).toBe(true);
    const other = await asTenant(prisma, ORG_T2, (tx) => tx.organization.findUnique({ where: { orgId: ORG_T2 } }));
    expect(other?.mcpEnabled).toBe(false);
  });
});
