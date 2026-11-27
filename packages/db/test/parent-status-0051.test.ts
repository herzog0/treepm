import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_URL } from "./env.js";

// Migration 0051 sobre um banco até a 0048 (ADR 0068, seção 2): a situação de todo pai que já existe passa a sair dos filhos.
const MIGRATIONS = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const DB_NAME = "treepm_migration_0051";
const url = (db: string) => OWNER_URL.replace(/\/[^/]+$/, `/${db}`);

let admin: pg.Client;
let db: pg.Client;
const ids = new Map<string, string>();
let number = 0;
let versionsBefore = new Map<string, string>();

async function ticket(org: string, project: string, name: string, status: string, parent: string | null = null, extra: { idea?: string; agentWork?: string } = {}): Promise<void> {
  number += 1;
  const row = await db.query<{ id: string }>(
    `insert into tickets (org_id, project_id, number, parent_id, status, title, idea_stage, created_by_person_id,
       agent_work_started_at, agent_work_until, agent_work_person_id, agent_work_note)
     values ($1, $2, $3, $4, $5, $6, $7, (select id from people where org_id = $1 limit 1),
       case when $8::uuid is null then null else now() end, case when $8::uuid is null then null else now() + interval '1 hour' end, $8::uuid,
       case when $8::uuid is null then null else 'trabalhando' end)
     returning id`,
    [org, project, number, parent === null ? null : ids.get(parent), status, name, extra.idea ?? null, extra.agentWork ?? null],
  );
  ids.set(name, row.rows[0]?.id as string);
}

const statusOf = async (name: string) => (await db.query<{ status: string }>("select status from tickets where id = $1", [ids.get(name)])).rows[0]?.status;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  db = new pg.Client({ connectionString: url(DB_NAME) });
  await db.connect();
  const names = readdirSync(MIGRATIONS).filter((n) => /^\d{4}_/.test(n)).sort();
  for (const name of names.filter((n) => n < "0051")) await db.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));
  for (const org of ["o1", "o2"]) {
    await db.query("insert into organizations (org_id, name, slug) values ($1, $1, $1)", [org]);
    await db.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, $1 || '-ana', 'Ana', $1 || '@x.io', 'admin')", [org]);
  }
  const project = async (org: string, key: string) => (await db.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, $2, $2) returning id", [org, key])).rows[0]?.id as string;
  const p1 = await project("o1", "UM");
  const quiet = await project("o1", "QUIETO");
  const p2 = await project("o2", "DOIS");
  ids.set("project:UM", p1);
  ids.set("project:QUIETO", quiet);
  ids.set("project:DOIS", p2);
  const person = (await db.query<{ id: string }>("select id from people where org_id = 'o1'")).rows[0]?.id as string;

  // Cadeia de três níveis: o concluído do meio tem filho aberto; a conta sobe de baixo para cima.
  await ticket("o1", p1, "A", "done");
  await ticket("o1", p1, "B", "done", "A");
  await ticket("o1", p1, "C", "in_review", "B");
  // Todos concluídos ou cancelados, com um concluído: concluído (e o marcador de trabalho pela IA sai junto).
  await ticket("o1", p1, "D", "in_progress", null, { agentWork: person });
  await ticket("o1", p1, "E", "done", "D");
  await ticket("o1", p1, "F", "cancelled", "D");
  // Todos cancelados: cancelado.
  await ticket("o1", p1, "G", "in_review");
  await ticket("o1", p1, "H", "cancelled", "G");
  // Só uma ideia embaixo: não é calculado.
  await ticket("o1", p1, "I", "in_progress");
  await ticket("o1", p1, "J", "todo", "I", { idea: "new" });
  // Dentro de uma ideia: parado.
  await ticket("o1", p1, "K", "todo", null, { idea: "refining" });
  await ticket("o1", p1, "L", "todo", "K");
  await ticket("o1", p1, "M", "cancelled", "L");
  // Folha: fica como está.
  await ticket("o1", p1, "N", "in_review");
  // Projeto onde nada muda.
  await ticket("o1", quiet, "Q", "todo");
  await ticket("o1", quiet, "R", "todo", "Q");
  // Outra organização: também é refeita.
  await ticket("o2", p2, "X", "todo");
  await ticket("o2", p2, "Y", "done", "X");
  versionsBefore = new Map((await db.query<{ id: string; tickets_version: string }>("select id, tickets_version from projects")).rows.map((row) => [row.id, row.tickets_version]));
  await db.query(readFileSync(`${MIGRATIONS}0051_parent_status_derived/migration.sql`, "utf8"));
});

afterAll(async () => {
  await db.end();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
});

describe("migration 0051: a situação dos pais sai dos filhos", () => {
  it("refaz de baixo para cima, pela tabela da ADR", async () => {
    expect([await statusOf("C"), await statusOf("B"), await statusOf("A")]).toEqual(["in_review", "in_progress", "in_progress"]);
    expect(await statusOf("D")).toBe("done");
    expect(await statusOf("G")).toBe("cancelled");
  });

  it("concluído pela conta perde o marcador de trabalho pela IA", async () => {
    const row = (await db.query("select agent_work_started_at, agent_work_until, agent_work_person_id, agent_work_note from tickets where id = $1", [ids.get("D")])).rows[0];
    expect(row).toEqual({ agent_work_started_at: null, agent_work_until: null, agent_work_person_id: null, agent_work_note: null });
  });

  it("ideias não contam e o que está dentro de uma ideia fica parado; folha fica como está", async () => {
    expect(await statusOf("I")).toBe("in_progress");
    expect([await statusOf("K"), await statusOf("L")]).toEqual(["todo", "todo"]);
    expect(await statusOf("N")).toBe("in_review");
  });

  it("vale para todas as organizações, cada pai com os filhos da mesma organização", async () => {
    expect(await statusOf("X")).toBe("done");
  });

  it("a versão do projeto anda só onde algum pai mudou", async () => {
    const after = new Map((await db.query<{ id: string; tickets_version: string }>("select id, tickets_version from projects")).rows.map((row) => [row.id, row.tickets_version]));
    const moved = (key: string) => BigInt(after.get(ids.get(`project:${key}`) as string) as string) - BigInt(versionsBefore.get(ids.get(`project:${key}`) as string) as string);
    expect([moved("UM"), moved("QUIETO"), moved("DOIS")]).toEqual([1n, 0n, 1n]);
  });
});
