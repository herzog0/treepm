import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

// Migration 0035 sobre um banco até a 0033 (já com conversas e threads): toda thread existente vira `people`.
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0035";
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
  for (const name of names.filter((n) => n < "0035")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));

  await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
  for (const user of ["ana", "bia"]) ids[user] = await one("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', $1, $1, $2, 'member') returning id", [user, `${user}@x.io`]);
});
afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

describe("migration 0035 sobre dados da 0033", () => {
  it("as threads existentes viram people; as principais ficam sem propósito", async () => {
    const id = (await db.query<{ id: string }>("select app_uuid_v7() as id")).rows[0]?.id as string;
    await db.query("begin");
    await db.query("insert into conversations (org_id, id, kind, owner_person_id, root_id) values ('o', $1, 'general', $2, $1)", [id, ids["ana"]]);
    await db.query("insert into conversation_participants (org_id, conversation_id, person_id) values ('o', $1, $2)", [id, ids["ana"]]);
    const opening = await one("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('o', $1, $2, 'abre') returning id", [id, ids["ana"]]);
    const thread = (await db.query<{ id: string }>("select app_uuid_v7() as id")).rows[0]?.id as string;
    await db.query("insert into conversations (org_id, id, kind, owner_person_id, parent_id, root_id, depth, opening_message_id) values ('o', $1, 'thread', $2, $3, $3, 1, $4)", [thread, ids["ana"], id, opening]);
    for (const p of ["ana", "bia"]) await db.query("insert into conversation_participants (org_id, conversation_id, person_id) values ('o', $1, $2)", [thread, ids[p]]);
    await db.query("commit");

    await db.query(readFileSync(`${MIGRATIONS}0035_conversation_purpose/migration.sql`, "utf8"));
    const rows = (await db.query<{ id: string; purpose: string | null; title: string | null }>("select id, purpose, title from conversations")).rows;
    expect(rows.find((r) => r.id === id)).toMatchObject({ purpose: null, title: null });
    expect(rows.find((r) => r.id === thread)).toMatchObject({ purpose: "people", title: null });
  });
});
