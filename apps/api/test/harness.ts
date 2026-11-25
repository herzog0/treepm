import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestApp, ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import type { FakeSessionVerifier } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { FakeAffinityJudge, FakeBranchJudge, FakeBranchSummarizer, FakeChatProvider, FakeConversationProvider, FakeDescriptionWriter, FakeGroupNamer, FakeRelatedJudge, FakeTicketElaborator } from "./assistant-fakes.js";
import type { FakeEmbeddingProvider } from "../scripts/placement-rebuild/fakes.js";
import type { PlacementTimeouts } from "../src/assistant/ports.js";
import type { AccessTokenClock } from "../src/access-tokens/clock.js";
import type { FakeRepositoryProvider } from "./github-fakes.js";
import type { LinearFetchSwitch } from "./linear-fake-fetch.js";
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
  related: () => FakeRelatedJudge;
  namer: () => FakeGroupNamer;
  writer: () => FakeDescriptionWriter;
  chat: () => FakeChatProvider;
  elaborator: () => FakeTicketElaborator;
  embedder: () => FakeEmbeddingProvider;
  github: () => FakeRepositoryProvider;
  linear: () => LinearFetchSwitch;
  call: (method: string, path: string, session: string, body?: unknown, headers?: Record<string, string>) => Promise<request.Response>;
};

/** Registra os hooks de ciclo de vida e devolve acessores para a app, o mundo semeado e o `call`. */
export function useHarness(config?: AppConfig, options: { timeouts?: PlacementTimeouts; consent?: boolean; clock?: AccessTokenClock } = {}): Harness {
  const pool = ownerPoolWithCleanup();
  let app: INestApplication;
  let verifier: FakeSessionVerifier;
  let world: World;
  let conversation: FakeConversationProvider;
  let judge: FakeBranchJudge;
  let summarizer: FakeBranchSummarizer;
  let affinity: FakeAffinityJudge;
  let related: FakeRelatedJudge;
  let namer: FakeGroupNamer;
  let writer: FakeDescriptionWriter;
  let chat: FakeChatProvider;
  let elaborator: FakeTicketElaborator;
  let embedder: FakeEmbeddingProvider;
  let github: FakeRepositoryProvider;
  let linear: LinearFetchSwitch;

  beforeAll(async () => {
    ({ app, verifier, conversation, judge, summarizer, affinity, related, namer, writer, chat, elaborator, embedder, github, linear } = await createTestApp([], config, { ...(options.timeouts ? { timeouts: options.timeouts } : {}), ...(options.clock ? { clock: options.clock } : {}) }));
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
    related.calls.length = 0;
    related.onCall = null;
    related.verdict = null;
    related.fail = false;
    related.hang = false;
    related.judgeHook = null;
    writer.calls.length = 0;
    writer.onCall = null;
    writer.reply = null;
    writer.fail = false;
    chat.calls.length = 0;
    chat.tools.length = 0;
    chat.delegate = null;
    chat.onCall = null;
    chat.reply_ = null;
    chat.draft_ = null;
    chat.title_ = null;
    chat.fail = false;
    elaborator.calls.length = 0;
    elaborator.onCall = null;
    elaborator.reply = null;
    elaborator.fail = false;
    elaborator.hang = false;
    elaborator.matchCalls.length = 0;
    elaborator.matchReply = null;
    elaborator.matchFail = false;
    elaborator.matchHang = false;
    embedder.calls.length = 0;
    embedder.fail = null;
    embedder.failCall = 0;
    embedder.delayMs = 0;
    embedder.concepts = {};
    namer.calls.length = 0;
    namer.onCall = null;
    namer.reply = null;
    namer.fail = false;
    namer.hang = false;
    github.reset();
    linear.reset();
    world = await seedWorld(pool, options.consent === false ? { consent: false } : {});
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
    related: () => related,
    namer: () => namer,
    writer: () => writer,
    chat: () => chat,
    elaborator: () => elaborator,
    embedder: () => embedder,
    github: () => github,
    linear: () => linear,
    call: (method, path, session, body, headers = {}) => {
      const agent = request(app.getHttpServer());
      const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      let req = agent[verb](path).set("x-test-session", session);
      for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
      return body === undefined ? req : req.send(body as object);
    },
  };
}
