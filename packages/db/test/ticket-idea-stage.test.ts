import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG = "org_IDEA";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 500;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function insert(stage: string | null, status = "todo"): Promise<string> {
  const number = ++counter;
  return asTenant(prisma, ORG, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into tickets (org_id, project_id, number, title, status, idea_stage, created_by_person_id)
      values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${status}, ${stage}, ${ids.person}::uuid)
      returning id`;
    return rows[0]?.id ?? "";
  });
}

describe("tickets.idea_stage (migration 0018)", () => {
  it("a coluna é opcional: ticket comum fica sem estágio", async () => {
    const id = await insert(null);
    const r = await owner.query("select idea_stage from tickets where id = $1", [id]);
    expect(r.rows[0].idea_stage).toBeNull();
  });

  it.each(["new", "refining", "ready", "discarded"])("aceita o estágio %s", async (stage) => {
    const id = await insert(stage);
    const r = await owner.query("select idea_stage from tickets where id = $1", [id]);
    expect(r.rows[0].idea_stage).toBe(stage);
  });

  it("recusa um estágio fora das quatro opções (check)", async () => {
    await expect(insert("accepted")).rejects.toThrow(/tickets_idea_stage_check/);
    await expect(insert("")).rejects.toThrow(/tickets_idea_stage_check/);
  });

  it.each(["in_progress", "in_review", "done", "cancelled"])("ticket com estágio não pode estar em %s", async (status) => {
    await expect(insert("new", status)).rejects.toThrow(/tickets_idea_stage_todo_check/);
  });

  it("mudar a situação de uma raiz de ideia pelo papel da aplicação é recusado; sem estágio, passa", async () => {
    const root = await insert("refining");
    await expect(
      asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update tickets set status = 'done' where org_id = $1 and id = $2::uuid", ORG, root)),
    ).rejects.toThrow(/tickets_idea_stage_todo_check/);
    await asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update tickets set idea_stage = null where org_id = $1 and id = $2::uuid", ORG, root));
    await asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update tickets set status = 'done' where org_id = $1 and id = $2::uuid", ORG, root));
    const r = await owner.query("select status, idea_stage from tickets where id = $1", [root]);
    expect(r.rows[0]).toEqual({ status: "done", idea_stage: null });
  });

  it("o papel da aplicação consegue mudar o estágio (concessão da tabela)", async () => {
    const id = await insert("new");
    await asTenant(prisma, ORG, (tx) => tx.$executeRawUnsafe("update tickets set idea_stage = 'ready' where org_id = $1 and id = $2::uuid", ORG, id));
    const r = await owner.query("select idea_stage from tickets where id = $1", [id]);
    expect(r.rows[0].idea_stage).toBe("ready");
  });

  it("há um índice parcial para listar as ideias do projeto", async () => {
    const r = await owner.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'tickets' and indexname = 'tickets_ideas_idx'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.indexdef).toMatch(/idea_stage IS NOT NULL/);
  });
});
