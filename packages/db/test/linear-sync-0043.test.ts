import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0043 (ADR 0061, fatia 1; TREEPM-489): atributos do Linear na origem do ticket.
const ORG_1 = "org_L41a";
const ORG_2 = "org_L41b";
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

const insert = (orgId: string, ids: Ids) =>
  owner.query("insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, source_snapshot, applied_snapshot) values ($1, $2::uuid, $3::uuid, 'linear', 'issue', 'iss-41', '{}', '{}')", [orgId, ids.ticket, ids.project]);

describe("ticket_external_refs: colunas da fatia 1 da sincronização", () => {
  it("nascem nulas, com a lista de chaves antigas vazia", async () => {
    await insert(ORG_1, a);
    const row = (await owner.query("select external_created_at, external_started_at, external_completed_at, external_canceled_at, external_previous_keys, external_creator_id, external_creator_name, creator_person_id from ticket_external_refs where org_id = $1", [ORG_1])).rows[0];
    expect(row).toEqual({ external_created_at: null, external_started_at: null, external_completed_at: null, external_canceled_at: null, external_previous_keys: [], external_creator_id: null, external_creator_name: null, creator_person_id: null });
  });

  it("o papel da aplicação grava e lê as colunas novas", async () => {
    const when = new Date("2026-03-03T12:00:00.000Z");
    await asTenant(prisma, ORG_1, (tx) =>
      tx.ticketExternalRef.updateMany({
        data: { externalCreatedAt: when, externalStartedAt: when, externalCompletedAt: when, externalCanceledAt: when, externalPreviousKeys: ["OPS-3", "OPS-1"], externalCreatorId: "u-1", externalCreatorName: "Ana", creatorPersonId: a.person },
      }),
    );
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.ticketExternalRef.findMany());
    expect(rows[0]).toMatchObject({ externalCreatedAt: when, externalPreviousKeys: ["OPS-3", "OPS-1"], externalCreatorId: "u-1", externalCreatorName: "Ana", creatorPersonId: a.person });
  });

  it("a lista de chaves antigas não aceita nulo", async () => {
    expect(await failure(() => owner.query("update ticket_external_refs set external_previous_keys = null where org_id = $1", [ORG_1]))).toMatch(/not-null|null value/i);
  });

  it("apagar a pessoa só zera a referência (a origem, o org_id e o resto ficam)", async () => {
    const extra = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'user_gone_41', 'Sai', 'sai@x.io', 'member') returning id", [ORG_1])).rows[0]?.id ?? "";
    await owner.query("update ticket_external_refs set creator_person_id = $2::uuid where org_id = $1", [ORG_1, extra]);
    await owner.query("delete from people where org_id = $1 and id = $2::uuid", [ORG_1, extra]);
    const row = (await owner.query("select org_id, creator_person_id, external_creator_name from ticket_external_refs where org_id = $1", [ORG_1])).rows[0];
    expect(row).toEqual({ org_id: ORG_1, creator_person_id: null, external_creator_name: "Ana" });
  });

  it("a pessoa tem de ser da mesma organização", async () => {
    expect(await failure(() => owner.query("update ticket_external_refs set creator_person_id = $2::uuid where org_id = $1", [ORG_1, b.person]))).toMatch(/foreign key/i);
  });

  it("RLS: outra organização não vê as colunas nem as atualiza", async () => {
    expect(await asTenant(prisma, ORG_2, (tx) => tx.ticketExternalRef.updateMany({ data: { externalCreatorName: "X" } }))).toMatchObject({ count: 0 });
  });
});
