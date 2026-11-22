import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { describeApiError } from "./errorText.js";
import { createApiClient } from "./client.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const detail = {
  id: ID,
  projectId: OTHER,
  status: "open",
  draft: { title: "Corrigir o login", description: "Texto" },
  ready: true,
  createdTicketId: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  messages: [{ id: "m1", author: "person", body: "Oi", model: null, createdAt: "2026-11-20T10:00:00.000Z" }],
};
const target = { parentId: ID, path: [{ id: ID, title: "Ramo" }] };
const outcome = { destination: target, alternatives: [], discarded: [], uncertain: false, stoppedEarly: null, scope: null, groupProposal: null, groupProposalSkipped: null };
const ticketDetail = {
  id: ID, projectId: OTHER, number: 1, key: "K-1", parentId: null, title: "T", status: "todo", progress: null,
  assigneeIds: [], descriptionExcerpt: "", description: "", mentionedBy: [], createdByPersonId: OTHER, createdAt: "x", updatedAt: "y",
};

function setup(body: unknown = {}, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })));
  const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
  return { client, fetchImpl };
}
const lastCall = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => {
  const [path, init] = fetchImpl.mock.calls.at(-1)!;
  return { path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

describe("assistant in getMe", () => {
  const me = {
    person: { id: ID, displayName: "Ana", email: "a@x.com", avatarUrl: null },
    organization: { orgId: "o", name: "E", slug: "e" },
    roles: { clerk: "admin", teams: [], projects: [] },
  };
  it("accepts a response without the assistant field (older API)", async () => {
    const { client } = setup(me);
    const result = await client.getMe();
    expect(result.ok && result.data.assistant).toBeUndefined();
  });
  it("keeps assistant.enabled when present", async () => {
    const { client } = setup({ ...me, assistant: { enabled: true } });
    const result = await client.getMe();
    expect(result.ok && result.data.assistant).toEqual({ enabled: true });
  });
});

describe("ticket conversation calls", () => {
  it("opens a conversation in a project with the first message", async () => {
    const { client, fetchImpl } = setup(detail);
    const result = await client.openConversation(OTHER, { message: "Oi" });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/projects/${OTHER}/ticket-conversations`, method: "POST", body: { message: "Oi" } });
    expect(result).toEqual({ ok: true, data: detail });
  });
  it("sends a message", async () => {
    const { client, fetchImpl } = setup(detail);
    await client.sendConversationMessage(ID, { message: "Mais" });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/messages`, method: "POST", body: { message: "Mais" } });
  });
  it("sends the scope when opening a conversation and with each message (a ticket id or null)", async () => {
    const { client, fetchImpl } = setup(detail);
    await client.openConversation(OTHER, { message: "Oi", scopeId: ID });
    expect(lastCall(fetchImpl).body).toEqual({ message: "Oi", scopeId: ID });
    await client.openConversation(OTHER, { message: "Oi", scopeId: null });
    expect(lastCall(fetchImpl).body).toEqual({ message: "Oi", scopeId: null });
    await client.sendConversationMessage(ID, { message: "Mais", scopeId: OTHER });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/messages`, method: "POST", body: { message: "Mais", scopeId: OTHER } });
    await client.sendConversationMessage(ID, { message: "Mais", scopeId: null });
    expect(lastCall(fetchImpl).body).toEqual({ message: "Mais", scopeId: null });
  });
  it("adjusts the draft", async () => {
    const { client, fetchImpl } = setup(detail);
    await client.updateConversationDraft(ID, { title: "T", description: "D" });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/draft`, method: "PATCH", body: { title: "T", description: "D" } });
  });
  it("searches for the place", async () => {
    const { client, fetchImpl } = setup(outcome);
    const result = await client.findPlacement(ID);
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/placement`, method: "POST", body: undefined });
    expect(result).toEqual({ ok: true, data: outcome });
  });
  it("sends the scope ticket in the body when there is one", async () => {
    const { client, fetchImpl } = setup({ ...outcome, scope: { id: "t1", title: "Acesso", outOfScope: true } });
    const result = await client.findPlacement(ID, "t1");
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/placement`, method: "POST", body: { scopeId: "t1" } });
    expect(result.ok && result.data.scope).toEqual({ id: "t1", title: "Acesso", outOfScope: true });
  });
  it("reads an outcome from an API without the scope field as having no scope", async () => {
    const old: Record<string, unknown> = { ...outcome };
    delete old.scope;
    const { client } = setup(old);
    const result = await client.findPlacement(ID);
    expect(result.ok && result.data.scope).toBeNull();
  });
  it("reads the group proposal and the reason it was skipped", async () => {
    const proposal = { title: "Redefinição de senha", description: "Fluxos de senha.", tickets: [{ id: ID, number: 3, title: "Senha esquecida" }] };
    const { client } = setup({ ...outcome, groupProposal: proposal, groupProposalSkipped: null });
    const result = await client.findPlacement(ID);
    expect(result.ok && result.data.groupProposal).toEqual(proposal);
    const skipped = await setup({ ...outcome, groupProposal: null, groupProposalSkipped: "unavailable" }).client.findPlacement(ID);
    expect(skipped.ok && [skipped.data.groupProposal, skipped.data.groupProposalSkipped]).toEqual([null, "unavailable"]);
  });
  it("reads an outcome from an API without the proposal fields as having no proposal", async () => {
    const old: Record<string, unknown> = { ...outcome };
    delete old.groupProposal;
    delete old.groupProposalSkipped;
    const { client } = setup(old);
    const result = await client.findPlacement(ID);
    expect(result.ok && [result.data.groupProposal, result.data.groupProposalSkipped]).toEqual([null, null]);
  });
  it("rejects a proposal with an unknown skip reason or without tickets", async () => {
    expect(await setup({ ...outcome, groupProposalSkipped: "outro" }).client.findPlacement(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
    const empty = { title: "T", description: "", tickets: [] };
    expect(await setup({ ...outcome, groupProposal: empty }).client.findPlacement(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it("sends the new group with the confirmation", async () => {
    const { client, fetchImpl } = setup({ conversation: detail, ticket: ticketDetail });
    const group = { title: "Redefinição", description: "Fluxos.", ticketIds: [OTHER, ID] };
    await client.createTicketFromConversation(ID, { parentId: OTHER, group });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/ticket`, method: "POST", body: { parentId: OTHER, group } });
  });
  it("explains grouping_changed in words", () => {
    expect(describeApiError(i18n.t, { kind: "conflict", code: "grouping_changed" })).toBe("Algum desses tickets mudou de lugar. Procure de novo.");
  });
  it("rejects a placement outcome with more than two alternatives", async () => {
    const { client } = setup({ ...outcome, alternatives: [target, target, target] });
    expect(await client.findPlacement(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it("creates the ticket under the chosen parent (or null for the project root)", async () => {
    const { client, fetchImpl } = setup({ conversation: detail, ticket: ticketDetail });
    const result = await client.createTicketFromConversation(ID, { parentId: null });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}/ticket`, method: "POST", body: { parentId: null } });
    expect(result.ok && result.data.ticket.id).toBe(ID);
  });
  it("lists the conversations of a project", async () => {
    const { client, fetchImpl } = setup([{ ...detail, messages: undefined }]);
    const result = await client.listConversations(OTHER);
    expect(lastCall(fetchImpl).path).toBe(`/api/ticket-conversations?projectId=${OTHER}`);
    expect(result.ok && result.data[0]?.id).toBe(ID);
  });
  it("reads and deletes a conversation", async () => {
    const read = setup(detail);
    await read.client.getConversation(ID);
    expect(lastCall(read.fetchImpl)).toEqual({ path: `/api/ticket-conversations/${ID}`, method: "GET", body: undefined });
    const removed = setup(undefined, 204);
    expect(await removed.client.removeConversation(ID)).toEqual({ ok: true, data: undefined });
    expect(lastCall(removed.fetchImpl).method).toBe("DELETE");
  });
  it("keeps the API error code of a closed conversation", async () => {
    const { client } = setup({ error: { code: "conversation_closed" } }, 409);
    expect(await client.sendConversationMessage(ID, { message: "x" })).toEqual({ ok: false, error: { kind: "conflict", code: "conversation_closed" } });
  });
});

describe("describeApiError for the assistant", () => {
  it.each([
    ["assistant_not_configured", "não está configurado"],
    ["assistant_unavailable", "não respondeu"],
    ["conversation_closed", "já foi encerrada"],
    ["conversation_changed", "mudou"],
    ["draft_required", "rascunho"],
  ])("explains %s in Portuguese", (code, fragment) => {
    const message = describeApiError(i18n.t, { kind: code.startsWith("assistant") ? "unavailable" : "conflict", code });
    expect(message).toContain(fragment);
    expect(message).not.toMatch(/Recarregue e tente|API está indisponível/);
  });
});

describe("ticket summary calls (ADR 0033, ADR 0034)", () => {
  const summary = { summary: { text: "Reúne o que for do login.", source: "assistant", updatedAt: "2026-11-21T12:00:00.000Z" } };
  it("reads the summary, with or without text", async () => {
    const { client, fetchImpl } = setup(summary);
    expect(await client.getTicketSummary(ID)).toEqual({ ok: true, data: summary });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/tickets/${ID}/summary`, method: "GET", body: undefined });
    const empty = setup({ summary: null });
    expect(await empty.client.getTicketSummary(ID)).toEqual({ ok: true, data: { summary: null } });
  });
  it("rejects an unknown source as an unavailable API", async () => {
    const { client } = setup({ summary: { ...summary.summary, source: "robot" } });
    expect(await client.getTicketSummary(ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it("writes the text with PUT", async () => {
    const { client, fetchImpl } = setup({ summary: { ...summary.summary, source: "person" } });
    const result = await client.putTicketSummary(ID, { text: "Texto" });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/tickets/${ID}/summary`, method: "PUT", body: { text: "Texto" } });
    expect(result.ok && result.data.summary?.source).toBe("person");
  });
  it("asks the assistant for a new text with POST", async () => {
    const { client, fetchImpl } = setup(summary);
    await client.regenerateTicketSummary(ID);
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/tickets/${ID}/summary/regenerate`, method: "POST", body: undefined });
  });
  it("keeps the error codes and says what each one means", async () => {
    const empty = await setup({ error: { code: "ticket_has_no_items" } }, 409).client.regenerateTicketSummary(ID);
    expect(empty).toEqual({ ok: false, error: { kind: "conflict", code: "ticket_has_no_items" } });
    if (!empty.ok) expect(describeApiError(i18n.t, empty.error)).toBe("Este ticket ainda não tem itens.");
    const down = await setup({ error: { code: "assistant_unavailable" } }, 503).client.regenerateTicketSummary(ID);
    expect(down).toEqual({ ok: false, error: { kind: "unavailable", code: "assistant_unavailable" } });
  });
});

describe("description draft", () => {
  it("asks for a text with POST, sends the request and the current text, and can be aborted", async () => {
    const { client, fetchImpl } = setup({ text: "## Critérios", model: "m" });
    const controller = new AbortController();
    const result = await client.draftTicketDescription(ID, { request: "Escreva", description: "Texto" }, { signal: controller.signal });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/tickets/${ID}/description/draft`, method: "POST", body: { request: "Escreva", description: "Texto" } });
    expect(fetchImpl.mock.calls.at(-1)![1]?.signal).toBe(controller.signal);
    expect(result).toEqual({ ok: true, data: { text: "## Critérios", model: "m" } });
  });
  it("an aborted request is a failure, never an exception", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
    expect(await client.draftTicketDescription(ID, { request: "x", description: "" })).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it("keeps the 503 code when the assistant is down", async () => {
    const down = await setup({ error: { code: "assistant_unavailable" } }, 503).client.draftTicketDescription(ID, { request: "x", description: "" });
    expect(down).toEqual({ ok: false, error: { kind: "unavailable", code: "assistant_unavailable" } });
  });
});
