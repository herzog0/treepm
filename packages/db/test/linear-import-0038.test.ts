import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0038 (ADR 0060, fatia 2; TREEPM-423): origem por ticket e rodadas de importação.
const ORG_1 = "org_L38a";
const ORG_2 = "org_L38b";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;
let b: Ids;
let otherProject: string;
let otherTicket: string;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
  b = await seedOrg(owner, ORG_2);
  otherProject = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1,'Outro','OUT') returning id", [ORG_1])).rows[0]?.id ?? "";
  otherTicket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,1,'x',$3::uuid) returning id", [ORG_1, otherProject, a.person])).rows[0]?.id ?? "";
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

const ref = (orgId: string, projectId: string, ticketId: string, over: { kind?: string; provider?: string; externalId?: string } = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, external_key, external_url, source_snapshot, applied_snapshot, external_updated_at)
      values (${orgId}, ${ticketId}::uuid, ${projectId}::uuid, ${over.provider ?? "linear"}, ${over.kind ?? "issue"}, ${over.externalId ?? "iss-1"}, 'ENG-1', 'https://linear.app/x/issue/ENG-1', '{}'::jsonb, '{}'::jsonb, now())`,
  );

const run = (orgId: string, projectId: string, personId: string, over: { mode?: string; phase?: string; destination?: string | null } = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into external_import_runs (org_id, project_id, provider, started_by_person_id, mode, phase, destination_ticket_id, categorize, counts)
      values (${orgId}, ${projectId}::uuid, 'linear', ${personId}::uuid, ${over.mode ?? "first"}, ${over.phase ?? "projects"}, ${over.destination ?? null}::uuid, false, '{}'::jsonb)`,
  );

describe("ticket_external_refs", () => {
  it("o papel da aplicação insere, lê e atualiza (e a origem some com o ticket)", async () => {
    expect(await failure(() => ref(ORG_1, a.project, a.ticket))).toBeNull();
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.ticketExternalRef.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "linear", kind: "issue", externalId: "iss-1", externalKey: "ENG-1", missingSince: null });
    await asTenant(prisma, ORG_1, (tx) => tx.ticketExternalRef.updateMany({ data: { missingSince: new Date(), externalKey: "ENG-9" } }));
    expect((await owner.query("select external_key, missing_since is not null as gone from ticket_external_refs where org_id = $1", [ORG_1])).rows).toEqual([{ external_key: "ENG-9", gone: true }]);
    await owner.query("delete from tickets where org_id = $1 and id = $2::uuid", [ORG_1, a.ticket]);
    expect((await owner.query("select 1 from ticket_external_refs where org_id = $1", [ORG_1])).rowCount).toBe(0);
    // devolve o ticket semeado para os próximos testes
    a.ticket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,77,'t',$3::uuid) returning id", [ORG_1, a.project, a.person])).rows[0]?.id ?? "";
  });

  it("L7: o endereço da origem pode ser nulo (o atalho some)", async () => {
    const t = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,9977,'sem url',$3::uuid) returning id", [ORG_1, a.project, a.person])).rows[0]?.id ?? "";
    expect(await failure(() => owner.query("insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, external_url, source_snapshot, applied_snapshot) values ($1,$2::uuid,$3::uuid,'linear','issue','sem-url',null,'{}','{}')", [ORG_1, t, a.project]))).toBeNull();
  });

  it("o papel da aplicação não apaga a origem diretamente", async () => {
    await ref(ORG_1, a.project, a.ticket);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from ticket_external_refs where org_id = ${ORG_1}`))).toMatch(/permission denied/i);
    await owner.query("delete from ticket_external_refs where org_id = $1", [ORG_1]);
  });

  it("recusa provedor e tipo fora das listas", async () => {
    expect(await failure(() => ref(ORG_1, a.project, a.ticket, { provider: "github" }))).toMatch(/check constraint/i);
    expect(await failure(() => ref(ORG_1, a.project, a.ticket, { kind: "comment" }))).toMatch(/check constraint/i);
  });

  it("a origem é única na ORGANIZAÇÃO (provedor, tipo e id externo), mesmo em outro projeto", async () => {
    await ref(ORG_1, a.project, a.ticket, { externalId: "dup" });
    expect(await failure(() => ref(ORG_1, otherProject, otherTicket, { externalId: "dup" }))).toMatch(/duplicate key|unique/i);
    // outro tipo com o mesmo id externo é outra origem
    expect(await failure(() => ref(ORG_1, otherProject, otherTicket, { externalId: "dup", kind: "project" }))).toBeNull();
    // um ticket tem uma origem só
    expect(await failure(() => ref(ORG_1, a.project, a.ticket, { externalId: "outra" }))).toMatch(/duplicate key|unique/i);
    await owner.query("delete from ticket_external_refs where org_id = $1", [ORG_1]);
  });

  it("o projeto da origem tem de ser o projeto do ticket", async () => {
    expect(await failure(() => ref(ORG_1, otherProject, a.ticket))).toMatch(/foreign key/i);
  });

  it("RLS: outra organização não lê, não grava e não atualiza", async () => {
    await ref(ORG_1, a.project, a.ticket);
    expect(await asTenant(prisma, ORG_2, (tx) => tx.ticketExternalRef.findMany())).toHaveLength(0);
    expect(await failure(() => ref(ORG_2, a.project, a.ticket))).not.toBeNull();
    const forged = await failure(() =>
      asTenant(prisma, ORG_2, (tx) =>
        tx.$executeRaw`insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, external_url, source_snapshot, applied_snapshot, external_updated_at)
          values (${ORG_1}, ${a.ticket}::uuid, ${a.project}::uuid, 'linear', 'issue', 'forjada', 'u', '{}'::jsonb, '{}'::jsonb, now())`,
      ),
    );
    expect(forged).toMatch(/row-level security/i);
    expect(await asTenant(prisma, ORG_2, (tx) => tx.ticketExternalRef.updateMany({ data: { externalKey: "X" } }))).toMatchObject({ count: 0 });
    await owner.query("delete from ticket_external_refs where org_id = $1", [ORG_1]);
  });
});

describe("external_import_runs", () => {
  it("grava com os valores padrão e o papel da aplicação lê e atualiza (sem apagar)", async () => {
    expect(await failure(() => run(ORG_1, a.project, a.person))).toBeNull();
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.externalImportRun.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "projects", mode: "first", categorize: false, cursor: null, finishedAt: null, destinationTicketId: null });
    // L7: tamanho da página, sequência de falhas e "tem destino" nascem com padrão.
    expect(rows[0]).toMatchObject({ pageSize: 50, errorStreak: 0, hasDestination: false });
    await asTenant(prisma, ORG_1, (tx) => tx.externalImportRun.updateMany({ data: { cursor: "abc", phase: "issues" } }));
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from external_import_runs where org_id = ${ORG_1}`))).toMatch(/permission denied/i);
  });

  it("duas rodadas abertas no mesmo projeto não coexistem; terminada libera, e outro projeto é livre", async () => {
    expect(await failure(() => run(ORG_1, a.project, a.person))).toMatch(/duplicate key|unique/i);
    expect(await failure(() => run(ORG_1, otherProject, a.person))).toBeNull();
    await owner.query("update external_import_runs set phase = 'done', finished_at = now() where org_id = $1 and project_id = $2::uuid", [ORG_1, a.project]);
    expect(await failure(() => run(ORG_1, a.project, a.person, { mode: "reimport" }))).toBeNull();
    await owner.query("update external_import_runs set phase = 'failed' where org_id = $1 and project_id = $2::uuid and phase = 'projects'", [ORG_1, a.project]);
    expect(await failure(() => run(ORG_1, a.project, a.person, { mode: "reimport" }))).toBeNull();
    expect((await owner.query("select count(*)::int as n from external_import_runs where org_id = $1 and phase not in ('done','failed')", [ORG_1])).rows[0]).toEqual({ n: 2 });
  });

  it("recusa modo e fase fora das listas", async () => {
    expect(await failure(() => run(ORG_1, otherProject, a.person, { mode: "sync" }))).toMatch(/check constraint/i);
    expect(await failure(() => run(ORG_1, otherProject, a.person, { phase: "magic" }))).toMatch(/check constraint/i);
  });

  it("L7: a fase `mentions` existe; tamanho de página e falhas têm limites", async () => {
    const fresh = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1,'Menções','MEN') returning id", [ORG_1])).rows[0]?.id ?? "";
    expect(await failure(() => run(ORG_1, fresh, a.person, { phase: "mentions" }))).toBeNull();
    const set = (column: string, value: number) => owner.query(`update external_import_runs set ${column} = $1 where org_id = $2 and project_id = $3::uuid`, [value, ORG_1, fresh]);
    expect(await failure(() => set("page_size", 0))).toMatch(/check constraint/i);
    expect(await failure(() => set("page_size", 251))).toMatch(/check constraint/i);
    expect(await failure(() => set("error_streak", -1))).toMatch(/check constraint/i);
    expect(await failure(() => set("page_size", 3))).toBeNull();
  });

  it("o destino é um ticket do mesmo projeto, e some (vira nulo) se o ticket for apagado", async () => {
    await owner.query("delete from external_import_runs where org_id = $1", [ORG_1]);
    expect(await failure(() => run(ORG_1, a.project, a.person, { destination: otherTicket }))).toMatch(/foreign key/i);
    await run(ORG_1, a.project, a.person, { destination: a.ticket });
    await owner.query("delete from tickets where org_id = $1 and id = $2::uuid", [ORG_1, a.ticket]);
    expect((await owner.query("select destination_ticket_id from external_import_runs where org_id = $1", [ORG_1])).rows).toEqual([{ destination_ticket_id: null }]);
  });

  it("RLS: outra organização não lê, não grava e não atualiza", async () => {
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalImportRun.findMany())).toHaveLength(0);
    expect(await failure(() => run(ORG_2, a.project, a.person))).not.toBeNull();
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalImportRun.updateMany({ data: { cursor: "x" } }))).toMatchObject({ count: 0 });
    const forged = await failure(() =>
      asTenant(prisma, ORG_2, (tx) =>
        tx.$executeRaw`insert into external_import_runs (org_id, project_id, provider, started_by_person_id, mode, phase, categorize, counts)
          values (${ORG_1}, ${otherProject}::uuid, 'linear', ${a.person}::uuid, 'first', 'projects', false, '{}'::jsonb)`,
      ),
    );
    expect(forged).toMatch(/row-level security/i);
    expect(b.person).toBeTruthy();
  });
});
