import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

/**
 * Migration 0023 (ADR 0045): segunda barreira no banco. Um `parent_id` que fecha ciclo é recusado, pelo papel da aplicação, com RLS.
 * A primeira barreira é a trava de estrutura da API; este gatilho cobre quem escreve fora dela (script, SQL manual, defeito).
 */
const ORG = "org_CY";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 1000; // o seedOrg já usa números baixos

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function make(parentId: string | null = null): Promise<string> {
  const rows = await owner.query(
    "insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id) values ($1,$2,$3,'T',$4,$5) returning id",
    [ORG, ids.project, ++counter, parentId, ids.person],
  );
  return rows.rows[0].id as string;
}
const setParent = (id: string, parentId: string | null) =>
  asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set parent_id = ${parentId}::uuid where id = ${id}::uuid`);

describe("gatilho de ciclo no pai do ticket", () => {
  it("recusa o ticket como pai de si mesmo", async () => {
    const a = await make();
    await expect(setParent(a, a)).rejects.toThrow(/ticket_parent_cycle/);
  });

  it("recusa A sob B quando B já está sob A, e um descendente distante", async () => {
    const a = await make();
    const b = await make(a);
    const c = await make(b);
    await expect(setParent(a, b)).rejects.toThrow(/ticket_parent_cycle/);
    await expect(setParent(a, c)).rejects.toThrow(/ticket_parent_cycle/);
    const parent = (await owner.query("select parent_id from tickets where id = $1", [a])).rows[0].parent_id;
    expect(parent).toBeNull();
  });

  it("aceita mover para fora da subárvore, para um irmão e para a raiz", async () => {
    const a = await make();
    const b = await make(a);
    const c = await make(a);
    await setParent(b, c);
    await setParent(b, null);
    await setParent(c, b);
    expect((await owner.query("select parent_id from tickets where id = $1", [c])).rows[0].parent_id).toBe(b);
  });

  it("não atrapalha a inserção em lote de pai e filhos", async () => {
    const root = await make();
    const child = await make(root);
    await make(child);
    expect((await owner.query("select count(*)::int as n from tickets where org_id = $1", [ORG])).rows[0].n).toBeGreaterThan(3);
  });

  it("o custo acompanha a profundidade: cadeia funda recusa o ciclo e aceita o movimento válido", async () => {
    let tip = await make();
    const top = tip;
    for (let i = 0; i < 1500; i++) tip = await make(tip);
    await expect(setParent(top, tip)).rejects.toThrow(/ticket_parent_cycle/);
    const other = await make();
    await setParent(tip, other);
  }, 60_000);
});
