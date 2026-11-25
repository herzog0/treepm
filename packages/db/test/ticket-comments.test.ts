import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_K1 = "org_CMT1";
const ORG_K2 = "org_CMT2";

let owner: pg.Pool;
let prisma: PrismaClient;
let k1: Ids;
let k2: Ids;
let counter = 400;
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

/** Grava pelo papel da aplicação (`treepm_app`), com RLS, como a API faz. */
const comment = (orgId: string, projectId: string, ticketId: string, authorId: string, body: string) =>
  asTenant(prisma, orgId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body)
      values (${orgId}, ${projectId}::uuid, ${ticketId}::uuid, ${authorId}::uuid, ${body}) returning id`,
  );

const commentsOf = async (ticketId: string): Promise<number> => {
  const r = await owner.query<{ n: number }>("select count(*)::int as n from ticket_comments where ticket_id = $1", [ticketId]);
  return r.rows[0]?.n ?? -1;
};

describe("ticket_comments: gravar e ler", () => {
  it("grava com id v7, datas e campos de edição e remoção nulos", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "Olá");
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const read = await asTenant(prisma, ORG_K1, (tx) =>
      tx.$queryRaw<{ body: string; created_at: Date; edited_at: Date | null; removed_at: Date | null; removed_by_person_id: string | null }[]>`
        select body, created_at, edited_at, removed_at, removed_by_person_id from ticket_comments where id = ${row?.id}::uuid`,
    );
    expect(read[0]?.body).toBe("Olá");
    expect(read[0]?.created_at).toBeInstanceOf(Date);
    expect(read[0]?.edited_at).toBeNull();
    expect(read[0]?.removed_at).toBeNull();
    expect(read[0]?.removed_by_person_id).toBeNull();
  });

  it("outra organização não vê o comentário", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await comment(ORG_K1, k1.project, t, k1.person, "Só da C1");
    const seen = await asTenant(prisma, ORG_K2, (tx) => tx.$queryRaw<unknown[]>`select 1 from ticket_comments where ticket_id = ${t}::uuid`);
    expect(seen).toHaveLength(0);
  });

  it("indexa a leitura por ticket em ordem de tempo", async () => {
    const r = await owner.query<{ cols: string[] }>(
      `select array(
         select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         order by k.ord) as cols
       from pg_index i join pg_class c on c.oid = i.indrelid
       where c.relname = 'ticket_comments' and not i.indisprimary`,
    );
    expect(r.rows.map((row) => row.cols)).toContainEqual(["org_id", "ticket_id", "created_at", "id"]);
  });
});

describe("ticket_comments: restrições do corpo", () => {
  it("rejeita corpo vazio e corpo acima de 10.000 em comentário não removido", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await expect(comment(ORG_K1, k1.project, t, k1.person, "")).rejects.toThrow(/ticket_comments_body_check/);
    await expect(comment(ORG_K1, k1.project, t, k1.person, "a".repeat(10_001))).rejects.toThrow(/ticket_comments_body_check/);
    await comment(ORG_K1, k1.project, t, k1.person, "a".repeat(10_000));
    await comment(ORG_K1, k1.project, t, k1.person, "a");
    expect(await commentsOf(t)).toBe(2);
  });

  it("removido exige corpo vazio na mesma gravação, e não removido não pode ficar vazio", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "Vai sumir");
    const id = row?.id;
    await expect(
      asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set removed_at = now(), removed_by_person_id = ${k1.person}::uuid where id = ${id}::uuid`),
    ).rejects.toThrow(/ticket_comments_body_check/);
    await expect(
      asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set body = '' where id = ${id}::uuid`),
    ).rejects.toThrow(/ticket_comments_body_check/);
    await asTenant(prisma, ORG_K1, (tx) =>
      tx.$executeRaw`update ticket_comments set body = '', removed_at = now(), removed_by_person_id = ${second}::uuid where id = ${id}::uuid`,
    );
    const r = await owner.query<{ body: string; removed_by_person_id: string }>("select body, removed_by_person_id from ticket_comments where id = $1", [id]);
    expect(r.rows[0]).toEqual({ body: "", removed_by_person_id: second });
  });

  it("removido sem quem removeu (ou o contrário) é rejeitado", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x");
    await expect(
      asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set body = '', removed_at = now() where id = ${row?.id}::uuid`),
    ).rejects.toThrow(/ticket_comments_removal_check/);
    await expect(
      asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set removed_by_person_id = ${second}::uuid where id = ${row?.id}::uuid`),
    ).rejects.toThrow(/ticket_comments_removal_check/);
  });
});

describe("ticket_comments: referências", () => {
  it("excluir o ticket exclui os comentários", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await comment(ORG_K1, k1.project, t, k1.person, "um");
    await comment(ORG_K1, k1.project, t, second, "dois");
    expect(await commentsOf(t)).toBe(2);
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from tickets where id = ${t}::uuid`);
    expect(await commentsOf(t)).toBe(0);
  });

  it("a pessoa que escreveu não pode ser apagada", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await comment(ORG_K1, k1.project, t, second, "autoria");
    await expect(owner.query("delete from people where org_id = $1 and id = $2", [ORG_K1, second])).rejects.toThrow(/foreign key/);
  });

  it("a pessoa que removeu também não pode ser apagada", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x");
    const third = await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_third', 'Cris', 'c@x.io', 'member') returning id", [ORG_K1]);
    const thirdId = third.rows[0]?.id ?? "";
    await asTenant(prisma, ORG_K1, (tx) =>
      tx.$executeRaw`update ticket_comments set body = '', removed_at = now(), removed_by_person_id = ${thirdId}::uuid where id = ${row?.id}::uuid`,
    );
    await expect(owner.query("delete from people where org_id = $1 and id = $2", [ORG_K1, thirdId])).rejects.toThrow(/foreign key/);
  });

  it("não aceita ticket de outro projeto no par (projeto, ticket)", async () => {
    const other = await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Outro', 'OTH') returning id", [ORG_K1]);
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await expect(comment(ORG_K1, other.rows[0]?.id ?? "", t, k1.person, "x")).rejects.toThrow(/foreign key/);
  });

  it("não aceita ticket ou pessoa de outra organização", async () => {
    const t2 = await ticketIn(ORG_K2, k2.project, k2.person);
    await expect(comment(ORG_K1, k2.project, t2, k1.person, "x")).rejects.toThrow(/foreign key/);
    const t1 = await ticketIn(ORG_K1, k1.project, k1.person);
    await expect(comment(ORG_K1, k1.project, t1, k2.person, "x")).rejects.toThrow(/foreign key/);
  });
});

describe("ticket_comments: privilégio mínimo do papel da aplicação", () => {
  it("não apaga comentário (remover é UPDATE)", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "fica");
    await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from ticket_comments where id = ${row?.id}::uuid`)).rejects.toThrow(/permission denied/i);
    expect(await commentsOf(t)).toBe(1);
  });

  it("não altera autor, ticket nem data de criação; altera só o que a edição e a remoção tocam", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    const [row] = await comment(ORG_K1, k1.project, t, k1.person, "x");
    const other = await ticketIn(ORG_K1, k1.project, k1.person);
    for (const set of ["author_person_id = '" + second + "'::uuid", "ticket_id = '" + other + "'::uuid", "created_at = now()", "project_id = project_id", "id = gen_random_uuid()"]) {
      await expect(asTenant(prisma, ORG_K1, (tx) => tx.$executeRawUnsafe(`update ticket_comments set ${set} where id = '${row?.id}'::uuid`)), set).rejects.toThrow(
        // Desde a 0044 o autor tem UPDATE (só para promover o autor do Linear a pessoa); o gatilho recusa em todo comentário escrito no TreePM.
        set.startsWith("author_person_id") ? /autor de um coment/i : /permission denied/i,
      );
    }
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`update ticket_comments set body = 'y', edited_at = now() where id = ${row?.id}::uuid`);
    expect(await commentsOf(t)).toBe(1);
  });

  it("excluir o ticket pelo papel da aplicação continua levando os comentários", async () => {
    const t = await ticketIn(ORG_K1, k1.project, k1.person);
    await comment(ORG_K1, k1.project, t, k1.person, "um");
    await asTenant(prisma, ORG_K1, (tx) => tx.$executeRaw`delete from tickets where id = ${t}::uuid`);
    expect(await commentsOf(t)).toBe(0);
  });
});
