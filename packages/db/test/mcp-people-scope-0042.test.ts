import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0042 (ADR 0062, fatia 2; TREEPM-494): o terceiro alcance do MCP, "pessoas e conversas", na organização e no token.
const ORG = "org_P42";
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

const hash = (): string => `d00d${String(++counter).padStart(4, "0")}`.repeat(8);
async function token(extra = ""): Promise<string> {
  const rows = await owner.query<{ id: string }>(
    `insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, scope, expires_at${extra === "" ? "" : ", people"})
     values ($1, $2, $3, 'T', 'abcd1234', $4, 'read', now() + interval '90 days'${extra === "" ? "" : `, ${extra}`}) returning id`,
    [ORG, ids.person, ids.project, hash()],
  );
  return rows.rows[0]?.id ?? "";
}
async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

describe("organizations.mcp_people_enabled", () => {
  it("nasce desligada", async () => {
    const rows = await owner.query("select mcp_people_enabled from organizations where org_id = $1", [ORG]);
    expect(rows.rows[0]).toEqual({ mcp_people_enabled: false });
  });
  it("o papel da aplicação a liga e desliga (como as outras duas chaves)", async () => {
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update organizations set mcp_people_enabled = true where org_id = ${ORG}`);
    expect((await owner.query("select mcp_people_enabled from organizations where org_id = $1", [ORG])).rows[0]).toEqual({ mcp_people_enabled: true });
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update organizations set mcp_people_enabled = false where org_id = ${ORG}`);
  });
});

describe("access_tokens.people", () => {
  it("o token existente e o novo sem a coluna nascem SEM o alcance", async () => {
    const id = await token();
    expect((await owner.query("select people from access_tokens where id = $1", [id])).rows[0]).toEqual({ people: false });
  });
  it("aceita o alcance na criação", async () => {
    const id = await token("true");
    expect((await owner.query("select people from access_tokens where id = $1", [id])).rows[0]).toEqual({ people: true });
  });
  it("o papel da aplicação não muda o alcance depois de criado (como o `scope`)", async () => {
    const id = await token();
    const code = await failure(() => asTenant(prisma, ORG, (tx) => tx.$executeRaw`update access_tokens set people = true where id = ${id}::uuid`));
    expect(code).toMatch(/permission denied/i);
  });
  it("continua revogando", async () => {
    const id = await token();
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update access_tokens set revoked_at = now() where id = ${id}::uuid`);
    expect((await owner.query("select revoked_at is not null r from access_tokens where id = $1", [id])).rows[0]).toEqual({ r: true });
  });
});
