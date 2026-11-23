import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0030 (ADR 0053): ticket_embeddings, um vetor de 512 números por ticket, com isolamento por organização.
const ORG = "org_EMB";
const OTHER = "org_EMB_B";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let otherIds: Ids;
let number = 700;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
  otherIds = await seedOrg(owner, OTHER);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const newTicket = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'T',$4) returning id", [ORG, ids.project, ++number, ids.person])).rows[0]?.id ?? "";

/** Vetor de 512 posições com um valor só em `at` (os demais são zero), em texto para o parâmetro `::vector`. */
const unit = (at: number): string => `[${Array.from({ length: 512 }, (_, i) => (i === at ? 1 : 0)).join(",")}]`;

const put = (orgId: string, projectId: string, ticket: string, vector: string, hash = "h1") =>
  asTenant(
    prisma,
    orgId,
    (tx) => tx.$executeRaw`
      insert into ticket_embeddings (org_id, project_id, ticket_id, model, dimensions, content_hash, embedding)
      values (${orgId}, ${projectId}::uuid, ${ticket}::uuid, 'voyage-4-lite', 512, ${hash}, ${vector}::vector)
      on conflict (org_id, ticket_id) do update
        set model = excluded.model, dimensions = excluded.dimensions, content_hash = excluded.content_hash, embedding = excluded.embedding, updated_at = now()`,
  );

describe("ticket_embeddings", () => {
  it("a extensão vector existe e a coluna tem 512 posições", async () => {
    expect((await owner.query("select 1 from pg_extension where extname = 'vector'")).rowCount).toBe(1);
    const ticket = await newTicket();
    await expect(owner.query("insert into ticket_embeddings (org_id, project_id, ticket_id, model, dimensions, content_hash, embedding) values ($1,$2,$3,'m',3,'h','[1,2,3]')", [ORG, ids.project, ticket])).rejects.toThrow(/dimensions/);
  });

  it("o papel da aplicação insere, substitui e consulta por distância do cosseno", async () => {
    const a = await newTicket();
    const b = await newTicket();
    const c = await newTicket();
    await put(ORG, ids.project, a, unit(0));
    await put(ORG, ids.project, b, unit(1));
    await put(ORG, ids.project, c, unit(0), "h-c");
    // Substituir o de `b` por um vetor igual ao de `a`: a linha é uma só e o resumo novo vale.
    await put(ORG, ids.project, b, unit(0), "h2");
    const rows = await asTenant(
      prisma,
      ORG,
      (tx) => tx.$queryRaw<{ ticketId: string; distance: number; contentHash: string }[]>`
        select ticket_id as "ticketId", content_hash as "contentHash", (embedding <=> ${unit(0)}::vector)::float8 as distance
        from ticket_embeddings where project_id = ${ids.project}::uuid and ticket_id = any(${[a, b, c]}::uuid[])
        order by distance, ticket_id`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => Math.abs(row.distance) < 1e-9)).toBe(true);
    expect(rows.find((row) => row.ticketId === b)?.contentHash).toBe("h2");
    const far = await asTenant(prisma, ORG, (tx) => tx.$queryRaw<{ distance: number }[]>`select (embedding <=> ${unit(5)}::vector)::float8 as distance from ticket_embeddings where ticket_id = ${a}::uuid`);
    expect(far[0]?.distance).toBeCloseTo(1, 6);
  });

  it("apagar o ticket apaga o vetor (cascata)", async () => {
    const ticket = await newTicket();
    await put(ORG, ids.project, ticket, unit(2));
    expect((await owner.query("select 1 from ticket_embeddings where ticket_id = $1", [ticket])).rowCount).toBe(1);
    await owner.query("delete from tickets where id = $1", [ticket]);
    expect((await owner.query("select 1 from ticket_embeddings where ticket_id = $1", [ticket])).rowCount).toBe(0);
  });

  it("isolamento por organização: outra organização não lê, não grava e não apaga", async () => {
    const ticket = await newTicket();
    await put(ORG, ids.project, ticket, unit(3));
    const seen = await asTenant(prisma, OTHER, (tx) => tx.$queryRaw<{ n: bigint }[]>`select count(*) as n from ticket_embeddings where ticket_id = ${ticket}::uuid`);
    expect(Number(seen[0]?.n)).toBe(0);
    await expect(put(OTHER, ids.project, ticket, unit(3))).rejects.toThrow();
    await expect(asTenant(prisma, OTHER, (tx) => tx.$executeRaw`insert into ticket_embeddings (org_id, project_id, ticket_id, model, dimensions, content_hash, embedding) values (${ORG}, ${ids.project}::uuid, ${ticket}::uuid, 'm', 512, 'h', ${unit(3)}::vector)`)).rejects.toThrow();
    const removed = await asTenant(prisma, OTHER, (tx) => tx.$executeRaw`delete from ticket_embeddings where ticket_id = ${ticket}::uuid`);
    expect(removed).toBe(0);
    expect(otherIds.project).not.toBe(ids.project);
    expect((await owner.query("select 1 from ticket_embeddings where ticket_id = $1", [ticket])).rowCount).toBe(1);
  });

  it("o ticket tem de ser do mesmo projeto da linha", async () => {
    const ticket = await newTicket();
    await expect(put(ORG, otherIds.project, ticket, unit(4))).rejects.toThrow();
  });
});
