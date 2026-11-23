import { vi } from "vitest";
import type { ApiClient, ApiError, ApiErrorKind, ApiResult, ChatListItem, ChatMessage, ChatPage, ChatPerson, ChatThread, ChatWriteBody, TicketChat } from "../api/client.js";

/**
 * O chat de trabalho por ticket (ADR 0049) em memória, com as regras do contrato (`CONTRATO-CHAT.local.md`): chat por pessoa, conversa
 * só com o assistente, threads por menção, posição por `cursor` opaco, ponto de leitura que nunca recua, limpar só a conversa.
 * Não importa `fakes.ts` (que o importa): tem os próprios `ok` e `failed`.
 */
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const failed = (kind: ApiErrorKind, code?: string, details?: Record<string, unknown>): ApiResult<never> => ({
  ok: false,
  error: { kind, ...(code === undefined ? {} : { code }), ...(details === undefined ? {} : { details }) } as ApiError,
});

interface StoredMessage {
  seq: number;
  authorId: string | null;
  body: string;
  model: string | null;
  threadId: string | null;
}
interface StoredThread {
  id: string;
  ticketId: string;
  startedBy: string;
  participants: string[];
  messages: StoredMessage[];
}
export interface FakeChatTicket {
  id: string;
  key: string;
  title: string;
  projectId?: string;
  archived?: boolean;
  /** A pessoa de quem o cliente fala é responsável pelo ticket (o chat aparece sozinho na lista). */
  assignedToMe?: boolean;
  /** Quem enxerga o ticket; ausente = todas as pessoas. */
  visibleTo?: string[];
}
export interface FakeChatOptions {
  tickets: FakeChatTicket[];
  people: { id: string; displayName: string }[];
  /** Quem é "eu"; padrão `person-1`. */
  me?: string;
  /** O que o assistente responde; padrão: "Resposta do assistente." */
  reply?: (body: string) => string;
  /** Estado da IA no servidor: `ready` (padrão), `no_consent` (403) ou `not_configured` (503). */
  assistant?: "ready" | "no_consent" | "not_configured";
}

export interface FakeChat {
  options: FakeChatOptions;
  /** Alguém (outra pessoa) abre uma thread mencionando a pessoa do cliente (ou só as de `to`). */
  receiveThread(ticketId: string, input: { from: string; body: string; to?: string[]; replies?: { from: string; body: string }[] }): string;
  /** Alguém responde numa thread que já existe. */
  receiveReply(threadId: string, input: { from: string; body: string }): void;
  /** Uma mensagem da pessoa do cliente na conversa com o assistente, já guardada, mais a resposta do assistente. */
  seedConversation(ticketId: string, turns: { person: string; assistant: string }[]): void;
  /** Dá o chat como lido até o fim. */
  readAll(ticketId: string): void;
  /** Mensagens da conversa guardadas hoje (mais antigas primeiro). */
  conversationOf(ticketId: string): { authorId: string | null; body: string }[];
  methods(): Partial<ApiClient>;
}

const EPOCH = Date.parse("2026-11-23T10:00:00.000Z");
const cursorOf = (seq: number) => `c${seq}`;
const seqOf = (cursor: string): number | null => (/^c\d+$/.test(cursor) ? Number(cursor.slice(1)) : null);

export function createFakeChat(options: FakeChatOptions): FakeChat {
  const me = options.me ?? "person-1";
  let seq = 0;
  const conversations = new Map<string, StoredMessage[]>();
  const threads = new Map<string, StoredThread>();
  const lastRead = new Map<string, number>();
  /** O chat existe depois do primeiro envio, da primeira menção ou da primeira thread recebida. */
  const chats = new Set<string>();
  const nextSeq = () => ++seq;
  const at = (n: number) => new Date(EPOCH + n * 60_000).toISOString();
  const ticketOf = (id: string) => options.tickets.find((entry) => entry.id === id);
  const person = (id: string | null): ChatPerson | null => {
    if (id === null) return null;
    const found = options.people.find((entry) => entry.id === id);
    return { id, displayName: found?.displayName ?? id, avatarUrl: null };
  };
  const conversationOf = (ticketId: string) => conversations.get(ticketId) ?? [];
  const readSeq = (ticketId: string) => lastRead.get(ticketId) ?? 0;

  const toMessage = (ticketId: string, stored: StoredMessage): ChatMessage => ({
    id: `m${stored.seq}`,
    cursor: cursorOf(stored.seq),
    unread: stored.authorId !== me && stored.seq > readSeq(ticketId),
    authorKind: stored.authorId === null ? "assistant" : "person",
    author: person(stored.authorId),
    body: stored.body,
    createdAt: at(stored.seq),
    model: stored.model,
    threadId: stored.threadId,
  });
  const summaryOf = (thread: StoredThread): ChatThread => {
    const root = thread.messages[0]!;
    return {
      id: thread.id,
      ticketId: thread.ticketId,
      root: toMessage(thread.ticketId, root),
      replyCount: thread.messages.length - 1,
      lastMessageAt: at(thread.messages.at(-1)!.seq),
      unread: thread.messages.filter((entry) => entry.authorId !== me && entry.seq > readSeq(thread.ticketId)).length,
      startedByMe: thread.startedBy === me,
      participants: thread.participants.map((id) => person(id)!),
    };
  };
  const mine = (ticketId: string) => [...threads.values()].filter((thread) => thread.ticketId === ticketId && thread.participants.includes(me));
  const lastSeqOf = (ticketId: string) => Math.max(0, ...conversationOf(ticketId).map((entry) => entry.seq), ...mine(ticketId).flatMap((thread) => thread.messages.map((entry) => entry.seq)));
  const unreadOf = (ticketId: string) =>
    conversationOf(ticketId).filter((entry) => entry.authorId !== me && entry.seq > readSeq(ticketId)).length + mine(ticketId).reduce((sum, thread) => sum + summaryOf(thread).unread, 0);

  const pageOf = (ticketId: string, all: StoredMessage[], query: { limit?: number; before?: string }): ApiResult<ChatPage> => {
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failed("invalid", "validation_error");
    let list = [...all].sort((a, b) => b.seq - a.seq);
    if (query.before !== undefined) {
      const before = seqOf(query.before);
      if (before === null) return failed("invalid", "invalid_cursor");
      list = list.filter((entry) => entry.seq < before);
    }
    const items = list.slice(0, limit);
    return ok({ items: items.map((entry) => toMessage(ticketId, entry)), nextBefore: list.length > limit ? cursorOf(items.at(-1)!.seq) : null });
  };

  /** A conferência das menções: a pessoa mencionada precisa existir e enxergar o ticket. */
  const checkMentions = (ticket: FakeChatTicket, mentions: string[] | undefined): ApiResult<never> | null => {
    if (mentions === undefined || mentions.length === 0) return null;
    if (mentions.includes(me)) return failed("unavailable", "cannot_mention_self");
    if (mentions.length > 10) return failed("unavailable", "too_many_mentions", { max: 10 });
    const refused = mentions.filter((id) => !options.people.some((entry) => entry.id === id) || (ticket.visibleTo !== undefined && !ticket.visibleTo.includes(id)));
    return refused.length > 0 ? failed("unavailable", "mention_not_allowed", { personIds: refused }) : null;
  };
  const validBody = (body: unknown): body is string => typeof body === "string" && body.trim().length >= 1 && body.trim().length <= 4000;

  const startThread = (ticketId: string, startedBy: string, body: string, others: string[]): StoredThread => {
    const root: StoredMessage = { seq: nextSeq(), authorId: startedBy, body, model: null, threadId: null };
    const thread: StoredThread = { id: `m${root.seq}`, ticketId, startedBy, participants: [...new Set([startedBy, ...others])], messages: [root] };
    root.threadId = thread.id;
    threads.set(thread.id, thread);
    chats.add(ticketId);
    return thread;
  };

  const self: FakeChat = {
    options,
    receiveThread(ticketId, { from, body, to = [me], replies = [] }) {
      const thread = startThread(ticketId, from, body, to);
      for (const reply of replies) thread.messages.push({ seq: nextSeq(), authorId: reply.from, body: reply.body, model: null, threadId: thread.id });
      return thread.id;
    },
    receiveReply(threadId, { from, body }) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(`thread desconhecida: ${threadId}`);
      thread.messages.push({ seq: nextSeq(), authorId: from, body, model: null, threadId: thread.id });
    },
    seedConversation(ticketId, turns) {
      const list = conversations.get(ticketId) ?? [];
      for (const turn of turns) {
        list.push({ seq: nextSeq(), authorId: me, body: turn.person, model: null, threadId: null });
        list.push({ seq: nextSeq(), authorId: null, body: turn.assistant, model: "claude-opus-5-5", threadId: null });
      }
      conversations.set(ticketId, list);
      chats.add(ticketId);
    },
    readAll(ticketId) {
      lastRead.set(ticketId, lastSeqOf(ticketId));
    },
    conversationOf: (ticketId) => conversationOf(ticketId).map((entry) => ({ authorId: entry.authorId, body: entry.body })),
    methods() {
      return {
        listChats: vi.fn(async () => {
          const items: ChatListItem[] = options.tickets
            .filter((ticket) => ticket.assignedToMe === true || chats.has(ticket.id))
            .map((ticket) => {
              const last = lastSeqOf(ticket.id);
              return {
                ticketId: ticket.id,
                ticketKey: ticket.key,
                title: ticket.title,
                projectId: ticket.projectId ?? "p1",
                chatId: chats.has(ticket.id) ? `chat-${ticket.id}` : null,
                assignedToMe: ticket.assignedToMe === true,
                lastActivityAt: at(last),
                unread: unreadOf(ticket.id),
              };
            })
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
          return ok({ items });
        }),
        getTicketChat: vi.fn(async (ticketId: string, query: { limit?: number; before?: string } = {}): Promise<ApiResult<TicketChat>> => {
          const ticket = ticketOf(ticketId);
          if (!ticket) return failed("not_found", "not_found");
          const messages = pageOf(ticketId, conversationOf(ticketId), query);
          if (!messages.ok) return messages;
          const read = readSeq(ticketId);
          return ok({
            ticket: { id: ticket.id, key: ticket.key, title: ticket.title, projectId: ticket.projectId ?? "p1", archived: ticket.archived === true },
            chatId: chats.has(ticketId) ? `chat-${ticketId}` : null,
            assignedToMe: ticket.assignedToMe === true,
            lastRead: read === 0 ? null : cursorOf(read),
            unread: unreadOf(ticketId),
            messages: messages.data,
            threads: mine(ticketId)
              .map(summaryOf)
              .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
          });
        }),
        getChatThread: vi.fn(async (threadId: string, query: { limit?: number; before?: string } = {}) => {
          const thread = threads.get(threadId);
          const ticket = thread && ticketOf(thread.ticketId);
          if (!thread || !ticket || !thread.participants.includes(me)) return failed("not_found", "not_found");
          const replies = pageOf(thread.ticketId, thread.messages.slice(1), query);
          if (!replies.ok) return replies;
          return ok({ ticket: { id: ticket.id, key: ticket.key, title: ticket.title, projectId: ticket.projectId ?? "p1", archived: ticket.archived === true }, thread: summaryOf(thread), replies: replies.data });
        }),
        sendChatMessage: vi.fn(async (ticketId: string, body: ChatWriteBody) => {
          const ticket = ticketOf(ticketId);
          if (!ticket) return failed("not_found", "not_found");
          if (!validBody(body.body)) return failed("invalid", "validation_error");
          if (ticket.archived === true) return failed("conflict", "project_archived");
          const text = body.body.trim();
          const problem = checkMentions(ticket, body.mentions);
          if (problem) return problem;
          if (body.mentions !== undefined && body.mentions.length > 0) {
            return ok({ kind: "thread" as const, thread: summaryOf(startThread(ticketId, me, text, body.mentions)) });
          }
          if (options.assistant === "no_consent") return failed("forbidden", "assistant_consent_required");
          if (options.assistant === "not_configured") return failed("unavailable", "assistant_not_configured");
          const list = conversations.get(ticketId) ?? [];
          const sent: StoredMessage = { seq: nextSeq(), authorId: me, body: text, model: null, threadId: null };
          const answer: StoredMessage = { seq: nextSeq(), authorId: null, body: options.reply?.(text) ?? "Resposta do assistente.", model: "claude-opus-5-5", threadId: null };
          list.push(sent, answer);
          conversations.set(ticketId, list);
          chats.add(ticketId);
          return ok({ kind: "assistant" as const, message: toMessage(ticketId, sent), reply: toMessage(ticketId, answer) });
        }),
        replyChatThread: vi.fn(async (threadId: string, body: ChatWriteBody) => {
          const thread = threads.get(threadId);
          const ticket = thread && ticketOf(thread.ticketId);
          if (!thread || !ticket || !thread.participants.includes(me)) return failed("not_found", "not_found");
          if (!validBody(body.body)) return failed("invalid", "validation_error");
          if (ticket.archived === true) return failed("conflict", "project_archived");
          const problem = checkMentions(ticket, body.mentions);
          if (problem) return problem;
          const added = (body.mentions ?? []).filter((id) => !thread.participants.includes(id));
          if (thread.participants.length + added.length > 25) return failed("unavailable", "thread_full");
          thread.participants.push(...added);
          const reply: StoredMessage = { seq: nextSeq(), authorId: me, body: body.body.trim(), model: null, threadId: thread.id };
          thread.messages.push(reply);
          return ok({ message: toMessage(thread.ticketId, reply), thread: summaryOf(thread) });
        }),
        markChatRead: vi.fn(async (ticketId: string, body: { upTo?: string } = {}) => {
          if (!ticketOf(ticketId)) return failed("not_found", "not_found");
          if (!chats.has(ticketId)) return ok({ lastRead: null, unread: 0 });
          const newest = lastSeqOf(ticketId);
          let target = newest;
          if (body.upTo !== undefined) {
            const upTo = seqOf(body.upTo);
            if (upTo === null) return failed("invalid", "invalid_cursor");
            target = Math.min(upTo, newest);
          }
          lastRead.set(ticketId, Math.max(readSeq(ticketId), target));
          const read = readSeq(ticketId);
          return ok({ lastRead: read === 0 ? null : cursorOf(read), unread: unreadOf(ticketId) });
        }),
        clearChat: vi.fn(async (ticketId: string) => {
          conversations.delete(ticketId);
          return ok(undefined);
        }),
      };
    },
  };
  return self;
}
