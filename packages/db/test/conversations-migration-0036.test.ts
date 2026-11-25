import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

// Migration 0036 sobre um banco até a 0035 (já com conversas): tudo o que existe continua aberto.
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0036";
const url = (db: string) => OWNER_URL.replace(/\/[^/]+$/, `/${db}`);

let admin: pg.Client;
let db: pg.Client;
const ids: Record<string, string> = {};
const one = async (sql: string, params: unknown[] = []): Promise<string> => ((await db.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  db = new pg.Client({ connectionString: url(DB_NAME) });
  await db.connect();
  const names = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_/.test(n)).sort();
  for (const name of names.filter((n) => n < "0036")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));

  await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
  for (const user of ["ana", "bia"]) ids[user] = await one("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', $1, $1, $2, 'member') returning id", [user, `${user}@x.io`]);
});
afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

describe("migration 0036 sobre dados da 0035", () => {
  it("toda participação existente continua aberta e a coluna aceita a marca depois", async () => {
    const id = (await db.query<{ id: string }>("select app_uuid_v7() as id")).rows[0]?.id as string;
    await db.query("begin");
    await db.query("insert into conversations (org_id, id, kind, owner_person_id, root_id) values ('o', $1, 'general', $2, $1)", [id, ids["ana"]]);
    await db.query("insert into conversation_participants (org_id, conversation_id, person_id, last_read_seq) values ('o', $1, $2, 4)", [id, ids["ana"]]);
    await db.query("commit");

    await db.query(readFileSync(`${MIGRATIONS}0036_conversation_closed/migration.sql`, "utf8"));
    const rows = (await db.query<{ closed_seq: string | null; last_read_seq: string }>("select closed_seq, last_read_seq from conversation_participants where conversation_id = $1", [id])).rows;
    expect(rows).toEqual([{ closed_seq: null, last_read_seq: "4" }]);
    await db.query("update conversation_participants set closed_seq = 9 where conversation_id = $1", [id]);
    expect((await db.query<{ closed_seq: string }>("select closed_seq from conversation_participants where conversation_id = $1", [id])).rows[0]?.closed_seq).toBe("9");
  });
});
