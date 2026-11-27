import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0045 (ADR 0061, fatia 3; TREEPM-478): relação "relacionado", origem de relação e a fase `relations`.
const ORG_1 = "org_R45a";
const ORG_2 = "org_R45b";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;
let b: Ids;
/** Dois tickets a mais no projeto da organização 1, em ordem de id (`low` < `high`). */
let low: string;
let high: string;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
  b = await seedOrg(owner, ORG_2);
  const made: string[] = [];
  for (const number of [451, 452]) {
    made.push((await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'R', $4) returning id", [ORG_1, a.project, number, a.person])).rows[0]?.id as string);
  }
  [low, high] = made.sort() as [string, string];
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

const relation = (from: string, to: string, kind: string) =>
  asTenant(prisma, ORG_1, (tx) => tx.ticketRelation.create({ data: { orgId: ORG_1, projectId: a.project, fromTicketId: from, toTicketId: to, kind, need: kind === "depends_on" ? "start" : null }, select: { id: true } }));

describe("ticket_relations: o tipo related", () => {
  it("é aceito, uma linha por par, com o menor id primeiro", async () => {
    expect(await relation(low, high, "related")).toHaveProperty("id");
    // A mesma relação na ordem inversa é recusada: um par tem uma linha só.
    expect(await failure(() => relation(high, low, "related"))).toMatch(/check|related/i);
    // E repetida na ordem certa, também (o índice único por par e tipo).
    expect(await failure(() => relation(low, high, "related"))).toMatch(/unique/i);
  });

  it("não muda as regras de depends_on: qualquer sentido vale", async () => {
    expect(await relation(high, low, "depends_on")).toHaveProperty("id");
    expect(await relation(low, high, "depends_on")).toHaveProperty("id");
  });

  it("tipo desconhecido continua recusado", async () => {
    expect(await failure(() => relation(low, high, "duplicate"))).toMatch(/check/i);
  });
});

const ref = (orgId: string, ids: Ids, data: Record<string, unknown> = {}) =>
  asTenant(prisma, orgId, (tx) =>
    tx.externalItemRef.create({ data: { orgId, projectId: ids.project, ticketId: ids.ticket, provider: "linear", kind: "relation", externalId: "rel-1", ...data } as never, select: { id: true } }),
  );

describe("external_item_refs: o tipo relation", () => {
  it("é aceito, com o que a sincronização grava em applied: o tipo do TreePM, o id da relação e das issues e os tickets das pontas", async () => {
    // A mesma forma de `linearRelationApplied` (domínio), que a importação usa; o teste de ponta a ponta da API confere a gravação real.
    const applied = { type: "depends_on", relationId: "r-1", issueId: "i-1", relatedIssueId: "i-2", issueTicketId: low, relatedIssueTicketId: high };
    await ref(ORG_1, a, { externalId: "rel-a", applied });
    const row = (await owner.query("select kind, applied from external_item_refs where external_id = 'rel-a'")).rows[0];
    expect(row).toEqual({ kind: "relation", applied });
  });

  it("índices: as outras formas da mesma relação (pela coluna `relation_id`) e a origem pela linha local (página do ticket)", async () => {
    const rows = (await owner.query<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where tablename = 'external_item_refs' order by indexname")).rows;
    const def = (name: string): string => rows.find((row) => row.indexname === name)?.indexdef ?? "";
    expect(def("external_item_refs_relation_id_idx")).toMatch(/\(org_id, relation_id\) WHERE \(kind = 'relation'::text\)/);
    expect(def("external_item_refs_local_idx")).toMatch(/\(org_id, local_id\)/);
    // Nenhum índice de expressão sobre `applied`: sob RLS o papel da aplicação não o usaria (`->>` não é leakproof).
    expect(rows.filter((row) => row.indexdef.includes("applied"))).toEqual([]);
  });

  it("relation_id é gerada de applied->>'relationId' (o código nunca a grava) e acompanha a mudança de applied pelo papel da aplicação", async () => {
    await ref(ORG_1, a, { externalId: "rel-g", applied: { relationId: "r-gen", type: "related" } });
    const read = async (): Promise<unknown> => (await owner.query("select relation_id from external_item_refs where external_id = 'rel-g'")).rows[0]?.relation_id;
    expect(await read()).toBe("r-gen");
    // O UPDATE de `applied` pelo `treepm_app` (GRANT só nas colunas de sempre) recalcula a coluna.
    await asTenant(prisma, ORG_1, (tx) => tx.externalItemRef.updateMany({ where: { externalId: "rel-g" }, data: { applied: { relationId: "r-gen-2" } } }));
    expect(await read()).toBe("r-gen-2");
    // Gravar a coluna é recusado.
    expect(await failure(() => owner.query("update external_item_refs set relation_id = 'x' where external_id = 'rel-g'"))).toMatch(/can only be updated to DEFAULT/);
  });

  it("a consulta das outras formas usa o índice de relation_id COMO treepm_app (com RLS)", async () => {
    // Volume: origens de relação e de comentário na organização, para o plano ter o que escolher.
    await owner.query(
      `insert into external_item_refs (org_id, project_id, ticket_id, provider, kind, external_id, local_id, applied)
       select $1, $2, $3, 'linear', case when g % 2 = 0 then 'relation' else 'comment' end, 'vol-' || g, app_uuid_v7(), jsonb_build_object('relationId', 'vol-' || g, 'type', 'depends_on')
       from generate_series(1, 20000) g`,
      [ORG_1, a.project, a.ticket],
    );
    await owner.query("analyze external_item_refs");
    // A mesma forma da consulta da importação (`linear-import.service.ts`): `kind = 'relation'` literal, ids num array.
    const plan = await asTenant(prisma, ORG_1, async (tx) => {
      await tx.$executeRawUnsafe("set local enable_seqscan = off");
      const rows = await tx.$queryRaw<{ "QUERY PLAN": string }[]>`explain select id from external_item_refs
        where org_id = ${ORG_1} and provider = 'linear' and kind = 'relation' and relation_id = any(${["vol-2", "vol-4", "vol-700"]}::text[])`;
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/Index Scan (using|on) external_item_refs_relation_id_idx/);
  });

  it("comment continua aceito e outro tipo, não", async () => {
    expect(await ref(ORG_1, a, { externalId: "c-ok", kind: "comment" })).toHaveProperty("id");
    expect(await failure(() => ref(ORG_1, a, { externalId: "l-1", kind: "attachment" }))).toMatch(/check/i);
  });

  it("único por organização (outra organização pode ter o mesmo id)", async () => {
    await ref(ORG_1, a, { externalId: "rel-u" });
    expect(await failure(() => ref(ORG_1, a, { externalId: "rel-u" }))).toMatch(/unique/i);
    expect(await ref(ORG_2, b, { externalId: "rel-u" })).toHaveProperty("id");
  });
});

describe("external_import_runs: a fase relations", () => {
  it("é aceita", async () => {
    const run = (await owner.query<{ id: string }>("insert into external_import_runs (org_id, project_id, provider, started_by_person_id, mode, phase, counts) values ($1, $2, 'linear', $3, 'first', 'relations', '{}') returning id", [ORG_1, a.project, a.person])).rows[0];
    expect(run?.id).toBeTruthy();
    await owner.query("update external_import_runs set phase = 'failed' where id = $1", [run?.id]);
  });
});
