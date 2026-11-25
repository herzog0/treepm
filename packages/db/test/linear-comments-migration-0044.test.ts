import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

// Migration 0044 sobre um banco até a 0043 (C2, item 1): nome de criador do Linear com forma de e-mail é zerado; os outros ficam.
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0044";
const url = (db: string) => OWNER_URL.replace(/\/[^/]+$/, `/${db}`);

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  db = new pg.Client({ connectionString: url(DB_NAME) });
  await db.connect();
  const names = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_/.test(n)).sort();
  for (const name of names.filter((n) => n < "0044")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));
  await db.query("insert into organizations (org_id, name, slug) values ('o', 'O', 'o')");
  const person = (await db.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('o', 'ana', 'Ana', 'ana@x.io', 'admin') returning id")).rows[0]?.id;
  const project = (await db.query<{ id: string }>("insert into projects (org_id, name, key) values ('o', 'P', 'PRJ') returning id")).rows[0]?.id;
  const names44 = ["zed@linear.test", "Zed <zed.sentinela@linear.test>", "Ana @ casa", "@ana", "Criadora Normal", null];
  for (const [i, name] of names44.entries()) {
    const ticket = (await db.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('o', $1, $2, 'T', $3) returning id", [project, i + 1, person])).rows[0]?.id;
    await db.query("insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, source_snapshot, applied_snapshot, external_creator_name) values ('o', $1, $2, 'linear', 'issue', $3, '{}', '{}', $4)", [ticket, project, `iss-${i}`, name]);
  }
  await db.query(readFileSync(`${MIGRATIONS}0044_linear_comments/migration.sql`, "utf8"));
});
afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

describe("migration 0044 sobre dados da 0043", () => {
  it("zera só o nome de criador com forma de e-mail (@ seguido de ponto)", async () => {
    const rows = (await db.query<{ external_id: string; external_creator_name: string | null }>("select external_id, external_creator_name from ticket_external_refs order by external_id")).rows;
    expect(rows).toEqual([
      { external_id: "iss-0", external_creator_name: null },
      { external_id: "iss-1", external_creator_name: null },
      { external_id: "iss-2", external_creator_name: "Ana @ casa" },
      { external_id: "iss-3", external_creator_name: "@ana" },
      { external_id: "iss-4", external_creator_name: "Criadora Normal" },
      { external_id: "iss-5", external_creator_name: null },
    ]);
  });
});
