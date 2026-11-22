import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestApp, ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import type { FakeSessionVerifier } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { FakeAffinityJudge, FakeBranchJudge, FakeBranchSummarizer, FakeConversationProvider, FakeDescriptionWriter, FakeGroupNamer, FakeProjectAnswerer } from "./assistant-fakes.js";
import type { PlacementTimeouts } from "../src/assistant/ports.js";
import type { FakeRepositoryProvider } from "./github-fakes.js";
import { seedWorld } from "./world.js";
import type { World } from "./world.js";

export type Harness = {
  pool: pg.Pool;
  app: () => INestApplication;
  verifier: () => FakeSessionVerifier;
  world: () => World;
  conversation: () => FakeConversationProvider;
  judge: () => FakeBranchJudge;
  summarizer: () => FakeBranchSummarizer;
  affinity: () => FakeAffinityJudge;
  namer: () => FakeGroupNamer;
  writer: () => FakeDescriptionWriter;
  answerer: () => FakeProjectAnswerer;
  github: () => FakeRepositoryProvider;
  call: (method: string, path: string, session: string, body?: unknown) => Promise<request.Response>;
};

/** Registra os hooks de ciclo de vida e devolve acessores para a app, o mundo semeado e o `call`. */
export function useHarness(config?: AppConfig, options: { timeouts?: PlacementTimeouts } = {}): Harness {
  const pool = ownerPoolWithCleanup();
  let app: INestApplication;
  let verifier: FakeSessionVerifier;
  let world: World;
  let conversation: FakeConversationProvider;
  let judge: FakeBranchJudge;
  let summarizer: FakeBranchSummarizer;
  let affinity: FakeAffinityJudge;
  let namer: FakeGroupNamer;
  let writer: FakeDescriptionWriter;
  let answerer: FakeProjectAnswerer;
  let github: FakeRepositoryProvider;

  beforeAll(async () => {
    ({ app, verifier, conversation, judge, summarizer, affinity, namer, writer, answerer, github } = await createTestApp([], config, options.timeouts ? { timeouts: options.timeouts } : {}));
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
    judge.calls.length = 0;
    judge.onCall = null;
    judge.verdict = null;
    judge.fail = false;
    summarizer.calls.length = 0;
    summarizer.onCall = null;
    summarizer.delayMs = 0;
    summarizer.fail = false;
    summarizer.maxConcurrent = 0;
    affinity.calls.length = 0;
    affinity.onCall = null;
    affinity.verdict = null;
    affinity.fail = false;
    affinity.hang = false;
    writer.calls.length = 0;
    writer.onCall = null;
    writer.reply = null;
    writer.fail = false;
    answerer.calls.length = 0;
    answerer.onCall = null;
    answerer.script = null;
    answerer.delegate = null;
    answerer.fail = false;
    namer.calls.length = 0;
    namer.onCall = null;
    namer.reply = null;
    namer.fail = false;
    namer.hang = false;
    github.reset();
    world = await seedWorld(pool);
  });

  return {
    pool,
    app: () => app,
    verifier: () => verifier,
    world: () => world,
    conversation: () => conversation,
    judge: () => judge,
    summarizer: () => summarizer,
    affinity: () => affinity,
    namer: () => namer,
    writer: () => writer,
    answerer: () => answerer,
    github: () => github,
    call: (method, path, session, body) => {
      const agent = request(app.getHttpServer());
      const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const req = agent[verb](path).set("x-test-session", session);
      return body === undefined ? req : req.send(body as object);
    },
  };
}
