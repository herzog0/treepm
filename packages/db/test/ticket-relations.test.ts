import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_R1 = "org_R1";
const ORG_R2 = "org_R2";

let owner: pg.Pool;
let prisma: PrismaClient;
let r1: Ids;
let r2: Ids;
let counter = 200;
let otherProject = "";

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  r1 = await seedOrg(owner, ORG_R1);
  r2 = await seedOrg(owner, ORG_R2);
  const other = await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Outro', 'OUT') returning id", [ORG_R1]);
  otherProject = other.rows[0]?.id ?? "";
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

/** Cria um ticket pelo papel dono (semeadura) e devolve o id. */
async function ticketIn(orgId: string, projectId: string, personId: string): Promise<string> {
  const r = await owner.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'T', $4) returning id",
    [orgId, projectId, ++counter, personId],
  );
  return r.rows[0]?.id ?? "";
}

/** Grava uma ligação pelo papel de aplicação (`treepm_app`), com RLS, como a API faz. */
const relate = (orgId: string, projectId: string, from: string, to: string, kind: string) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind)
      values (${orgId}, ${projectId}::uuid, ${from}::uuid, ${to}::uuid, ${kind}) returning id`,
  );

const count = async (from: string): Promise<number> => {
  const r = await owner.query<{ n: number }>("select count(*)::int as n from ticket_relations where from_ticket_id = $1 or to_ticket_id = $1", [from]);
  return r.rows[0]?.n ?? -1;
};

describe("ticket_relations: gravar e ler", () => {
  it("grava e lê uma ligação de cada tipo, com id v7 e datas", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    const [mention] = await relate(ORG_R1, r1.project, a, b, "mentions");
    const [dependency] = await relate(ORG_R1, r1.project, b, a, "depends_on");
    expect(mention?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const rows = await asTenant(prisma, ORG_R1, (tx) =>
      tx.$queryRaw<{ from_ticket_id: string; to_ticket_id: string; kind: string; created_at: Date; updated_at: Date }[]>`
        select from_ticket_id, to_ticket_id, kind, created_at, updated_at from ticket_relations
         where from_ticket_id in (${a}::uuid, ${b}::uuid) order by kind`,
    );
    expect(rows.map((r) => [r.kind, r.from_ticket_id, r.to_ticket_id])).toEqual([
      ["depends_on", b, a],
      ["mentions", a, b],
    ]);
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
    expect(dependency?.id).not.toBe(mention?.id);
  });

  it("o mesmo par aceita os dois tipos ao mesmo tempo", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    await relate(ORG_R1, r1.project, a, b, "mentions");
    await relate(ORG_R1, r1.project, a, b, "depends_on");
    expect(await count(a)).toBe(2);
  });

  it("os dois sentidos do mesmo par e tipo são ligações diferentes", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    await relate(ORG_R1, r1.project, a, b, "mentions");
    await relate(ORG_R1, r1.project, b, a, "mentions");
    expect(await count(a)).toBe(2);
  });
});

describe("ticket_relations: o que o banco recusa", () => {
  it("tipo desconhecido (23514)", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    const error = await relate(ORG_R1, r1.project, a, b, "related_to").catch((e: unknown) => e);
    expect((error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode).toBe("23514");
    await expect(owner.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'x')", [ORG_R1, r1.project, a, b])).rejects.toMatchObject({ code: "23514" });
  });

  it("ligação consigo mesmo (23514)", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    for (const kind of ["mentions", "depends_on"]) {
      await expect(owner.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $3, $4)", [ORG_R1, r1.project, a, kind])).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("par e tipo repetidos (23505)", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    await relate(ORG_R1, r1.project, a, b, "depends_on");
    await expect(owner.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'depends_on')", [ORG_R1, r1.project, a, b])).rejects.toMatchObject({ code: "23505" });
  });

  it("ponta de outro projeto da mesma organização, em qualquer das duas pontas (23503)", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const foreign = await ticketIn(ORG_R1, otherProject, r1.person);
    const insert = "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'mentions')";
    await expect(owner.query(insert, [ORG_R1, r1.project, a, foreign])).rejects.toMatchObject({ code: "23503" });
    await expect(owner.query(insert, [ORG_R1, r1.project, foreign, a])).rejects.toMatchObject({ code: "23503" });
  });

  it("ponta de outra organização, em qualquer das duas pontas (23503)", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const foreign = await ticketIn(ORG_R2, r2.project, r2.person);
    const insert = "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'mentions')";
    await expect(owner.query(insert, [ORG_R1, r1.project, a, foreign])).rejects.toMatchObject({ code: "23503" });
    await expect(owner.query(insert, [ORG_R1, r1.project, foreign, a])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("ticket_relations: remover um ticket", () => {
  it("remove as ligações em que ele é origem e em que é destino, e só elas", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    const c = await ticketIn(ORG_R1, r1.project, r1.person);
    await relate(ORG_R1, r1.project, a, b, "mentions");
    await relate(ORG_R1, r1.project, c, a, "depends_on");
    await relate(ORG_R1, r1.project, b, c, "mentions");
    await asTenant(prisma, ORG_R1, (tx) => tx.$executeRaw`delete from tickets where id = ${a}::uuid`);
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(1);
    expect(await count(c)).toBe(1);
  });

  it("remover o projeto remove as ligações dele", async () => {
    const project = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Efêmero', 'EFE') returning id", [ORG_R1])).rows[0]?.id ?? "";
    const a = await ticketIn(ORG_R1, project, r1.person);
    const b = await ticketIn(ORG_R1, project, r1.person);
    await relate(ORG_R1, project, a, b, "mentions");
    await owner.query("delete from projects where id = $1", [project]);
    expect(await count(a)).toBe(0);
  });
});

describe("ticket_relations: isolamento por organização", () => {
  it("uma organização não lê as ligações da outra", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    await relate(ORG_R1, r1.project, a, b, "mentions");
    const seen = await asTenant(prisma, ORG_R2, (tx) => tx.$queryRaw<unknown[]>`select 1 from ticket_relations where from_ticket_id = ${a}::uuid`);
    expect(seen).toHaveLength(0);
  });

  it("uma organização não grava ligação com a identidade da outra", async () => {
    const a = await ticketIn(ORG_R1, r1.project, r1.person);
    const b = await ticketIn(ORG_R1, r1.project, r1.person);
    await expect(relate(ORG_R2, r1.project, a, b, "mentions")).rejects.toThrow();
    await expect(
      asTenant(prisma, ORG_R2, (tx) =>
        tx.$executeRaw`insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values (${ORG_R1}, ${r1.project}::uuid, ${a}::uuid, ${b}::uuid, 'mentions')`,
      ),
    ).rejects.toThrow(/row-level security/i);
    expect(await count(a)).toBe(0);
  });
});
