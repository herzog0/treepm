import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0046 (ADR 0061, fatia 4; TREEPM-482): o histórico das issues do Linear numa tabela própria, só de leitura e inserção.
const ORG_1 = "org_H46a";
const ORG_2 = "org_H46b";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;
let b: Ids;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
  b = await seedOrg(owner, ORG_2);
});
afterAll(async () => {
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

let serial = 0;
/** Uma entrada pelo papel da aplicação, na organização 1. */
const entry = (data: Record<string, unknown> = {}) => {
  serial += 1;
  return asTenant(prisma, ORG_1, (tx) =>
    tx.externalHistoryEntry.create({
      data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, provider: "linear", externalId: `h-${serial}`, occurredAt: new Date("2025-01-02T03:04:05Z"), changes: [{ field: "description" }], ...data } as never,
      select: { id: true },
    }),
  );
};

describe("external_history_entries", () => {
  it("o papel da aplicação insere e lê; o autor é a pessoa, o nome de fora ou ninguém", async () => {
    expect(await entry({ actorPersonId: a.person })).toHaveProperty("id");
    expect(await entry({ externalActorName: "Ana" })).toHaveProperty("id");
    expect(await entry()).toHaveProperty("id");
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.externalHistoryEntry.findMany({ select: { id: true } }));
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("CHECKs: provedor, id externo, pessoa e nome juntos, nome de 1 a 120 sem forma de e-mail, `changes` é lista", async () => {
    expect(await failure(() => entry({ provider: "github" }))).toMatch(/check/i);
    expect(await failure(() => entry({ externalId: "" }))).toMatch(/check/i);
    expect(await failure(() => entry({ externalId: "x".repeat(201) }))).toMatch(/check/i);
    expect(await failure(() => entry({ actorPersonId: a.person, externalActorName: "Ana" }))).toMatch(/check/i);
    expect(await failure(() => entry({ externalActorName: "" }))).toMatch(/check/i);
    expect(await failure(() => entry({ externalActorName: "x".repeat(121) }))).toMatch(/check/i);
    expect(await failure(() => entry({ externalActorName: "ana@linear.app" }))).toMatch(/check/i);
    expect(await failure(() => entry({ changes: { field: "description" } }))).toMatch(/check/i);
    expect(await entry({ externalActorName: "x".repeat(120) })).toHaveProperty("id");
  });

  it("o mesmo id externo na mesma organização não entra duas vezes; em outra organização entra", async () => {
    await entry({ externalId: "dup-1" });
    expect(await failure(() => entry({ externalId: "dup-1" }))).toMatch(/unique/i);
    const other = await asTenant(prisma, ORG_2, (tx) =>
      tx.externalHistoryEntry.create({ data: { orgId: ORG_2, projectId: b.project, ticketId: b.ticket, provider: "linear", externalId: "dup-1", occurredAt: new Date(), changes: [] }, select: { id: true } }),
    );
    expect(other).toHaveProperty("id");
  });

  it("isolamento por organização: a outra organização não lê nem grava aqui", async () => {
    await entry({ externalId: "iso-1" });
    const seen = await asTenant(prisma, ORG_2, (tx) => tx.externalHistoryEntry.findMany({ where: { externalId: "iso-1" } }));
    expect(seen).toEqual([]);
    expect(await failure(() => asTenant(prisma, ORG_2, (tx) => tx.externalHistoryEntry.create({ data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, provider: "linear", externalId: "iso-2", occurredAt: new Date(), changes: [] } })))).toMatch(/row-level security|policy/i);
    const forced = (await owner.query("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'external_history_entries'")).rows[0];
    expect(forced).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("GRANTs: o papel da aplicação atualiza só o autor; não apaga nem muda o resto", async () => {
    const { id } = await entry({ externalActorName: "Ana" });
    const update = (data: Record<string, unknown>) => asTenant(prisma, ORG_1, (tx) => tx.externalHistoryEntry.update({ where: { orgId_id: { orgId: ORG_1, id } }, data }));
    await update({ actorPersonId: a.person, externalActorName: null });
    expect((await owner.query("select actor_person_id, external_actor_name from external_history_entries where id = $1", [id])).rows[0]).toEqual({ actor_person_id: a.person, external_actor_name: null });
    for (const data of [{ changes: [] }, { occurredAt: new Date() }, { externalId: "outro" }]) expect(await failure(() => update(data)), JSON.stringify(data)).toMatch(/permission denied/i);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.externalHistoryEntry.delete({ where: { orgId_id: { orgId: ORG_1, id } } })))).toMatch(/permission denied/i);
    const privileges = (await owner.query("select privilege_type from information_schema.role_table_grants where table_name = 'external_history_entries' and grantee = 'treepm_app' order by 1")).rows.map((row) => row.privilege_type);
    expect(privileges).toEqual(["INSERT", "SELECT"]);
    const columns = (await owner.query("select column_name from information_schema.column_privileges where table_name = 'external_history_entries' and grantee = 'treepm_app' and privilege_type = 'UPDATE' order by 1")).rows.map((row) => row.column_name);
    expect(columns).toEqual(["actor_person_id", "external_actor_name"]);
  });

  it("some com o ticket (cascata)", async () => {
    const ticket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 9046, 'apagar', $3) returning id", [ORG_1, a.project, a.person])).rows[0]?.id as string;
    await entry({ ticketId: ticket, externalId: "cascata-1" });
    await owner.query("delete from tickets where id = $1", [ticket]);
    expect((await owner.query("select count(*)::int n from external_history_entries where external_id = 'cascata-1'")).rows[0]).toEqual({ n: 0 });
  });

  it("índice por ticket e data", async () => {
    const indexes = (await owner.query("select indexdef from pg_indexes where tablename = 'external_history_entries'")).rows.map((row) => String(row.indexdef));
    expect(indexes.some((def) => /\(org_id, ticket_id, occurred_at\)/.test(def))).toBe(true);
    expect(indexes.some((def) => /UNIQUE.*\(org_id, provider, external_id\)/.test(def))).toBe(true);
  });
});

describe("external_import_runs: fase `history` e a marca d'água", () => {
  it("a fase `history` é aceita e as colunas da marca existem", async () => {
    const run = await asTenant(prisma, ORG_1, (tx) =>
      tx.externalImportRun.create({ data: { orgId: ORG_1, projectId: a.project, provider: "linear", startedByPersonId: a.person, mode: "first", phase: "history", historySince: new Date("2025-01-01T00:00:00Z"), historyComplete: true }, select: { id: true, historyComplete: true } }),
    );
    expect(run.historyComplete).toBe(true);
    // A marca é o começo da rodada (`started_at`): nenhuma coluna a mais para ela (revisão H1, item 2).
    const columns = (await owner.query("select column_name from information_schema.columns where table_name = 'external_import_runs' and column_name like 'history%' order by 1")).rows.map((row) => String(row.column_name));
    expect(columns).toEqual(["history_complete", "history_since"]);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.externalImportRun.update({ where: { orgId_id: { orgId: ORG_1, id: run.id } }, data: { phase: "historia" } })))).toMatch(/check/i);
    await asTenant(prisma, ORG_1, (tx) => tx.externalImportRun.update({ where: { orgId_id: { orgId: ORG_1, id: run.id } }, data: { phase: "failed", historyComplete: false } }));
  });
});
