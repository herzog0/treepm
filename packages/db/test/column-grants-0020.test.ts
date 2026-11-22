import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0020 (TREEPM-196): o papel da aplicação só atualiza as colunas que a API de fato muda.
const ORG = "org_CG";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 0;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const hash = (): string => `c0de${String(++counter).padStart(4, "0")}`.repeat(8);
async function token(): Promise<string> {
  const rows = await asTenant(prisma, ORG, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, scope, expires_at)
      values (${ORG}, ${ids.person}::uuid, ${ids.project}::uuid, 'T', 'abcd1234', ${hash()}, 'read', now() + interval '90 days')
      returning id`,
  );
  return rows[0]?.id ?? "";
}
/** Executa um UPDATE como o papel da aplicação; devolve o código de erro do Postgres (ou null). */
async function tryUpdate(run: (tx: Parameters<Parameters<typeof asTenant>[2]>[0]) => Promise<unknown>): Promise<string | null> {
  try {
    await asTenant(prisma, ORG, run);
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

describe("access_tokens: UPDATE só nas colunas que a API muda", () => {
  it.each([
    ["scope", "update access_tokens set scope = 'write' where id = $1::uuid"],
    ["token_hash", "update access_tokens set token_hash = 'x' where id = $1::uuid"],
    ["token_prefix", "update access_tokens set token_prefix = 'zzzzzzzz' where id = $1::uuid"],
    ["person_id", "update access_tokens set person_id = person_id where id = $1::uuid"],
    ["project_id", "update access_tokens set project_id = project_id where id = $1::uuid"],
    ["expires_at", "update access_tokens set expires_at = now() + interval '900 days' where id = $1::uuid"],
    ["name", "update access_tokens set name = 'outro' where id = $1::uuid"],
  ])("o papel da aplicação não muda %s", async (_column, sql) => {
    const id = await token();
    const code = await tryUpdate((tx) => tx.$executeRawUnsafe(sql, id));
    expect(code).toMatch(/permission denied/i);
  });

  it("continua revogando e registrando o último uso", async () => {
    const id = await token();
    const revoked = await asTenant(prisma, ORG, (tx) => tx.accessToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }));
    expect(revoked.count).toBe(1);
    const used = await asTenant(prisma, ORG, (tx) => tx.accessToken.updateMany({ where: { id }, data: { lastUsedAt: new Date() } }));
    expect(used.count).toBe(1);
    const r = await owner.query("select scope, revoked_at, last_used_at from access_tokens where id = $1", [id]);
    expect(r.rows[0].scope).toBe("read");
    expect(r.rows[0].revoked_at).not.toBeNull();
    expect(r.rows[0].last_used_at).not.toBeNull();
  });
});

describe("organizations: UPDATE só nas colunas que a API muda", () => {
  it.each([
    ["org_id", "update organizations set org_id = org_id where org_id = $1"],
    ["created_at", "update organizations set created_at = now() where org_id = $1"],
  ])("o papel da aplicação não muda %s", async (_column, sql) => {
    const code = await tryUpdate((tx) => tx.$executeRawUnsafe(sql, ORG));
    expect(code).toMatch(/permission denied/i);
  });

  it("continua mudando nome, slug e as duas chaves do MCP (inclusive pelo upsert da identidade)", async () => {
    await asTenant(prisma, ORG, (tx) => tx.organization.update({ where: { orgId: ORG }, data: { mcpEnabled: true, mcpWriteEnabled: true } }));
    await asTenant(prisma, ORG, (tx) =>
      tx.organization.upsert({ where: { orgId: ORG }, create: { orgId: ORG, name: "N", slug: "n" }, update: { name: "Novo nome", slug: "novo" } }),
    );
    const r = await owner.query("select name, slug, mcp_enabled, mcp_write_enabled from organizations where org_id = $1", [ORG]);
    expect(r.rows[0]).toMatchObject({ name: "Novo nome", slug: "novo", mcp_enabled: true, mcp_write_enabled: true });
  });
});
