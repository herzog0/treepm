import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import type { AccessTokenClock } from "../src/access-tokens/clock.js";
import type { AppConfig } from "../src/config.js";
import { createTestApp, ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import type { FakeDirectory } from "./helpers.js";
import { ORG, as, seedWorld } from "./world.js";
import type { Who, World } from "./world.js";

/** Relógio de teste: parte do instante real (as datas gravadas no banco são reais) e só anda quando mandam. */
export class FakeClock implements AccessTokenClock {
  private current = Date.now();
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  reset(): void {
    this.current = Date.now();
  }
}

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export type TokenHarness = {
  pool: pg.Pool;
  app: () => INestApplication;
  directory: () => FakeDirectory;
  clock: FakeClock;
  world: () => World;
  call: (method: string, path: string, session: string, body?: unknown) => Promise<request.Response>;
  /** Liga a chave da organização direto no banco. */
  enableMcp: (orgId?: string, enabled?: boolean) => Promise<void>;
  /** Cria um token pela API, como `who`, e devolve a resposta inteira. */
  create: (who: Who, projectId: string, body?: Record<string, unknown>) => Promise<request.Response>;
};

export function useTokenHarness(config?: AppConfig): TokenHarness {
  const pool = ownerPoolWithCleanup();
  const clock = new FakeClock();
  let app: INestApplication;
  let directory: FakeDirectory;
  let world: World;

  beforeAll(async () => {
    ({ app, directory } = await createTestApp([], config, { clock }));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    clock.reset();
    directory.memberships.clear();
    directory.onCall = null;
    directory.calls.users.length = 0;
    directory.calls.organizations.length = 0;
    directory.calls.memberships.length = 0;
    app.get(AccessTokenService).resetMemory();
    world = await seedWorld(pool);
  });

  const call: TokenHarness["call"] = (method, path, session, body) => {
    const agent = request(app.getHttpServer());
    const verb = method.toLowerCase() as "get" | "post" | "patch" | "delete";
    const req = agent[verb](path).set("x-test-session", session);
    return body === undefined ? req : req.send(body as object);
  };

  return {
    pool,
    app: () => app,
    directory: () => directory,
    clock,
    world: () => world,
    call,
    enableMcp: async (orgId = ORG, enabled = true) => {
      await pool.query("update organizations set mcp_enabled = $2 where org_id = $1", [orgId, enabled]);
    },
    create: (who, projectId, body = {}) =>
      call("POST", "/api/access-tokens", as(who), { projectId, name: "Meu token", expiresInDays: 90, ...body }),
  };
}
