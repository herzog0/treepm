import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_C1 = "org_C1";
const ORG_C2 = "org_C2";

let owner: pg.Pool;
let prisma: PrismaClient;
let c1: Ids;
let c2: Ids;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  c1 = await seedOrg(owner, ORG_C1);
  c2 = await seedOrg(owner, ORG_C2);
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const accept = (orgId: string, ids: Ids, kind = "assistant", version = "rascunho-1") =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into organization_consents (org_id, kind, document_version, accepted_by_person_id)
      values (${orgId}, ${kind}, ${version}, ${ids.person}::uuid) returning id`,
  );

const withdraw = (orgId: string, ids: Ids, id: string) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`
      update organization_consents set withdrawn_at = now(), withdrawn_by_person_id = ${ids.person}::uuid
       where id = ${id}::uuid`,
  );

describe("organization_consents: gravar e ler", () => {
  it("grava com id v7, data do aceite e retirada nula, e o Prisma lê", async () => {
    const [row] = await accept(ORG_C1, c1, "code_reading");
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const found = await asTenant(prisma, ORG_C1, (tx) => tx.organizationConsent.findMany({ where: { id: row?.id ?? "" } }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "code_reading",
      documentVersion: "rascunho-1",
      acceptedByPersonId: c1.person,
      withdrawnAt: null,
      withdrawnByPersonId: null,
    });
    expect(found[0]?.acceptedAt).toBeInstanceOf(Date);
  });

  it("recusa tipo fora de assistant e code_reading", async () => {
    await expect(accept(ORG_C1, c1, "outro")).rejects.toThrow();
  });

  it("recusa versão vazia", async () => {
    await expect(accept(ORG_C1, c1, "assistant", "")).rejects.toThrow();
  });
});

describe("organization_consents: uma linha em vigor por organização e tipo", () => {
  it("recusa uma segunda em vigor do mesmo tipo e aceita de outro tipo e de outra organização", async () => {
    await accept(ORG_C2, c2, "assistant");
    await expect(accept(ORG_C2, c2, "assistant")).rejects.toThrow(/unique|duplicate/i);
    await expect(accept(ORG_C2, c2, "code_reading")).resolves.toHaveLength(1);
    await expect(accept(ORG_C1, c1, "assistant")).resolves.toHaveLength(1);
  });

  it("depois de retirada, aceita uma nova do mesmo tipo e a linha antiga fica como registro", async () => {
    const [first] = await accept(ORG_C1, c1, "code_reading").catch(async () => {
      // `code_reading` já está em vigor no teste de leitura acima: retira para recomeçar.
      await owner.query("update organization_consents set withdrawn_at = now(), withdrawn_by_person_id = $2 where org_id = $1 and kind = 'code_reading' and withdrawn_at is null", [ORG_C1, c1.person]);
      return accept(ORG_C1, c1, "code_reading");
    });
    await withdraw(ORG_C1, c1, first?.id ?? "");
    const [second] = await accept(ORG_C1, c1, "code_reading", "rascunho-2");
    expect(second?.id).not.toBe(first?.id);
    const rows = await owner.query<{ id: string; withdrawn_at: Date | null }>(
      "select id, withdrawn_at from organization_consents where org_id = $1 and kind = 'code_reading' order by id",
      [ORG_C1],
    );
    const old = rows.rows.find((r) => r.id === first?.id);
    expect(old?.withdrawn_at).toBeInstanceOf(Date);
  });

  it("retirada exige quem retirou e quando, juntos", async () => {
    const [row] = await accept(ORG_C2, c2, "code_reading").catch(() => [{ id: "" }]);
    const target = row?.id
      ? row.id
      : (await owner.query<{ id: string }>("select id from organization_consents where org_id = $1 and kind = 'code_reading' and withdrawn_at is null", [ORG_C2])).rows[0]?.id ?? "";
    await expect(
      asTenant(prisma, ORG_C2, (tx) => tx.$executeRaw`update organization_consents set withdrawn_at = now() where id = ${target}::uuid`),
    ).rejects.toThrow(/check/i);
    await expect(
      asTenant(prisma, ORG_C2, (tx) => tx.$executeRaw`update organization_consents set withdrawn_by_person_id = ${c2.person}::uuid where id = ${target}::uuid`),
    ).rejects.toThrow(/check/i);
  });
});

describe("organization_consents: pessoa e registro", () => {
  it("não deixa apagar a pessoa que aceitou nem a que retirou", async () => {
    const person = (await owner.query<{ id: string }>(
      "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_consent_p', 'C', 'c@x.io', 'admin') returning id",
      [ORG_C1],
    )).rows[0]?.id ?? "";
    const [row] = await accept(ORG_C1, { ...c1, person }, "assistant").catch(async () => {
      await owner.query("update organization_consents set withdrawn_at = now(), withdrawn_by_person_id = $2 where org_id = $1 and kind = 'assistant' and withdrawn_at is null", [ORG_C1, c1.person]);
      return accept(ORG_C1, { ...c1, person }, "assistant");
    });
    expect(row?.id).toBeTruthy();
    await expect(owner.query("delete from people where id = $1", [person])).rejects.toThrow(/foreign key|violates/i);
  });

  it("a aplicação não apaga linhas de aceite (só o papel dono)", async () => {
    await expect(
      asTenant(prisma, ORG_C1, (tx) => tx.$executeRaw`delete from organization_consents where org_id = ${ORG_C1}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a aplicação só altera a retirada, nunca quem aceitou nem a versão", async () => {
    await expect(
      asTenant(prisma, ORG_C1, (tx) => tx.$executeRaw`update organization_consents set document_version = 'x' where org_id = ${ORG_C1}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(prisma, ORG_C1, (tx) => tx.$executeRaw`update organization_consents set accepted_by_person_id = ${c1.person}::uuid where org_id = ${ORG_C1}`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("organization_consents: isolamento entre organizações", () => {
  it("uma organização não enxerga nem altera o aceite da outra", async () => {
    const [row] = await owner.query<{ id: string }>("select id from organization_consents where org_id = $1 limit 1", [ORG_C2]).then((r) => r.rows);
    const id = row?.id ?? "";
    expect(await asTenant(prisma, ORG_C1, (tx) => tx.organizationConsent.findMany({ where: { id } }))).toHaveLength(0);
    const updated = await asTenant(prisma, ORG_C1, (tx) =>
      tx.organizationConsent.updateMany({ where: { id }, data: { withdrawnAt: new Date(), withdrawnByPersonId: c1.person } }),
    );
    expect(updated.count).toBe(0);
  });

  it("recusa gravar com a organização de outra no contexto", async () => {
    await expect(
      asTenant(prisma, ORG_C1, (tx) =>
        tx.$queryRaw`insert into organization_consents (org_id, kind, document_version, accepted_by_person_id)
          values (${ORG_C2}, 'assistant', 'rascunho-1', ${c2.person}::uuid)`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
