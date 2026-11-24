import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0034 (ADR 0057, TREEPM-404): a marca `is_test` de pessoa de teste só entra na inserção.
const ORG = "org_T34";
const OTHER = "org_T34B";
let owner: pg.Pool;
let prisma: PrismaClient;
let real: string;
let test: string;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  for (const org of [ORG, OTHER]) await owner.query("insert into organizations (org_id, name, slug) values ($1,$1,lower($1))", [org]);
  const q = async (sql: string, params: unknown[]): Promise<string> => (await owner.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  real = await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'user_real','Real','r@x.io','member') returning id", [ORG]);
  test = await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ($1,'treepm_test_1','Bia','b@x.invalid','member', true) returning id", [ORG]);
  await q("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ($1,'treepm_test_2','Cadu','c@x.invalid','member', true) returning id", [OTHER]);
});
afterAll(async () => {
  await owner.query("delete from people where org_id in ($1,$2)", [ORG, OTHER]);
  await owner.query("delete from organizations where org_id in ($1,$2)", [ORG, OTHER]);
  await prisma.$disconnect();
  await owner.end();
});

async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

describe("people.is_test", () => {
  it("nasce falsa por padrão", async () => {
    const rows = await owner.query<{ is_test: boolean }>("select is_test from people where id = $1::uuid", [real]);
    expect(rows.rows[0]?.is_test).toBe(false);
  });

  it("o papel da aplicação grava a marca na inserção", async () => {
    await asTenant(prisma, ORG, (tx) =>
      tx.person.create({ data: { orgId: ORG, clerkUserId: "treepm_test_ins", displayName: "Ins", email: "i@x.invalid", clerkRole: "member", isTest: true } }),
    );
    const rows = await owner.query<{ is_test: boolean }>("select is_test from people where clerk_user_id = 'treepm_test_ins'");
    expect(rows.rows[0]?.is_test).toBe(true);
  });

  it.each([
    ["transformar pessoa de verdade em pessoa de teste", () => real, true],
    ["transformar pessoa de teste em pessoa de verdade", () => test, false],
  ])("o papel da aplicação não pode %s", async (_name, id, value) => {
    const message = await failure(() => asTenant(prisma, ORG, (tx) => tx.$executeRaw`update people set is_test = ${value} where id = ${id()}::uuid`));
    expect(message).toMatch(/permission denied/i);
    const rows = await owner.query<{ is_test: boolean }>("select is_test from people where id = $1::uuid", [id()]);
    expect(rows.rows[0]?.is_test).toBe(!value);
  });

  it("o papel da aplicação continua atualizando o resto (desativar, nome, papel)", async () => {
    await asTenant(prisma, ORG, (tx) => tx.person.update({ where: { orgId_id: { orgId: ORG, id: test } }, data: { active: false, displayName: "Bia 2" } }));
    const rows = await owner.query<{ active: boolean; display_name: string }>("select active, display_name from people where id = $1::uuid", [test]);
    expect(rows.rows[0]).toEqual({ active: false, display_name: "Bia 2" });
    await asTenant(prisma, ORG, (tx) => tx.person.update({ where: { orgId_id: { orgId: ORG, id: test } }, data: { active: true } }));
  });

  it("a RLS da tabela continua: outra organização não enxerga a pessoa de teste", async () => {
    const seen = await asTenant(prisma, OTHER, (tx) => tx.person.findMany({ where: { isTest: true } }));
    expect(seen.map((p) => p.clerkUserId)).toEqual(["treepm_test_2"]);
    const hidden = await asTenant(prisma, OTHER, (tx) => tx.person.findFirst({ where: { id: test } }));
    expect(hidden).toBeNull();
  });
});

describe("o banco amarra a marca ao prefixo e ao papel", () => {
  const insert = (clerk: string, role: string, isTest: boolean) =>
    owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role, is_test) values ($1,$2,'X','x@x.invalid',$3,$4)", [ORG, clerk, role, isTest]);

  it.each([
    ["pessoa de teste com identificador de verdade", "user_falso", "member", true, /people_is_test_prefix_check/],
    ["pessoa de verdade com o prefixo de teste", "treepm_test_roubado", "member", false, /people_is_test_prefix_check/],
    ["pessoa de teste administradora", "treepm_test_adm", "admin", true, /people_is_test_member_check/],
  ])("recusa %s (até pelo dono)", async (_name, clerk, role, isTest, constraint) => {
    await expect(insert(clerk, role, isTest)).rejects.toThrow(constraint);
  });

  it("o papel da aplicação também não promove pessoa de teste a administradora", async () => {
    const message = await failure(() => asTenant(prisma, ORG, (tx) => tx.person.update({ where: { orgId_id: { orgId: ORG, id: test } }, data: { clerkRole: "admin" } })));
    expect(message).toMatch(/people_is_test_member_check/);
  });

  it("aceita pessoa de teste (member, com o prefixo) e pessoa de verdade administradora", async () => {
    await insert("treepm_test_ok", "member", true);
    await insert("user_admin_ok", "admin", false);
  });
});

describe("ticket_comments.via: act-as e a pessoa de verdade andam juntos", () => {
  it("aceita 'act-as' com a pessoa de verdade, nulo e 'mcp'; recusa 'act-as' sem a pessoa, a pessoa sem 'act-as' e outro valor", async () => {
    const ids = await seedOrg(owner, "org_T34C");
    const insertComment = (via: string | null, personId: string | null) =>
      owner.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, via, via_person_id) values ('org_T34C',$1,$2,$3,'c',$4,$5)", [ids.project, ids.ticket, ids.person, via, personId]);
    await insertComment("act-as", ids.person);
    await insertComment(null, null);
    await insertComment("mcp", null);
    await expect(insertComment("act-as", null)).rejects.toThrow(/ticket_comments_via_person_check/);
    await expect(insertComment(null, ids.person)).rejects.toThrow(/ticket_comments_via_person_check/);
    await expect(insertComment("mcp", ids.person)).rejects.toThrow(/ticket_comments_via_person_check/);
    await expect(insertComment("outro", null)).rejects.toThrow(/ticket_comments_via_check/);
  });
});
