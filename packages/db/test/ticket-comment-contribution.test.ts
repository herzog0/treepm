import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_K1 = "org_CCB1";
const ORG_K2 = "org_CCB2";

let owner: pg.Pool;
let prisma: PrismaClient;
let k1: Ids;
let k2: Ids;
let counter = 900;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  k1 = await seedOrg(owner, ORG_K1);
  k2 = await seedOrg(owner, ORG_K2);
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
  const r = await owner.query<{ id: string }>("insert into areas (org_id, name) values ($1, $2) returning id", [orgId, name]);
  return r.rows[0]?.id ?? "";
}

const contributionOn = async (orgId: string, projectId: string, ticketId: string, areaId: string, createdBy: string): Promise<string> => {
  const rows = await asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id)
      values (${orgId}, ${projectId}::uuid, ${ticketId}::uuid, ${areaId}::uuid, ${createdBy}::uuid) returning id`,
  );
  return rows[0]?.id ?? "";
};

/** Grava pelo papel da aplicação, como a API faz; `contributionId` é opcional. */
const comment = (orgId: string, projectId: string, ticketId: string, authorId: string, body: string, contributionId: string | null = null) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, contribution_id)
      values (${orgId}, ${projectId}::uuid, ${ticketId}::uuid, ${authorId}::uuid, ${body}, ${contributionId}::uuid) returning id`,
  );

const read = async (id: string) => {
  const r = await owner.query<{ contribution_id: string | null; area_name: string | null; body: string }>(
    "select contribution_id, area_name, body from ticket_comments where id = $1",
    [id],
  );
  return r.rows[0];
};

describe("ticket_comments.contribution_id: referência", () => {
  it("grava comentário de área e comentário do ticket (nulo), sem nome guardado", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const c = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Dados-a"), k1.person);
    const [ofArea] = await comment(ORG_K1, k1.project, t, k1.person, "da área", c);
    const [ofTicket] = await comment(ORG_K1, k1.project, t, k1.person, "do ticket");
    expect(await read(ofArea?.id ?? "")).toMatchObject({ contribution_id: c, area_name: null });
    expect(await read(ofTicket?.id ?? "")).toMatchObject({ contribution_id: null, area_name: null });
  });

  it("a contribuição tem de ser do mesmo ticket do comentário", async () => {
    const t1 = await ticketIn(ORG_K1, k1.project, k1.person);
    const t2 = await ticketIn(ORG_K1, k1.project, k1.person);
    const c2 = await contributionOn(ORG_K1, k1.project, t2, await areaIn(ORG_K1, "Dados-b"), k1.person);
    await expect(comment(ORG_K1, k1.project, t1, k1.person, "x", c2)).rejects.toThrow(/foreign key/);
  });

  it("não aceita contribuição de outra organização", async () => {
    const t1 = await ticketIn(ORG_K1, k1.project, k1.person);
    const t2 = await ticketIn(ORG_K2, k2.project, k2.person);
    const c2 = await contributionOn(ORG_K2, k2.project, t2, await areaIn(ORG_K2, "Dados-c"), k2.person);
    await expect(comment(ORG_K1, k1.project, t1, k1.person, "x", c2)).rejects.toThrow(/foreign key/);
  });

  it("indexa a leitura dos comentários de uma contribuição em ordem de tempo", async () => {
    const r = await owner.query<{ cols: string[] }>(
      `select array(
         select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         order by k.ord) as cols
       from pg_index i join pg_class c on c.oid = i.indrelid
       where c.relname = 'ticket_comments' and not i.indisprimary`,
    );
    expect(r.rows.map((row) => row.cols)).toContainEqual(["org_id", "contribution_id", "created_at", "id"]);
  });
});

describe("remover a contribuição não apaga os comentários dela", () => {
  it("eles viram comentários do ticket (sem área) e guardam o nome que a área tinha", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const area = await areaIn(ORG_K1, "Segurança");
    const c = await contributionOn(ORG_K1, k1.project, t, area, k1.person);
    const [a] = await comment(ORG_K1, k1.project, t, k1.person, "um", c);
    const [b] = await comment(ORG_K1, k1.project, t, k1.person, "dois", c);
    const [plain] = await comment(ORG_K1, k1.project, t, k1.person, "do ticket");
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contributions where id = ${c}::uuid`);
    expect(await read(a?.id ?? "")).toEqual({ contribution_id: null, area_name: "Segurança", body: "um" });
    expect(await read(b?.id ?? "")).toEqual({ contribution_id: null, area_name: "Segurança", body: "dois" });
    expect(await read(plain?.id ?? "")).toEqual({ contribution_id: null, area_name: null, body: "do ticket" });
  });

  it("o comentário removido (corpo vazio) também guarda o nome", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const c = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Infra"), k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "sumiu", c);
    await asTenant(prisma, ORG_K1, (tx) =>
      tx.$executeRaw`update ticket_comments set body = '', removed_at = now(), removed_by_person_id = ${k1.person}::uuid where id = ${row?.id}::uuid`,
    );
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contributions where id = ${c}::uuid`);
    expect(await read(row?.id ?? "")).toEqual({ contribution_id: null, area_name: "Infra", body: "" });
  });

  it("excluir o ticket continua levando contribuições e comentários", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const c = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Design"), k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x", c);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from tickets where id = ${t}::uuid`);
    expect(await read(row?.id ?? "")).toBeUndefined();
  });

  it("os comentários de uma contribuição não mudam os de outra", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const c1 = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Um"), k1.person);
    const c2 = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Dois"), k1.person);
    const [a] = await comment(ORG_K1, k1.project, t, k1.person, "a", c1);
    const [b] = await comment(ORG_K1, k1.project, t, k1.person, "b", c2);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_contributions where id = ${c1}::uuid`);
    expect(await read(a?.id ?? "")).toMatchObject({ contribution_id: null, area_name: "Um" });
    expect(await read(b?.id ?? "")).toMatchObject({ contribution_id: c2, area_name: null });
  });
});

describe("privilégio mínimo do papel da aplicação", () => {
  it("não move comentário de área nem escreve o nome guardado", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const c1 = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Alfa"), k1.person);
    const c2 = await contributionOn(ORG_K1, k1.project, t, await areaIn(ORG_K1, "Beta"), k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x", c1);
    for (const set of [`contribution_id = '${c2}'::uuid`, "contribution_id = null", "area_name = 'Forjado'"]) {
      await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRawUnsafe(`update ticket_comments set ${set} where id = '${row?.id}'::uuid`)), set).rejects.toThrow(/permission denied/i);
    }
    expect(await read(row?.id ?? "")).toMatchObject({ contribution_id: c1, area_name: null });
  });

  it("continua sem poder trocar ticket, autor e data, e editando só corpo e remoção", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x");
    await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set created_at = now() where id = ${row?.id}::uuid`)).rejects.toThrow(/permission denied/i);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set body = 'y', edited_at = now() where id = ${row?.id}::uuid`);
  });
});
