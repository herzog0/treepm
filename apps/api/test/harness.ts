import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestApp, ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import type { FakeSessionVerifier } from "./helpers.js";
import { seedWorld } from "./world.js";
import type { World } from "./world.js";

export type Harness = {
  pool: pg.Pool;
  app: () => INestApplication;
  verifier: () => FakeSessionVerifier;
  world: () => World;
  call: (method: string, path: string, session: string, body?: unknown) => Promise<request.Response>;
};

/** Registra os hooks de ciclo de vida e devolve acessores para a app, o mundo semeado e o `call`. */
export function useHarness(): Harness {
  const pool = ownerPoolWithCleanup();
  let app: INestApplication;
  let verifier: FakeSessionVerifier;
  let world: World;

  beforeAll(async () => {
    ({ app, verifier } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    verifier.removed.clear();
    world = await seedWorld(pool);
  });

  return {
    pool,
    app: () => app,
    verifier: () => verifier,
    world: () => world,
    call: (method, path, session, body) => {
      const agent = request(app.getHttpServer());
      const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const req = agent[verb](path).set("x-test-session", session);
      return body === undefined ? req : req.send(body as object);
    },
  };
}
