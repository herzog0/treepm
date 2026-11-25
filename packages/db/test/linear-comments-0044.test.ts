import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0044 (ADR 0061, fatia 2; TREEPM-477): origem por item e comentário com autor de fora do TreePM.
const ORG_1 = "org_C44a";
const ORG_2 = "org_C44b";
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

/** Um comentário pelo papel da aplicação, na organização 1. */
const comment = (data: Record<string, unknown>) =>
  asTenant(prisma, ORG_1, (tx) => tx.ticketComment.create({ data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, body: "Olá", ...data } as never, select: { id: true } }));

describe("ticket_comments: autor que não é pessoa do TreePM", () => {
  it("comentário comum continua exigindo a pessoa", async () => {
    expect(await failure(() => comment({}))).toMatch(/check|author/i);
    expect(await failure(() => comment({ via: "mcp" }))).toMatch(/check|author/i);
  });

  it("comentário do Linear aceita a pessoa casada, o nome de quem não casou, ou nenhum dos dois (autor apagado no Linear)", async () => {
    expect(await comment({ via: "linear", authorPersonId: a.person })).toHaveProperty("id");
    expect(await comment({ via: "linear", externalAuthorName: "Ana (do Linear)" })).toHaveProperty("id");
    expect(await comment({ via: "linear" })).toHaveProperty("id");
  });

  it("pessoa e nome juntos não valem; nome sem ser do Linear também não", async () => {
    expect(await failure(() => comment({ via: "linear", authorPersonId: a.person, externalAuthorName: "Ana" }))).toMatch(/check/i);
    expect(await failure(() => comment({ authorPersonId: a.person, externalAuthorName: "Ana" }))).toMatch(/check/i);
  });

  it("o nome tem de 1 a 120 caracteres", async () => {
    expect(await failure(() => comment({ via: "linear", externalAuthorName: "x".repeat(121) }))).toMatch(/check/i);
    expect(await failure(() => comment({ via: "linear", externalAuthorName: "" }))).toMatch(/check/i);
    expect(await comment({ via: "linear", externalAuthorName: "x".repeat(120) })).toHaveProperty("id");
  });

  it("o autor de um comentário do Linear acompanha o casamento atual: nome → pessoa → outra pessoa → nome → ninguém (C2, item 3)", async () => {
    const { id } = await comment({ via: "linear", externalAuthorName: "Ana" });
    const other = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'user_c44_y', 'Y', 'y@x.io', 'member') returning id", [ORG_1])).rows[0]?.id as string;
    const read = async () => (await owner.query("select author_person_id, external_author_name from ticket_comments where id = $1", [id])).rows[0];
    const set = (data: Record<string, unknown>) => asTenant(prisma, ORG_1, (tx) => tx.ticketComment.update({ where: { orgId_id: { orgId: ORG_1, id } }, data }));
    await set({ authorPersonId: a.person, externalAuthorName: null });
    expect(await read()).toEqual({ author_person_id: a.person, external_author_name: null });
    await set({ authorPersonId: other });
    expect(await read()).toEqual({ author_person_id: other, external_author_name: null });
    await set({ authorPersonId: null, externalAuthorName: "Ana" });
    expect(await read()).toEqual({ author_person_id: null, external_author_name: "Ana" });
    await set({ externalAuthorName: null });
    expect(await read()).toEqual({ author_person_id: null, external_author_name: null });
  });

  it("o nome de exibição de quem não casou pode mudar (renomeado no Linear)", async () => {
    const { id } = await comment({ via: "linear", externalAuthorName: "Ana" });
    await asTenant(prisma, ORG_1, (tx) => tx.ticketComment.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { externalAuthorName: "Ana Maria" } }));
    expect((await owner.query("select external_author_name from ticket_comments where id = $1", [id])).rows[0]).toEqual({ external_author_name: "Ana Maria" });
  });

  it("o autor de comentário escrito no TreePM nunca muda", async () => {
    const { id } = await comment({ authorPersonId: a.person });
    const other = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'user_c44_x', 'X', 'x@x.io', 'member') returning id", [ORG_1])).rows[0]?.id as string;
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.ticketComment.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { authorPersonId: other } })))).toMatch(/autor|author/i);
    // Nem pelo dono (o gatilho vale para todos).
    expect(await failure(() => owner.query("update ticket_comments set author_person_id = $2::uuid where id = $1::uuid", [id, other]))).toMatch(/autor|author/i);
  });

  it("a origem e o via de um comentário não mudam pelo papel da aplicação", async () => {
    const { id } = await comment({ via: "linear", externalAuthorName: "Ana" });
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.ticketComment.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { via: null } })))).toMatch(/permission|denied/i);
  });
});

/** Uma origem de comentário pelo papel da aplicação. */
const ref = (orgId: string, ids: Ids, data: Record<string, unknown> = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.externalItemRef.create({ data: { orgId, projectId: ids.project, ticketId: ids.ticket, provider: "linear", kind: "comment", externalId: "c-1", ...data } as never, select: { id: true } }),
  );

describe("external_item_refs: origem por item", () => {
  it("o papel da aplicação cria e lê, com os padrões", async () => {
    await ref(ORG_1, a, { externalId: "c-def" });
    const row = (await owner.query("select provider, kind, local_id, applied, missing_since, removed_here_at, last_seen_run_id, first_imported_at is not null as first, last_imported_at is not null as last from external_item_refs where external_id = 'c-def'")).rows[0];
    expect(row).toEqual({ provider: "linear", kind: "comment", local_id: null, applied: {}, missing_since: null, removed_here_at: null, last_seen_run_id: null, first: true, last: true });
  });

  it("único por organização, provedor, tipo e id externo; outra organização pode ter o mesmo", async () => {
    await ref(ORG_1, a, { externalId: "c-uniq" });
    expect(await failure(() => ref(ORG_1, a, { externalId: "c-uniq" }))).toMatch(/unique/i);
    expect(await ref(ORG_2, b, { externalId: "c-uniq" })).toHaveProperty("id");
  });

  it("só o provedor linear e o tipo comment, por enquanto", async () => {
    expect(await failure(() => ref(ORG_1, a, { externalId: "c-p", provider: "jira" }))).toMatch(/check/i);
    expect(await failure(() => ref(ORG_1, a, { externalId: "c-k", kind: "relation" }))).toMatch(/check/i);
  });

  it("o ticket tem de ser do projeto e da organização", async () => {
    expect(await failure(() => ref(ORG_1, { ...a, ticket: b.ticket }, { externalId: "c-x" }))).toMatch(/foreign key/i);
  });

  it("a aplicação atualiza o estado da origem, mas não o id externo nem o ticket, e não apaga", async () => {
    const { id } = await ref(ORG_1, a, { externalId: "c-upd" });
    const when = new Date("2026-11-25T10:00:00.000Z");
    await asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { localId: null, applied: { body: "x" }, externalUpdatedAt: when, missingSince: when, removedHereAt: when, lastImportedAt: when } }));
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { externalId: "outro" } })))).toMatch(/permission|denied/i);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.delete({ where: { orgId_id: { orgId: ORG_1, id } } })))).toMatch(/permission|denied/i);
  });

  it("RLS: outra organização não vê nem altera", async () => {
    await ref(ORG_1, a, { externalId: "c-rls" });
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalItemRef.findMany({ where: { externalId: "c-rls" } }))).toEqual([]);
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalItemRef.updateMany({ where: { externalId: "c-rls" }, data: { missingSince: new Date() } }))).toMatchObject({ count: 0 });
    expect(await failure(() => asTenant(prisma, ORG_2, (tx) => tx.externalItemRef.create({ data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, provider: "linear", kind: "comment", externalId: "c-rls2" } })))).toMatch(/row-level|policy/i);
  });

  it("apagar o ticket apaga as origens dele (cascata)", async () => {
    const ticket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 44, 'Vai', $3) returning id", [ORG_1, a.project, a.person])).rows[0]?.id as string;
    await ref(ORG_1, { ...a, ticket }, { externalId: "c-cascade" });
    await owner.query("delete from tickets where id = $1", [ticket]);
    expect((await owner.query("select count(*)::int n from external_item_refs where external_id = 'c-cascade'")).rows[0]).toEqual({ n: 0 });
  });
});

describe("external_import_runs: a fase comments", () => {
  it("é aceita", async () => {
    const run = (await owner.query<{ id: string }>("insert into external_import_runs (org_id, project_id, provider, started_by_person_id, mode, phase, counts) values ($1, $2, 'linear', $3, 'first', 'comments', '{}') returning id", [ORG_1, a.project, a.person])).rows[0];
    expect(run?.id).toBeTruthy();
    await owner.query("update external_import_runs set phase = 'failed' where id = $1", [run?.id]);
  });
});
