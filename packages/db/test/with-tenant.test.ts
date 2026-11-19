import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, withTenant } from "../src/index.js";
import { APP_URL } from "./env.js";
import { ORG_A, ORG_B, ownerPool, seedOrg } from "./helpers.js";

// Uma única conexão física: qualquer vazamento de contexto entre transações
// consecutivas apareceria aqui.
let single: PrismaClient;
let pooled: PrismaClient;

type Probe = { pid: number; org: string | null; n: number };
const PROBE =
  "select pg_backend_pid()::int as pid, nullif(current_setting('app.org_id', true), '') as org, (select count(*)::int from projects) as n";

beforeAll(async () => {
  const owner = ownerPool();
  try {
    await owner.query("truncate organizations cascade");
    await seedOrg(owner, ORG_A);
    await seedOrg(owner, ORG_B);
  } finally {
    await owner.end();
  }
  single = new PrismaClient({
    adapter: new PrismaPg({ connectionString: APP_URL, max: 1 }),
  });
  pooled = new PrismaClient({
    adapter: new PrismaPg({ connectionString: APP_URL, max: 3 }),
  });
});

afterAll(async () => {
  await single.$disconnect();
  await pooled.$disconnect();
});

describe("withTenant", () => {
  it("não vaza contexto entre transações consecutivas na mesma conexão", async () => {
    const a = await withTenant(single, { orgId: ORG_A, userId: "ua" }, (tx) =>
      tx.$queryRawUnsafe<Probe[]>(PROBE),
    );
    const outside = await single.$queryRawUnsafe<Probe[]>(PROBE);
    const b = await withTenant(single, { orgId: ORG_B, userId: "ub" }, (tx) =>
      tx.$queryRawUnsafe<Probe[]>(PROBE),
    );
    const outsideAgain = await single.$queryRawUnsafe<Probe[]>(PROBE);

    expect(a[0]).toMatchObject({ org: ORG_A, n: 1 });
    expect(b[0]).toMatchObject({ org: ORG_B, n: 1 });
    expect(outside[0]).toMatchObject({ org: null, n: 0 });
    expect(outsideAgain[0]).toMatchObject({ org: null, n: 0 });
    // Prova de que foi a mesma conexão física.
    const pids = new Set([a[0]?.pid, outside[0]?.pid, b[0]?.pid, outsideAgain[0]?.pid]);
    expect(pids.size).toBe(1);
  });

  it("aplica app.user_id e limpa o contexto após erro e rollback", async () => {
    await expect(
      withTenant(single, { orgId: ORG_A, userId: "ua" }, async (tx) => {
        const r = await tx.$queryRawUnsafe<{ u: string }[]>(
          "select current_setting('app.user_id', true) as u",
        );
        expect(r[0]?.u).toBe("ua");
        throw new Error("falha proposital");
      }),
    ).rejects.toThrow("falha proposital");
    const after = await single.$queryRawUnsafe<{ o: string | null; u: string | null }[]>(
      "select nullif(current_setting('app.org_id', true), '') as o, nullif(current_setting('app.user_id', true), '') as u",
    );
    expect(after[0]).toEqual({ o: null, u: null });
  });

  it("trata valores com aspas como dados, nunca como SQL", async () => {
    const hostile = "x'); drop table projects; --";
    const r = await withTenant(single, { orgId: hostile, userId: "u" }, (tx) =>
      tx.$queryRawUnsafe<Probe[]>(PROBE),
    );
    expect(r[0]).toMatchObject({ org: hostile, n: 0 });
    const still = await withTenant(single, { orgId: ORG_A, userId: "u" }, (tx) =>
      tx.$queryRawUnsafe<Probe[]>(PROBE),
    );
    expect(still[0]?.n).toBe(1);
  });

  it("transações concorrentes em um pool pequeno só veem a própria organização", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const orgId = i % 2 === 0 ? ORG_A : ORG_B;
        return withTenant(pooled, { orgId, userId: `u${i}` }, async (tx) => {
          const rows = await tx.project.findMany({ select: { orgId: true } });
          return { orgId, seen: new Set(rows.map((p) => p.orgId)) };
        });
      }),
    );
    for (const { orgId, seen } of results) {
      expect(seen).toEqual(new Set([orgId]));
    }
  });

  it("recusa orgId ou userId vazios antes de tocar no banco", async () => {
    await expect(withTenant(single, { orgId: "", userId: "u" }, async () => 1)).rejects.toThrow(
      /orgId/,
    );
    await expect(withTenant(single, { orgId: "o", userId: "" }, async () => 1)).rejects.toThrow(
      /userId/,
    );
  });
});
