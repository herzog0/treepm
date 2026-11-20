import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0006";
const url = (db: string) => OWNER_URL.replace(/\/[^/]+$/, `/${db}`);

let admin: pg.Client;
let db: pg.Client;

const apply = async (name: string): Promise<void> => {
  await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  db = new pg.Client({ connectionString: url(DB_NAME) });
  await db.connect();
  const names = readdirSync(MIGRATIONS)
    .filter((n) => /^\d{4}_/.test(n))
    .sort();
  for (const name of names.filter((n) => n < "0006")) await apply(name);
  // Árvore criada antes da 0006: raiz > meio > folha, uma outra raiz solta e um irmão da folha.
  await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
  await db.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', 'u', 'P', 'p@x.io', 'admin')");
  await db.query("insert into projects (org_id, name, key) values ('o', 'P', 'K')");
  const ids = await db.query<{ pid: string; person: string }>(
    "select (select id from projects limit 1) as pid, (select id from people limit 1) as person",
  );
  const { pid, person } = ids.rows[0] as { pid: string; person: string };
  const insert = async (number: number, parent: string | null): Promise<string> =>
    (
      await db.query<{ id: string }>(
        "insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id) values ('o', $1, $2, $3, $4, $5) returning id",
        [pid, number, `T${number}`, parent, person],
      )
    ).rows[0]?.id ?? "";
  const root = await insert(1, null);
  const middle = await insert(2, root);
  await insert(3, middle);
  await insert(4, middle);
  await insert(5, null);
  await apply("0006_ticket_kind");
});

afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

describe("migration 0006 sobre um banco que já tem tickets com filhos", () => {
  it("todo ticket com filho vira group; os demais ficam ticket", async () => {
    const r = await db.query<{ number: number; kind: string }>("select number, kind from tickets order by number");
    expect(r.rows).toEqual([
      { number: 1, kind: "group" },
      { number: 2, kind: "group" },
      { number: 3, kind: "ticket" },
      { number: 4, kind: "ticket" },
      { number: 5, kind: "ticket" },
    ]);
  });

  it("parent_kind é group onde há pai e nulo na raiz; nada foi movido nem removido", async () => {
    const r = await db.query<{ number: number; parent_number: number | null; parent_kind: string | null }>(
      `select t.number, p.number as parent_number, t.parent_kind
       from tickets t left join tickets p on p.org_id = t.org_id and p.id = t.parent_id order by t.number`,
    );
    expect(r.rows).toEqual([
      { number: 1, parent_number: null, parent_kind: null },
      { number: 2, parent_number: 1, parent_kind: "group" },
      { number: 3, parent_number: 2, parent_kind: "group" },
      { number: 4, parent_number: 2, parent_kind: "group" },
      { number: 5, parent_number: null, parent_kind: null },
    ]);
  });

  it("RLS forçado e grants continuam valendo na tabela", async () => {
    const rls = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'tickets'",
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const grants = await db.query<{ ok: boolean }>(
      "select has_table_privilege('treepm_app', 'tickets', 'SELECT,INSERT,UPDATE,DELETE') as ok",
    );
    expect(grants.rows[0]?.ok).toBe(true);
    const policy = await db.query("select 1 from pg_policies where tablename = 'tickets' and policyname = 'tenant_isolation'");
    expect(policy.rowCount).toBe(1);
  });
});
