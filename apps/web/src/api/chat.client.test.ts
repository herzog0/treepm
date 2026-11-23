import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";
import { describeApiError } from "./errorText.js";
import i18n from "../i18n/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ana = { id: ID, displayName: "Ana", avatarUrl: null };
const message = (extra: Record<string, unknown> = {}) => ({ id: "m1", cursor: "c1", unread: false, authorKind: "person", author: ana, body: "Oi", createdAt: "2026-11-23T10:00:00.000Z", model: null, threadId: null, ...extra });
const thread = { id: "m9", ticketId: OTHER, root: message({ id: "m9", cursor: "c9", threadId: "m9" }), replyCount: 2, lastMessageAt: "2026-11-23T10:05:00.000Z", unread: 1, startedByMe: false, participants: [ana] };
const page = { items: [message()], nextBefore: null };
const ticket = { id: OTHER, key: "ALFA-1", title: "Login", projectId: ID, archived: false };

function setup(body: unknown = {}, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })));
  const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
  return { client, fetchImpl };
}
const lastCall = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => {
  const [path, init] = fetchImpl.mock.calls.at(-1)!;
  return { path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

describe("chat calls", () => {
  it("lists my chats", async () => {
    const item = { ticketId: OTHER, ticketKey: "ALFA-1", title: "Login", projectId: ID, chatId: null, assignedToMe: true, lastActivityAt: "2026-11-23T10:00:00.000Z", unread: 0 };
    const { client, fetchImpl } = setup({ items: [item] });
    const result = await client.listChats();
    expect(lastCall(fetchImpl)).toEqual({ path: "/api/chats", method: "GET", body: undefined });
    expect(result).toEqual({ ok: true, data: { items: [item] } });
  });

  it("loads the chat of a ticket with limit and the opaque cursor", async () => {
    const body = { ticket, chatId: "ch1", assignedToMe: true, lastRead: "c1", unread: 2, messages: page, threads: [thread] };
    const { client, fetchImpl } = setup(body);
    const result = await client.getTicketChat(OTHER, { limit: 30, before: "a b/c" });
    expect(lastCall(fetchImpl).path).toBe(`/api/tickets/${OTHER}/chat?limit=30&before=a+b%2Fc`);
    expect(result).toEqual({ ok: true, data: body });
  });

  it("loads a thread", async () => {
    const body = { ticket, thread, replies: page };
    const { client, fetchImpl } = setup(body);
    const result = await client.getChatThread("m9", { limit: 20 });
    expect(lastCall(fetchImpl).path).toBe("/api/chat-threads/m9?limit=20");
    expect(result).toEqual({ ok: true, data: body });
  });

  it("sends to the assistant (no mentions) and to a thread (with mentions)", async () => {
    const assistant = { kind: "assistant", message: message(), reply: message({ id: "m2", cursor: "c2", authorKind: "assistant", author: null, model: "claude-opus-5-5" }) };
    const first = setup(assistant, 201);
    expect(await first.client.sendChatMessage(OTHER, { body: "Oi" })).toEqual({ ok: true, data: assistant });
    expect(lastCall(first.fetchImpl)).toEqual({ path: `/api/tickets/${OTHER}/chat/messages`, method: "POST", body: { body: "Oi" } });
    const opened = { kind: "thread", thread };
    const second = setup(opened, 201);
    expect(await second.client.sendChatMessage(OTHER, { body: "Oi", mentions: [ID] })).toEqual({ ok: true, data: opened });
    expect(lastCall(second.fetchImpl).body).toEqual({ body: "Oi", mentions: [ID] });
  });

  it("replies in a thread, marks as read and clears", async () => {
    const reply = { message: message(), thread };
    const replied = setup(reply, 201);
    expect(await replied.client.replyChatThread("m9", { body: "Ok" })).toEqual({ ok: true, data: reply });
    expect(lastCall(replied.fetchImpl)).toEqual({ path: "/api/chat-threads/m9/messages", method: "POST", body: { body: "Ok" } });
    const read = setup({ lastRead: "c3", unread: 0 });
    expect(await read.client.markChatRead(OTHER, { upTo: "c3" })).toEqual({ ok: true, data: { lastRead: "c3", unread: 0 } });
    expect(lastCall(read.fetchImpl)).toEqual({ path: `/api/tickets/${OTHER}/chat/read`, method: "POST", body: { upTo: "c3" } });
    const all = setup({ lastRead: null, unread: 0 });
    await all.client.markChatRead(OTHER);
    expect(lastCall(all.fetchImpl).body).toEqual({});
    const cleared = setup(undefined, 204);
    expect(await cleared.client.clearChat(OTHER)).toEqual({ ok: true, data: undefined });
    expect(lastCall(cleared.fetchImpl)).toEqual({ path: `/api/tickets/${OTHER}/chat/messages`, method: "DELETE", body: undefined });
  });

  it("refuses a response that does not match the contract", async () => {
    const { client } = setup({ items: [{ ticketId: 1 }] });
    expect(await client.listChats()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
});

describe("chat errors", () => {
  const error = (status: number, code: string, details?: unknown) => setup({ error: { code, message: "x", ...(details === undefined ? {} : { details }) } }, status);

  it.each([
    [409, "chat_busy", "conflict"],
    [409, "chat_changed", "conflict"],
    [409, "project_archived", "conflict"],
    [403, "assistant_consent_required", "forbidden"],
    [503, "assistant_not_configured", "unavailable"],
    [503, "assistant_unavailable", "unavailable"],
    [422, "cannot_mention_self", "unavailable"],
    [422, "thread_full", "unavailable"],
    [400, "invalid_cursor", "invalid"],
    [404, "not_found", "not_found"],
  ])("keeps the code of %i %s", async (status, code, kind) => {
    const { client } = error(status, code);
    expect(await client.sendChatMessage(OTHER, { body: "Oi" })).toEqual({ ok: false, error: { kind, code } });
  });

  it("carries the details the screen needs: retry delay, the people refused and the limit", async () => {
    expect(await error(429, "chat_rate_limited", { retryAfterSeconds: 12 }).client.sendChatMessage(OTHER, { body: "Oi" })).toEqual({ ok: false, error: { kind: "unavailable", code: "chat_rate_limited", details: { retryAfterSeconds: 12 } } });
    expect(await error(422, "mention_not_allowed", { personIds: [ID] }).client.sendChatMessage(OTHER, { body: "Oi", mentions: [ID] })).toEqual({ ok: false, error: { kind: "unavailable", code: "mention_not_allowed", details: { personIds: [ID] } } });
    expect(await error(422, "too_many_mentions", { max: 10 }).client.sendChatMessage(OTHER, { body: "Oi" })).toEqual({ ok: false, error: { kind: "unavailable", code: "too_many_mentions", details: { max: 10 } } });
  });

  it("does not add details to errors that never had them", async () => {
    expect(await error(409, "chat_busy", { x: 1 }).client.sendChatMessage(OTHER, { body: "Oi" })).toEqual({ ok: false, error: { kind: "conflict", code: "chat_busy" } });
  });

  it.each(["chat_busy", "chat_changed", "mention_not_allowed", "cannot_mention_self", "too_many_mentions", "thread_full", "chat_thread_rate_limited", "chat_rate_limited", "invalid_cursor"])("has a phrase for %s in the three languages", async (code) => {
    for (const language of ["pt-BR", "en", "es-MX"]) {
      const text = describeApiError(i18n.getFixedT(language), { kind: "unavailable", code });
      expect(text, `${language} ${code}`).not.toBe(describeApiError(i18n.getFixedT(language), { kind: "unavailable" }));
    }
  });
});
