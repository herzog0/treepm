import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_PROVIDER } from "../src/assistant/ports.js";
import { ClaudeConversationProvider } from "../src/assistant/claude-conversation-provider.js";
import { TEST_CONFIG, createTestApp, ownerPoolWithCleanup, sessionHeader, truncateAll } from "./helpers.js";

const pool = ownerPoolWithCleanup();
const session = sessionHeader({ userId: "u_1", orgId: "org_A", orgRole: "org:member" });

afterAll(() => pool.end());
beforeEach(() => truncateAll(pool));

describe("GET /api/me — assistant.enabled", () => {
  let on: INestApplication;
  beforeAll(async () => {
    ({ app: on } = await createTestApp([], { ...TEST_CONFIG, ANTHROPIC_API_KEY: "a", TYPESAFE_API_KEY: "t" }));
  });
  afterAll(() => on.close());

  it("com as duas chaves, informa enabled: true", async () => {
    const res = await request(on.getHttpServer()).get("/api/me").set("x-test-session", session);
    expect(res.status).toBe(200);
    expect(res.body.assistant).toEqual({ enabled: true });
  });
});

describe("rotas da IA sem as chaves", () => {
  let off: INestApplication;
  beforeAll(async () => {
    ({ app: off } = await createTestApp([], TEST_CONFIG));
  });
  afterAll(() => off.close());
  const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

  it.each([
    ["POST", `/api/projects/${id}/ticket-conversations`],
    ["POST", `/api/ticket-conversations/${id}/messages`],
  ])("%s %s responde 503 assistant_not_configured", async (method, path) => {
    const agent = request(off.getHttpServer());
    const res = await (method === "POST" ? agent.post(path) : agent.get(path)).set("x-test-session", session).send({ message: "oi" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "assistant_not_configured", message: expect.any(String) } });
  });
});

describe("ligação do provedor real", () => {
  it("com as duas chaves, a conversa usa o adaptador do Claude; sem elas, não há provedor", async () => {
    const { app: on } = await createTestApp([], { ...TEST_CONFIG, ANTHROPIC_API_KEY: "a", TYPESAFE_API_KEY: "t" }, { realAssistant: true });
    const { app: off } = await createTestApp([], TEST_CONFIG, { realAssistant: true });
    expect(on.get(CONVERSATION_PROVIDER)).toBeInstanceOf(ClaudeConversationProvider);
    expect(off.get(CONVERSATION_PROVIDER)).toBeNull();
    await on.close();
    await off.close();
  });
});

describe("GET /api/me — sem chaves", () => {
  let off: INestApplication;
  beforeAll(async () => {
    ({ app: off } = await createTestApp([], { ...TEST_CONFIG, ANTHROPIC_API_KEY: "a" }));
  });
  afterAll(() => off.close());

  it("com só uma das chaves, a API sobe e informa enabled: false", async () => {
    const res = await request(off.getHttpServer()).get("/api/me").set("x-test-session", session);
    expect(res.status).toBe(200);
    expect(res.body.assistant).toEqual({ enabled: false });
  });
});
