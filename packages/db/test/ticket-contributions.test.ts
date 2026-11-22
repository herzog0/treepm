import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_K1 = "org_CTB1";
const ORG_K2 = "org_CTB2";

let owner: pg.Pool;
let prisma: PrismaClient;
let k1: Ids;
let k2: Ids;
let counter = 700;
let second = "";

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  k1 = await seedOrg(owner, ORG_K1);
  k2 = await seedOrg(owner, ORG_K2);
  const other = await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_second', 'Bia', 'b@x.io', 'member') returning id", [ORG_K1]);
  second = other.rows[0]?.id ?? "";
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function ticketIn(orgId: string, projectId: string, personId: string): Promise<string> {
  const r = await owner.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'T', $4) returning id",
    [orgId, projectId, ++counter, personId],
  );
  return r.rows[0]?.id ?? "";
}

async function areaIn(orgId: string, name: string): Promise<string> {
  const r = await owner.query<{ id: string }>("insert into areas (org_id, name) values ($1, $2) returning id", [orgId, `${name}-${++counter}`]);
  return r.rows[0]?.id ?? "";
}

/** Grava pelo papel da aplicação (`treepm_app`), com RLS, como a API faz. */
const contribution = (orgId: string, projectId: string, ticketId: string, areaId: string, createdBy: string, text?: string) =>
  asTenant(prisma, orgId, (tx) =>
    text === undefined
      ? tx.$queryRaw<{ id: string }[]>`
          insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id)
          values (${orgId}, ${projectId}::uuid, ${ticketId}::uuid, ${areaId}::uuid, ${createdBy}::uuid) returning id`
      : tx.$queryRaw<{ id: string }[]>`
          insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id, text)
          values (${orgId}, ${projectId}::uuid, ${ticketId}::uuid, ${areaId}::uuid, ${createdBy}::uuid, ${text}) returning id`,
  );

const addPerson = (orgId: string, contributionId: string, personId: string) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into ticket_contribution_people (org_id, contribution_id, person_id) values (${orgId}, ${contributionId}::uuid, ${personId}::uuid)`,
  );

const count = async (table: string, column: string, value: string): Promise<number> => {
  const r = await owner.query<{ n: number }>(`select count(*)::int as n from ${table} where ${column} = $1`, [value]);
  return r.rows[0]?.n ?? -1;
};

describe("ticket_contributions: gravar e ler", () => {
  it("grava com id v7, texto vazio e situação a fazer por padrão", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const a = await areaIn(ORG_K1, "Design");
    const [row] = await contribution(ORG_K1, k1.project, t, a, k1.person);
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const read = await asTenant(prisma, ORG_K1, (tx) =>
      tx.$queryRaw<{ text: string; status: string; created_at: Date }[]>`select text, status, created_at from ticket_contributions where id = ${row?.id}::uuid`,
    );
    expect(read[0]?.text).toBe("");
    expect(read[0]?.status).toBe("todo");
    expect(read[0]?.created_at).toBeInstanceOf(Date);
  });

  it("outra organização não vê a contribuição nem as pessoas", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "X"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    const seen = await asTenant(prisma, ORG_K2, (tx) => tx.$queryRaw<unknown[]>`select 1 from ticket_contributions where ticket_id = ${t}::uuid`);
    expect(seen).toHaveLength(0);
    const people = await asTenant(prisma, ORG_K2, (tx) => tx.$queryRaw<unknown[]>`select 1 from ticket_contribution_people where contribution_id = ${row?.id}::uuid`);
    expect(people).toHaveLength(0);
  });

  it("indexa a leitura por ticket em ordem de criação e a contagem por área", async () => {
    const r = await owner.query<{ cols: string[] }>(
      `select array(
         select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         order by k.ord) as cols
       from pg_index i join pg_class c on c.oid = i.indrelid
       where c.relname = 'ticket_contributions' and not i.indisprimary`,
    );
    const all = r.rows.map((row) => row.cols);
    expect(all).toContainEqual(["org_id", "ticket_id", "created_at", "id"]);
    expect(all).toContainEqual(["org_id", "area_id"]);
  });
});

describe("ticket_contributions: restrições", () => {
  it("é única por ticket e área", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const a = await areaIn(ORG_K1, "Dup");
    await contribution(ORG_K1, k1.project, t, a, k1.person);
    await expect(contribution(ORG_K1, k1.project, t, a, k1.person)).rejects.toThrow(/unique|duplicate/i);
    await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Outra"), k1.person);
    expect(await count("ticket_contributions", "ticket_id", t)).toBe(2);
  });

  it("limita o texto a 20.000 caracteres e a situação às três", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await expect(contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "G"), k1.person, "a".repeat(20_001))).rejects.toThrow(/ticket_contributions_text_check/);
    const [ok] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "G"), k1.person, "a".repeat(20_000));
    await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_contributions set status = 'blocked' where id = ${ok?.id}::uuid`)).rejects.toThrow(/ticket_contributions_status_check/);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_contributions set status = 'in_progress' where id = ${ok?.id}::uuid`);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_contributions set status = 'done', text = '' where id = ${ok?.id}::uuid`);
  });

  it("a pessoa só entra uma vez por contribuição", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "P"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    await expect(addPerson(ORG_K1, row?.id ?? "", second)).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("ticket_contributions: referências", () => {
  it("excluir o ticket exclui as contribuições e as pessoas delas", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "C"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from tickets where id = ${t}::uuid`);
    expect(await count("ticket_contributions", "ticket_id", t)).toBe(0);
    expect(await count("ticket_contribution_people", "contribution_id", row?.id ?? "")).toBe(0);
  });

  it("excluir a contribuição exclui as pessoas dela", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "D"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contributions where id = ${row?.id}::uuid`);
    expect(await count("ticket_contribution_people", "contribution_id", row?.id ?? "")).toBe(0);
  });

  it("uma área com contribuição não pode ser apagada, nem pelo papel da aplicação", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const a = await areaIn(ORG_K1, "Presa");
    await contribution(ORG_K1, k1.project, t, a, k1.person);
    await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from areas where id = ${a}::uuid`)).rejects.toThrow(/foreign key/);
    await expect(owner.query("delete from areas where org_id = $1 and id = $2", [ORG_K1, a])).rejects.toThrow(/foreign key/);
  });

  it("quem criou e a pessoa da contribuição não podem ser apagados", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const third = await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_c3', 'Cris', 'c@x.io', 'member') returning id", [ORG_K1]);
    const fourth = await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_c4', 'Dani', 'd@x.io', 'member') returning id", [ORG_K1]);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Q"), third.rows[0]?.id ?? "");
    await addPerson(ORG_K1, row?.id ?? "", fourth.rows[0]?.id ?? "");
    await expect(owner.query("delete from people where org_id = $1 and id = $2", [ORG_K1, third.rows[0]?.id])).rejects.toThrow(/foreign key/);
    await expect(owner.query("delete from people where org_id = $1 and id = $2", [ORG_K1, fourth.rows[0]?.id])).rejects.toThrow(/foreign key/);
  });

  it("não aceita ticket de outro projeto, nem área ou pessoa de outra organização", async () => {
    const other = await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Outro', 'OTC') returning id", [ORG_K1]);
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const a = await areaIn(ORG_K1, "R");
    await expect(contribution(ORG_K1, other.rows[0]?.id ?? "", t, a, k1.person)).rejects.toThrow(/foreign key/);
    await expect(contribution(ORG_K1, k1.project, t, await areaIn(ORG_K2, "R2"), k1.person)).rejects.toThrow(/foreign key/);
    await expect(contribution(ORG_K1, k1.project, t, a, k2.person)).rejects.toThrow(/foreign key/);
    const [row] = await contribution(ORG_K1, k1.project, t, a, k1.person);
    await expect(addPerson(ORG_K1, row?.id ?? "", k2.person)).rejects.toThrow(/foreign key/);
  });
});

describe("ticket_contributions: privilégio mínimo do papel da aplicação", () => {
  it("apaga a contribuição e as pessoas (a remoção é de verdade)", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Del"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contribution_people where contribution_id = ${row?.id}::uuid`);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contributions where id = ${row?.id}::uuid`);
    expect(await count("ticket_contributions", "id", row?.id ?? "")).toBe(0);
  });

  it("não altera área, ticket, autoria nem data de criação; altera só texto e situação", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const a = await areaIn(ORG_K1, "Imutável");
    const [row] = await contribution(ORG_K1, k1.project, t, a, k1.person);
    const other = await ticketIn(ORG_K1, k1.project, k1.person);
    const otherArea = await areaIn(ORG_K1, "Outra");
    const sets = [
      `area_id = '${otherArea}'::uuid`,
      `ticket_id = '${other}'::uuid`,
      `created_by_person_id = '${second}'::uuid`,
      "created_at = now()",
      "project_id = project_id",
      "id = gen_random_uuid()",
    ];
    for (const set of sets) {
      await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRawUnsafe(`update ticket_contributions set ${set} where id = '${row?.id}'::uuid`)), set).rejects.toThrow(/permission denied/i);
    }
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_contributions set text = 'y', status = 'done' where id = ${row?.id}::uuid`);
  });

  it("não altera as linhas das pessoas (só entram e saem)", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await contribution(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Pp"), k1.person);
    await addPerson(ORG_K1, row?.id ?? "", second);
    await expect(
      asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_contribution_people set person_id = ${k1.person}::uuid where contribution_id = ${row?.id}::uuid`),
    ).rejects.toThrow(/permission denied/i);
  });
});
