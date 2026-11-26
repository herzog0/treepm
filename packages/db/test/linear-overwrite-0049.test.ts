import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0049 (ADR 0066): a rodada guarda a opção "Sobrescrever com o Linear", gravada ao abrir e lida em todos os passos.
const ORG_1 = "org_O49a";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

describe("external_import_runs.overwrite", () => {
  it("é booleano, não nulo e nasce falso; o papel da aplicação grava e lê", async () => {
    const column = (await owner.query("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'external_import_runs' and column_name = 'overwrite'")).rows[0] as Record<string, unknown> | undefined;
    expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const plain = await asTenant(prisma, ORG_1, (tx) =>
      tx.externalImportRun.create({ data: { orgId: ORG_1, projectId: a.project, provider: "linear", startedByPersonId: a.person, mode: "reimport", phase: "failed" }, select: { id: true, overwrite: true } }),
    );
    expect(plain.overwrite).toBe(false);
    const chosen = await asTenant(prisma, ORG_1, (tx) =>
      tx.externalImportRun.create({ data: { orgId: ORG_1, projectId: a.project, provider: "linear", startedByPersonId: a.person, mode: "reimport", phase: "failed", overwrite: true }, select: { id: true, overwrite: true } }),
    );
    expect(chosen.overwrite).toBe(true);
    const read = await asTenant(prisma, ORG_1, (tx) => tx.externalImportRun.findFirst({ where: { orgId: ORG_1, id: chosen.id }, select: { overwrite: true } }));
    expect(read?.overwrite).toBe(true);
  });
});
