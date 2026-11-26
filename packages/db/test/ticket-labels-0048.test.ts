import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0048 (ADR 0065; TREEPM-466): etiquetas por projeto, etiquetas do ticket e a origem da etiqueta no Linear.
const ORG_1 = "org_L48a";
const ORG_2 = "org_L48b";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;
let b: Ids;
/** Um segundo projeto da organização 1, com um ticket. */
let otherProject: string;
let otherTicket: string;
let counter = 0;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
  b = await seedOrg(owner, ORG_2);
  otherProject = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Outro', 'OTH') returning id", [ORG_1])).rows[0]?.id as string;
  otherTicket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1, 'O', $3) returning id", [ORG_1, otherProject, a.person])).rows[0]?.id as string;
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

const label = (fields: { name?: string; nameKey?: string; color?: string; projectId?: string } = {}) => {
  counter += 1;
  const name = fields.name ?? `Etiqueta ${counter}`;
  return asTenant(prisma, ORG_1, (tx) =>
    tx.projectLabel.create({ data: { orgId: ORG_1, projectId: fields.projectId ?? a.project, name, nameKey: fields.nameKey ?? name.toLowerCase(), color: fields.color ?? "gray" }, select: { id: true } }),
  );
};

describe("project_labels", () => {
  it("guarda nome, chave e cor; o nome é único no projeto pela chave", async () => {
    expect(await label({ name: "Bug", nameKey: "bug", color: "orange" })).toHaveProperty("id");
    expect(await failure(() => label({ name: "BUG", nameKey: "bug" }))).toMatch(/unique/i);
    // Em outro projeto, o mesmo nome vale.
    expect(await label({ name: "Bug", nameKey: "bug", projectId: otherProject })).toHaveProperty("id");
  });

  it.each(["", " Bug", "Bug ", "a\nb", "a\tb", "x".repeat(61)])("recusa o nome %j", async (name) => {
    expect(await failure(() => label({ name, nameKey: `k${counter}` }))).toMatch(/check/i);
  });

  it("aceita 60 pontos de código (emoji conta 1)", async () => {
    expect(await label({ name: "🐛".repeat(60), nameKey: `emoji${counter}` })).toHaveProperty("id");
  });

  it("recusa cor fora da paleta e chave vazia", async () => {
    expect(await failure(() => label({ color: "red" }))).toMatch(/check/i);
    expect(await failure(() => label({ name: "Sem chave", nameKey: "" }))).toMatch(/check/i);
  });

  it("isolada por organização (RLS forçada)", async () => {
    const r = await owner.query("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'project_labels'");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const seen = await asTenant(prisma, ORG_2, (tx) => tx.projectLabel.findMany({ where: { projectId: a.project } }));
    expect(seen).toEqual([]);
    expect(await failure(() => asTenant(prisma, ORG_2, (tx) => tx.projectLabel.create({ data: { orgId: ORG_1, projectId: a.project, name: "Intrusa", nameKey: "intrusa", color: "gray" } })))).toMatch(/row-level security|violates/i);
    void b;
  });

  it("o papel da aplicação renomeia, troca a cor e apaga, mas não muda o projeto", async () => {
    const { id } = await label();
    await asTenant(prisma, ORG_1, (tx) => tx.projectLabel.update({ where: { orgId_id: { orgId: ORG_1, id } }, data: { name: "Renomeada", nameKey: "renomeada", color: "violet" } }));
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`update project_labels set project_id = ${otherProject}::uuid where id = ${id}::uuid`))).toMatch(/permission denied/i);
    await asTenant(prisma, ORG_1, (tx) => tx.projectLabel.delete({ where: { orgId_id: { orgId: ORG_1, id } } }));
  });

  it("some com o projeto", async () => {
    const project = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Tmp', 'TMP') returning id", [ORG_1])).rows[0]?.id as string;
    await label({ projectId: project });
    await owner.query("delete from projects where id = $1", [project]);
    expect((await owner.query("select count(*)::int as n from project_labels where project_id = $1", [project])).rows[0].n).toBe(0);
  });
});

describe("ticket_labels", () => {
  const put = (ticketId: string, labelId: string, projectId = a.project) => asTenant(prisma, ORG_1, (tx) => tx.ticketLabel.create({ data: { orgId: ORG_1, projectId, ticketId, labelId } }));

  it("liga ticket e etiqueta do mesmo projeto, uma vez", async () => {
    const { id } = await label();
    await put(a.ticket, id);
    expect(await failure(() => put(a.ticket, id))).toMatch(/unique/i);
  });

  it("recusa etiqueta de outro projeto (a chave estrangeira composta)", async () => {
    const { id } = await label({ projectId: otherProject });
    expect(await failure(() => put(a.ticket, id))).toMatch(/foreign key/i);
    // Nem fingindo o projeto do ticket: o ticket não é desse projeto.
    expect(await failure(() => put(a.ticket, id, otherProject))).toMatch(/foreign key/i);
    await put(otherTicket, id, otherProject);
  });

  it("some com a etiqueta e com o ticket", async () => {
    const { id } = await label();
    const ticket = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 4801, 'T', $3) returning id", [ORG_1, a.project, a.person])).rows[0]?.id as string;
    await put(ticket, id);
    await put(a.ticket, id);
    await owner.query("delete from tickets where id = $1", [ticket]);
    expect((await owner.query("select count(*)::int as n from ticket_labels where label_id = $1", [id])).rows[0].n).toBe(1);
    await asTenant(prisma, ORG_1, (tx) => tx.projectLabel.delete({ where: { orgId_id: { orgId: ORG_1, id } } }));
    expect((await owner.query("select count(*)::int as n from ticket_labels where label_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("RLS forçada e o papel da aplicação não atualiza linha (só põe e tira)", async () => {
    const r = await owner.query("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'ticket_labels'");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`update ticket_labels set created_at = now()`))).toMatch(/permission denied/i);
  });
});

describe("project_label_origins", () => {
  const origin = (externalId: string, labelId: string | null, projectId = a.project) =>
    asTenant(prisma, ORG_1, (tx) => tx.projectLabelOrigin.create({ data: { orgId: ORG_1, projectId, provider: "linear", externalId, labelId, appliedName: "Bug", appliedColor: "orange" }, select: { id: true } }));

  it("única por projeto, provedor e id externo (a mesma etiqueta do Linear pode estar em dois projetos)", async () => {
    const { id } = await label();
    await origin("lin-1", id);
    expect(await failure(() => origin("lin-1", null))).toMatch(/unique/i);
    await origin("lin-1", null, otherProject);
  });

  it("apagar a etiqueta zera só a etiqueta na origem: a origem fica (não renasce)", async () => {
    const { id } = await label();
    const made = await origin("lin-2", id);
    await asTenant(prisma, ORG_1, (tx) => tx.projectLabel.delete({ where: { orgId_id: { orgId: ORG_1, id } } }));
    const row = (await owner.query("select label_id, project_id, external_id from project_label_origins where id = $1", [made.id])).rows[0];
    expect(row).toEqual({ label_id: null, project_id: a.project, external_id: "lin-2" });
  });

  it("recusa etiqueta de outro projeto e removida com etiqueta", async () => {
    const { id } = await label({ projectId: otherProject });
    expect(await failure(() => origin("lin-3", id))).toMatch(/foreign key/i);
    const mine = await label();
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.projectLabelOrigin.create({ data: { orgId: ORG_1, projectId: a.project, provider: "linear", externalId: "lin-4", labelId: mine.id, appliedName: "x", appliedColor: "gray", removedHereAt: new Date() } })))).toMatch(/check/i);
  });

  it("recusa provedor desconhecido e cor aplicada fora da paleta", async () => {
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.projectLabelOrigin.create({ data: { orgId: ORG_1, projectId: a.project, provider: "jira", externalId: "j", appliedName: "x", appliedColor: "gray" } })))).toMatch(/check/i);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.projectLabelOrigin.create({ data: { orgId: ORG_1, projectId: a.project, provider: "linear", externalId: "lin-5", appliedName: "x", appliedColor: "red" } })))).toMatch(/check/i);
  });

  it("RLS forçada; a aplicação não apaga origem nem troca o id externo", async () => {
    const r = await owner.query("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'project_label_origins'");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from project_label_origins`))).toMatch(/permission denied/i);
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`update project_label_origins set external_id = 'x'`))).toMatch(/permission denied/i);
  });
});

describe("external_item_refs e a rodada", () => {
  it("aceita o tipo label", async () => {
    const { id } = await label();
    await asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.create({ data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, provider: "linear", kind: "label", externalId: "issue-1:lin-1", localId: id } }));
    expect(await failure(() => asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.create({ data: { orgId: ORG_1, projectId: a.project, ticketId: a.ticket, provider: "linear", kind: "attachment", externalId: "x" } })))).toMatch(/check/i);
  });
});
