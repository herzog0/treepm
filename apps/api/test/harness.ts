import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestApp, ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import type { FakeSessionVerifier } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { FakeConversationProvider } from "./assistant-fakes.js";
import { seedWorld } from "./world.js";
import type { World } from "./world.js";

export type Harness = {
  pool: pg.Pool;
  app: () => INestApplication;
  verifier: () => FakeSessionVerifier;
  world: () => World;
  conversation: () => FakeConversationProvider;
  call: (method: string, path: string, session: string, body?: unknown) => Promise<request.Response>;
};

/** Registra os hooks de ciclo de vida e devolve acessores para a app, o mundo semeado e o `call`. */
export function useHarness(config?: AppConfig): Harness {
  const pool = ownerPoolWithCleanup();
  let app: INestApplication;
  let verifier: FakeSessionVerifier;
  let world: World;
  let conversation: FakeConversationProvider;

  beforeAll(async () => {
    ({ app, verifier, conversation } = await createTestApp([], config));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    verifier.removed.clear();
    conversation.calls.length = 0;
    conversation.onCall = null;
    conversation.reply = null;
    conversation.fail = false;
    world = await seedWorld(pool);
  });

  return {
    pool,
    app: () => app,
    verifier: () => verifier,
    world: () => world,
    conversation: () => conversation,
    call: (method, path, session, body) => {
      const agent = request(app.getHttpServer());
      const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const req = agent[verb](path).set("x-test-session", session);
      return body === undefined ? req : req.send(body as object);
    },
  };
}
