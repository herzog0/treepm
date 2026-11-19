import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, ownerPoolWithCleanup, sessionHeader, truncateAll } from "./helpers.js";
import type { FakeDirectory } from "./helpers.js";

const pool = ownerPoolWithCleanup();
let app: INestApplication;
let directory: FakeDirectory;

beforeAll(async () => {
  ({ app, directory } = await createTestApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  directory.onCall = null;
  directory.calls.users.length = 0;
  directory.calls.organizations.length = 0;
});

/** Conexões da API com transação aberta, vistas pelo papel dono. */
async function openAppTransactions(): Promise<number> {
  const result = await pool.query<{ n: string }>(
    "select count(*)::text as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'",
  );
  return Number(result.rows[0]?.n);
}

const admin = sessionHeader({ userId: "user_1", orgId: "org_A", orgRole: "org:admin" });

describe("consulta ao diretório (Clerk) fora da transação do tenant", () => {
  it.each(["/api/me", "/api/people", "/api/teams"])(
    "%s consulta o diretório sem nenhuma transação aberta",
    async (path) => {
      const observed: number[] = [];
      directory.onCall = async () => {
        observed.push(await openAppTransactions());
      };
      const res = await request(app.getHttpServer()).get(path).set("x-test-session", admin);
      expect(res.status).toBe(200);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((open) => open === 0)).toBe(true);
    },
  );

  it("rotas de produto só consultam o diretório no primeiro acesso", async () => {
    await request(app.getHttpServer()).get("/api/people").set("x-test-session", admin);
    expect(directory.calls.users).toEqual(["user_1"]);
    await request(app.getHttpServer()).get("/api/people").set("x-test-session", admin);
    expect(directory.calls.users).toEqual(["user_1"]);
  });

  it("provisiona a pessoa antes de qualquer rota de produto, de forma idempotente", async () => {
    const first = await request(app.getHttpServer()).get("/api/people").set("x-test-session", admin);
    const second = await request(app.getHttpServer()).get("/api/people").set("x-test-session", admin);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toHaveLength(1);
    expect((await pool.query("select 1 from people")).rowCount).toBe(1);
    expect((await pool.query("select 1 from organizations")).rowCount).toBe(1);
  });
});
