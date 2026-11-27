import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import { OWNER_URL } from "./env.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0049 (ADR 0068, seções 3 e 5): o tipo de "depende de" (`need`: start | deliver) e o impedimento marcado no ticket.
const ORG = "org_NEED";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 500;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function ticket(): Promise<string> {
  const r = await owner.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'T', $4) returning id",
    [ORG, ids.project, ++counter, ids.person],
  );
  return r.rows[0]?.id ?? "";
}

/** Grava uma ligação pelo papel de aplicação, com RLS, como a API faz. */
const relate = (from: string, to: string, kind: string, need: string | null) =>
  asTenant(prisma, ORG, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind, need)
      values (${ORG}, ${ids.project}::uuid, ${from}::uuid, ${to}::uuid, ${kind}, ${need}) returning id`,
  );

describe("ticket_relations.need (migration 0049)", () => {
  it.each(["start", "deliver"])("depends_on aceita %s, e o papel da aplicação troca o tipo", async (need) => {
    const [a, b] = [await ticket(), await ticket()];
    const [row] = await relate(a, b, "depends_on", need);
    const other = need === "start" ? "deliver" : "start";
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_relations set need = ${other} where id = ${row?.id}::uuid`);
    expect((await owner.query("select need from ticket_relations where id = $1", [row?.id])).rows[0].need).toBe(other);
  });

  it("depends_on com tipo desconhecido é recusado", async () => {
    const [a, b] = [await ticket(), await ticket()];
    await expect(relate(a, b, "depends_on", "later")).rejects.toThrow(/ticket_relations_need_check/);
  });

  // A API de antes da 0049 grava "depende de" sem `need` (a janela entre a migração e a API nova no ar): o gatilho completa "para começar".
  it("depends_on gravado sem a coluna need (como a API antiga) vale 'para começar'; com need nulo explícito também", async () => {
    const [a, b, c] = [await ticket(), await ticket(), await ticket()];
    const [old] = await asTenant(prisma, ORG, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind)
        values (${ORG}, ${ids.project}::uuid, ${a}::uuid, ${b}::uuid, 'depends_on') returning id`,
    );
    const [explicit] = await relate(a, c, "depends_on", null);
    const needOf = async (id: string | undefined) => (await owner.query("select need from ticket_relations where id = $1", [id])).rows[0].need as string | null;
    expect(await needOf(old?.id)).toBe("start");
    expect(await needOf(explicit?.id)).toBe("start");
  });

  it("o gatilho não mexe em 'para entregar', nem em menciona e relacionado a (sem tipo)", async () => {
    const [a, b] = [await ticket(), await ticket()];
    const [deliver] = await relate(a, b, "depends_on", "deliver");
    const [mention] = await relate(a, b, "mentions", null);
    const [low, high] = a < b ? [a, b] : [b, a];
    const [related] = await relate(low, high, "related", null);
    const needOf = async (id: string | undefined) => (await owner.query("select need from ticket_relations where id = $1", [id])).rows[0].need as string | null;
    expect([await needOf(deliver?.id), await needOf(mention?.id), await needOf(related?.id)]).toEqual(["deliver", null, null]);
  });

  it("menciona e relacionado a não têm tipo", async () => {
    const [a, b] = [await ticket(), await ticket()];
    await expect(relate(a, b, "mentions", "start")).rejects.toThrow(/ticket_relations_need_check/);
    const [low, high] = a < b ? [a, b] : [b, a];
    await expect(relate(low, high, "related", "deliver")).rejects.toThrow(/ticket_relations_need_check/);
    await relate(a, b, "mentions", null);
    await relate(low, high, "related", null);
  });
});

describe("impedimento no ticket (migration 0049)", () => {
  const mark = (id: string, reason: string | null, person: string | null, at: string | null) =>
    asTenant(prisma, ORG, (tx) =>
      tx.$executeRaw`update tickets set impediment_reason = ${reason}, impediment_person_id = ${person}::uuid, impediment_at = ${at}::timestamptz where id = ${id}::uuid`,
    );

  it("ticket novo nasce sem impedimento", async () => {
    const id = await ticket();
    const r = await owner.query("select impediment_reason, impediment_person_id, impediment_at from tickets where id = $1", [id]);
    expect(r.rows[0]).toEqual({ impediment_reason: null, impediment_person_id: null, impediment_at: null });
  });

  it("o papel da aplicação marca e limpa os três campos juntos", async () => {
    const id = await ticket();
    await mark(id, "Esperando a chave do fornecedor", ids.person, "2026-11-27T10:00:00Z");
    const r = await owner.query("select impediment_reason, impediment_person_id from tickets where id = $1", [id]);
    expect(r.rows[0]).toEqual({ impediment_reason: "Esperando a chave do fornecedor", impediment_person_id: ids.person });
    await mark(id, null, null, null);
  });

  it("os três andam juntos (check)", async () => {
    const id = await ticket();
    await expect(mark(id, "motivo", null, null)).rejects.toThrow(/tickets_impediment_together_check/);
    await expect(mark(id, null, ids.person, "2026-11-27T10:00:00Z")).rejects.toThrow(/tickets_impediment_together_check/);
  });

  it("o motivo tem texto e no máximo 1000 caracteres", async () => {
    const id = await ticket();
    await expect(mark(id, "   ", ids.person, "2026-11-27T10:00:00Z")).rejects.toThrow(/tickets_impediment_reason_check/);
    await expect(mark(id, "x".repeat(1001), ids.person, "2026-11-27T10:00:00Z")).rejects.toThrow(/tickets_impediment_reason_check/);
    await mark(id, "x".repeat(1000), ids.person, "2026-11-27T10:00:00Z");
  });

  it("a pessoa é da mesma organização (chave estrangeira)", async () => {
    const id = await ticket();
    await expect(mark(id, "motivo", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", "2026-11-27T10:00:00Z")).rejects.toThrow(/impediment_person_id_fkey/);
  });
});

// Migration 0049 sobre dados da 0048: toda dependência existente vira "para começar".
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0049";
describe("migration 0049 sobre dados da 0048", () => {
  let admin: pg.Client;
  let db: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: OWNER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.query(`create database ${DB_NAME}`);
    db = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, `/${DB_NAME}`) });
    await db.connect();
    const names = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_/.test(n)).sort();
    for (const name of names.filter((n) => n < "0049")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));
  });
  afterAll(async () => {
    await db.end();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.end();
  });

  it("depends_on vira start; menciona e relacionado a ficam sem tipo", async () => {
    const one = async (sql: string, params: unknown[] = []) => ((await db.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
    await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
    const person = await one("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', 'u', 'U', 'u@x.io', 'member') returning id");
    const project = await one("insert into projects (org_id, name, key) values ('o', 'P', 'P') returning id");
    const t = async (n: number) => one("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('o', $1, $2, 'T', $3) returning id", [project, n, person]);
    const [a, b] = [await t(1), await t(2)];
    const [low, high] = a < b ? [a, b] : [b, a];
    for (const [from, to, kind] of [[a, b, "depends_on"], [a, b, "mentions"], [low, high, "related"]]) {
      await db.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ('o', $1, $2, $3, $4)", [project, from, to, kind]);
    }
    await db.query(readFileSync(`${MIGRATIONS}0049_dependency_need_and_impediment/migration.sql`, "utf8"));
    const rows = (await db.query<{ kind: string; need: string | null }>("select kind, need from ticket_relations order by kind")).rows;
    expect(rows).toEqual([
      { kind: "depends_on", need: "start" },
      { kind: "mentions", need: null },
      { kind: "related", need: null },
    ]);
  });
});
