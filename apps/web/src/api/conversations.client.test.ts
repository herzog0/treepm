import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";

// O cliente fala o contrato das conversas em níveis (ADR 0055) sem adaptador: o que o servidor manda é o que a tela recebe.
const ID = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const ana = { id: ID, displayName: "Ana", avatarUrl: null };
const msg = (extra: Record<string, unknown> = {}) => ({ id: "m1", cursor: "c1", unread: false, authorKind: "person", author: ana, body: "Oi", createdAt: "2026-11-24T10:00:00.000Z", model: null, ...extra });
const card = { id: "t1", opening: msg({ id: "m9", cursor: "c9" }), participants: [ana], participantCount: 2, replyCount: 2, lastActivityAt: "2026-11-24T10:05:00.000Z", unread: 1, startedByMe: true };
const ticket = { id: TICKET, key: "ALFA-1", title: "Login", projectId: ID, archived: false, status: "todo", blocked: false };
const info = { id: "c1", kind: "ticket", ownedByMe: true, participants: [ana], canAddParticipants: false, canOpenThread: true, openingMessageId: null, opening: null, replyCount: 0, lastActivityAt: "2026-11-24T10:00:00.000Z", trail: [] };
const view = { conversation: info, ticket, assignedToMe: true, lastRead: null, unread: 2, messages: { items: [{ ...msg(), thread: null }, { ...msg({ id: "m2" }), thread: card }], nextBefore: null }, threads: [card] };

function setup(responses: unknown[], status = 200) {
  const queue = [...responses];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(queue.shift() ?? {}, { status }));
  return { client: createApiClient({ getToken: async () => "tok", fetch: fetchImpl }), fetchImpl };
}
const calls = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => fetchImpl.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${String(path)}`);

describe("conversation calls", () => {
  it("lists the tree as the server sends it, children included, with no write", async () => {
    const thread = { id: "t1", kind: "thread", ticket: null, ownedByMe: true, assignedToMe: false, participants: [ana], participantCount: 3, lastActivityAt: "2026-11-24T10:00:00.000Z", unread: 0, preview: "oi", children: [] };
    const principal = { id: null, kind: "ticket", ticket, ownedByMe: false, assignedToMe: true, participants: [], participantCount: 0, lastActivityAt: null, unread: 0, preview: null, children: [thread] };
    const { client, fetchImpl } = setup([{ items: [principal] }]);
    const result = await client.listConversationTree();
    expect(calls(fetchImpl)).toEqual(["GET /api/conversations"]);
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: null, children: [{ id: "t1", participantCount: 3 }] }] } });
  });

  it("reads a conversation by id and a ticket's conversation without creating anything", async () => {
    const { client, fetchImpl } = setup([view, view]);
    expect((await client.getConversationView("c1", { limit: 30, before: "a b/c" })).ok).toBe(true);
    expect((await client.getTicketConversationView(TICKET, { limit: 30 })).ok).toBe(true);
    expect(calls(fetchImpl)).toEqual(["GET /api/conversations/c1?limit=30&before=a+b%2Fc", `GET /api/tickets/${TICKET}/conversation?limit=30`]);
  });

  it("keeps the thread card on the message that opened it", async () => {
    const { client } = setup([view]);
    const result = await client.getConversationView("c1");
    if (!result.ok) throw new Error("falhou");
    expect(result.data.messages.items[1]?.thread).toMatchObject({ id: "t1", participantCount: 2 });
    expect(result.data.conversation?.canOpenThread).toBe(true);
  });

  it("opens the main conversation and the general chat, then sends with the typed body", async () => {
    const sent = { kind: "thread", message: { ...msg(), thread: null }, thread: card };
    const { client, fetchImpl } = setup([{ id: "c1" }, { id: "g1" }, sent]);
    expect(await client.openTicketConversation(TICKET)).toEqual({ ok: true, data: { id: "c1" } });
    expect(await client.openGeneralConversation()).toEqual({ ok: true, data: { id: "g1" } });
    const result = await client.sendChatMessage("g1", { body: "Oi", mentions: [ID], ticketId: TICKET });
    expect(result).toMatchObject({ ok: true, data: { kind: "thread", thread: { id: "t1" } } });
    expect(calls(fetchImpl)).toEqual([`POST /api/tickets/${TICKET}/conversation`, "POST /api/conversations/general", "POST /api/conversations/g1/messages"]);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ body: "Oi", mentions: [ID], ticketId: TICKET });
  });

  it("includes people, marks as read and clears the main conversation", async () => {
    const { client, fetchImpl } = setup([{ participants: [ana] }, { lastRead: "c2", unread: 0 }, {}]);
    expect(await client.addConversationParticipants("t1", [ID])).toEqual({ ok: true, data: { participants: [ana] } });
    expect(await client.markConversationRead("c1", { upTo: "c2" })).toEqual({ ok: true, data: { lastRead: "c2", unread: 0 } });
    expect((await client.clearConversationMessages("c1")).ok).toBe(true);
    expect(calls(fetchImpl)).toEqual(["POST /api/conversations/t1/participants", "POST /api/conversations/c1/read", "DELETE /api/conversations/c1/messages"]);
  });

  it("keeps the details the screen needs from the refusals (who cannot be marked)", async () => {
    const { client } = setup([{ error: { code: "mention_not_allowed", details: { personIds: ["p2"] } } }], 422);
    expect(await client.sendChatMessage("c1", { body: "Oi", mentions: ["p2"] })).toMatchObject({ ok: false, error: { code: "mention_not_allowed", details: { personIds: ["p2"] } } });
  });

  it("does not take a server answer in another shape (no tolerance)", async () => {
    const { client } = setup([{ items: [{ id: "x" }] }]);
    expect(await client.listConversationTree()).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });
});
