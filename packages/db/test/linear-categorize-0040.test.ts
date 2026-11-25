import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0040 (ADR 0060, fatia 4; TREEPM-425): a rodada de categorização reaproveita `external_import_runs` (modo `categorize`) e
// ganha a lista congelada de candidatos; a decisão da procura aceita a marca `import`.
const ORG_1 = "org_L40a";
const ORG_2 = "org_L40b";
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

const run = (orgId: string, projectId: string, personId: string, over: { mode?: string; phase?: string; source?: string | null } = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`insert into external_import_runs (org_id, project_id, provider, started_by_person_id, mode, phase, source_run_id, counts)
      values (${orgId}, ${projectId}::uuid, 'linear', ${personId}::uuid, ${over.mode ?? "categorize"}, ${over.phase ?? "categorize"}, ${over.source ?? null}::uuid, '{}'::jsonb) returning id`,
  );
const item = (orgId: string, runId: string, projectId: string, ticketId: string, over: { state?: string; position?: number } = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into external_categorize_items (org_id, run_id, project_id, ticket_id, position, state)
      values (${orgId}, ${runId}::uuid, ${projectId}::uuid, ${ticketId}::uuid, ${over.position ?? 0}, ${over.state ?? "pending"})`,
  );

describe("external_import_runs no modo categorize", () => {
  it("aceita o modo e a rodada de origem, e continua recusando modo desconhecido", async () => {
    const created = await run(ORG_1, a.project, a.person);
    expect(created).toHaveLength(1);
    expect(await failure(() => run(ORG_2, b.project, b.person, { mode: "outro", phase: "projects" }))).toMatch(/check constraint/i);
    await owner.query("update external_import_runs set phase = 'failed', finished_at = now() where org_id = $1", [ORG_1]);
  });

  it("no máximo uma rodada aberta por projeto, de qualquer modo (importação e categorização se excluem)", async () => {
    expect(await failure(() => run(ORG_1, a.project, a.person, { mode: "first", phase: "projects" }))).toBeNull();
    expect(await failure(() => run(ORG_1, a.project, a.person))).toMatch(/external_import_runs_open_key|duplicate key/i);
    await owner.query("update external_import_runs set phase = 'done', finished_at = now() where org_id = $1", [ORG_1]);
  });
});

describe("external_categorize_items", () => {
  it("guarda a lista congelada: um item por ticket da rodada, com estado de uma lista fechada", async () => {
    const [created] = await run(ORG_1, a.project, a.person);
    const runId = created?.id ?? "";
    expect(await failure(() => item(ORG_1, runId, a.project, a.ticket))).toBeNull();
    expect(await failure(() => item(ORG_1, runId, a.project, a.ticket, { position: 1 }))).toMatch(/duplicate key|unique/i);
    const second = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,4001,'y',$3::uuid) returning id", [ORG_1, a.project, a.person])).rows[0]?.id ?? "";
    expect(await failure(() => item(ORG_1, runId, a.project, second, { state: "quase" }))).toMatch(/check constraint/i);
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.$queryRaw<{ state: string; attempts: number; waits: number; suggested_path: string[] }[]>`select state, attempts, waits, suggested_path from external_categorize_items`);
    expect(rows).toEqual([{ state: "pending", attempts: 0, waits: 0, suggested_path: [] }]);
    // As esperas seguidas por limite de taxa não ficam negativas.
    expect(await failure(() => owner.query("update external_categorize_items set waits = -1 where org_id = $1", [ORG_1]))).toMatch(/check constraint/i);
    await owner.query("update external_import_runs set phase = 'failed', finished_at = now() where org_id = $1", [ORG_1]);
  });

  it("isola por organização, não apaga pela aplicação e some com o ticket", async () => {
    expect(await asTenant(prisma, ORG_2, (tx) => tx.$queryRaw`select 1 from external_categorize_items`)).toHaveLength(0);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from external_categorize_items`))).toMatch(/permission denied/i);
    const t = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,4002,'z',$3::uuid) returning id", [ORG_1, a.project, a.person])).rows[0]?.id ?? "";
    const [created] = await run(ORG_1, a.project, a.person);
    await item(ORG_1, created?.id ?? "", a.project, t, { position: 5 });
    await owner.query("delete from tickets where org_id = $1 and id = $2::uuid", [ORG_1, t]);
    expect((await owner.query("select 1 from external_categorize_items where org_id = $1 and ticket_id = $2::uuid", [ORG_1, t])).rowCount).toBe(0);
  });

  it("o ticket tem de ser do projeto da rodada (a chave estrangeira composta)", async () => {
    const other = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1,'Outro','OT4') returning id", [ORG_1])).rows[0]?.id ?? "";
    const [created] = await run(ORG_1, other, a.person);
    expect(await failure(() => item(ORG_1, created?.id ?? "", other, a.ticket))).toMatch(/foreign key/i);
  });
});

describe("placement_decisions.placed_by", () => {
  it("aceita `import` e continua recusando outros valores", async () => {
    await owner.query("insert into placement_decisions (org_id, project_id, ticket_id, uncertain, placed_by) values ($1,$2::uuid,$3::uuid,false,'import')", [ORG_1, a.project, a.ticket]);
    await owner.query("delete from placement_decisions where org_id = $1", [ORG_1]);
    expect(await failure(() => owner.query("insert into placement_decisions (org_id, project_id, ticket_id, uncertain, placed_by) values ($1,$2::uuid,$3::uuid,false,'nada')", [ORG_1, a.project, a.ticket]))).toMatch(/check constraint/i);
  });
});
