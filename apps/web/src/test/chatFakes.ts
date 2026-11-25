import type { CreationBlock } from "../api/conversations.js";
import { vi } from "vitest";
import type { ApiClient, ApiError, ApiErrorKind, ApiResult } from "../api/client.js";
import { closedResultSchema, conversationTreeSchema, conversationViewSchema, reopenedResultSchema, sendResultSchema } from "../api/conversations.js";
import type { ChatMessage, ChatPerson, ConversationNode, ConversationView, SendResult, ThreadCard } from "../api/conversations.js";

/**
 * As conversas em níveis (ADR 0055) em memória, com as regras do contrato do servidor: uma principal por pessoa e ticket, um chat geral
 * por pessoa, threads dentro de threads, quem participa da de cima participa das de dentro, quem é marcado vê a thread e nada acima,
 * posição por `cursor` opaco, "lido até" por pessoa e conversa. Cada resposta passa pelos esquemas do cliente. As mesmas conversas
 * podem ser lidas por pessoas diferentes (`methods(personId)`): dono, participante e convidado. Não importa `fakes.ts` (que o importa).
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
  /** A conversa (thread) que esta mensagem abriu. */
  opened: string | null;
  /** `creation_opened`: a resposta fixa de "abri um rascunho". */
  marker?: "creation_opened";
}
interface StoredConversation {
  id: string;
  kind: "ticket" | "general" | "thread";
  ticketId: string | null;
  ownerId: string;
  parentId: string | null;
  depth: number;
  participants: string[];
  messages: StoredMessage[];
  /** Só nas threads: entre pessoas (`people`) ou assunto com o assistente (`topic`). */
  purpose: "people" | "topic" | "creation" | null;
  title: string | null;
  /** Só nas threads de criação: o bloco que a API manda (estado, projeto, ticket criado). */
  creation?: CreationBlock | null;
}
export interface FakeChatTicket {
  id: string;
  key: string;
  title: string;
  projectId?: string;
  archived?: boolean;
  status?: string;
  blocked?: boolean;
  /** A pessoa de quem o cliente fala é responsável pelo ticket (o ticket aparece sozinho na barra). */
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
  /** O título que o assistente dá a uma thread de assunto nova; padrão: nenhum (a tela usa o começo da abertura). */
  topicTitle?: (body: string) => string | null;
  /** Quem é responsável por cada ticket além de `assignedToMe` (que vale para `me`). */
  assignees?: Record<string, string[]>;
  /** Projetos (id → chave) em que a pessoa pode criar ticket; padrão: só `p1`/ALFA. A chave dos tickets vem de `projectId` (padrão `p1`). */
  creatable?: Record<string, string>;
  /** Quando o assistente abre um rascunho: devolve o pedido que ele passa à ferramenta para esta mensagem, ou `null` (responde normalmente). */
  assistantOpens?: (body: string) => string | null;
}

export type FakeChatMethods = Pick<ApiClient, "listConversationTree" | "getConversationView" | "getTicketConversationView" | "openTicketConversation" | "openGeneralConversation" | "sendChatMessage" | "addConversationParticipants" | "markConversationRead" | "clearConversationMessages" | "closeConversation" | "reopenConversation" | "listClosedConversations">;

export interface FakeChat {
  options: FakeChatOptions;
  /** Alguém (outra pessoa) abre, na conversa principal dela no ticket, uma thread marcando a pessoa do cliente (ou só as de `to`). Devolve o id da thread. */
  receiveThread(ticketId: string, input: { from: string; body: string; to?: string[]; replies?: { from: string; body: string }[] }): string;
  /** Alguém abre uma thread dentro de uma conversa que já existe (`from` participa dela). */
  openThreadIn(parentId: string, input: { from: string; body: string; to: string[]; replies?: { from: string; body: string }[]; ticketId?: string }): string;
  /** Alguém responde numa thread que já existe. */
  receiveReply(threadId: string, input: { from: string; body: string }): void;
  /** Uma mensagem da pessoa do cliente na conversa com o assistente, já guardada, mais a resposta do assistente. Devolve o id da conversa. */
  seedConversation(ticketId: string, turns: { person: string; assistant: string }[]): string;
  /** O chat geral da pessoa do cliente, já existente, com estas mensagens. Devolve o id. */
  seedGeneral(turns: { person: string; assistant: string }[]): string;
  /** Uma thread de assunto da pessoa do cliente, já existente, dentro de `parentId` (principal ou chat geral): a abertura mora em cima, a resposta na thread. Devolve o id. */
  seedTopic(parentId: string, input: { body: string; reply?: string; title?: string | null }): string;
  /** O estado da thread de criação, como o servidor o deriva da conversa de novo ticket (o teste o muda quando a conversa muda). */
  setCreation(threadId: string, patch: Partial<NonNullable<StoredConversation["creation"]>>): void;
  /** O bloco `creation` da thread (ou `null`). */
  creationOf(threadId: string): StoredConversation["creation"] | null;
  /** A pessoa de `personId` (padrão `me`) fechou esta conversa (e as de dentro em que participa), sem passar pela API. */
  closeFor(conversationId: string, personId?: string): void;
  /** A conversa está fechada para a pessoa (padrão `me`)? */
  isClosedFor(conversationId: string, personId?: string): boolean;
  /** Dá a conversa como lida até o fim (a de `conversationId`, ou todas as da pessoa). */
  readAll(conversationId?: string): void;
  /** Mensagens guardadas hoje na principal do ticket (mais antigas primeiro). */
  conversationOf(ticketId: string): { authorId: string | null; body: string }[];
  /** O id da principal da pessoa no ticket, ou `undefined`. */
  principalOf(ticketId: string, personId?: string): string | undefined;
  /** O id do chat geral da pessoa, ou `undefined`. */
  generalOf(personId?: string): string | undefined;
  /** Os métodos do cliente, vistos pela pessoa (padrão: `me`). */
  methods(personId?: string): FakeChatMethods;
}

const EPOCH = Date.parse("2026-11-23T10:00:00.000Z");
const cursorOf = (seq: number) => `c${seq}`;
const seqOf = (cursor: string): number | null => (/^c\d+$/.test(cursor) ? Number(cursor.slice(1)) : null);
/** Níveis que a pessoa pode ter na trilha, a conversa atual inclusive. */
const MAX_LEVELS = 10;

export function createFakeChat(options: FakeChatOptions): FakeChat {
  const defaultMe = options.me ?? "person-1";
  let seq = 0;
  let counter = 0;
  const conversations = new Map<string, StoredConversation>();
  const lastRead = new Map<string, number>();
  /** `pessoa:conversa` → a posição da última mensagem quando a pessoa fechou (ADR 0059). */
  const closedAt = new Map<string, number>();
  const nextSeq = () => ++seq;
  const at = (n: number) => new Date(EPOCH + n * 60_000).toISOString();
  const ticketOf = (id: string) => options.tickets.find((entry) => entry.id === id);
  const person = (id: string | null): ChatPerson | null => {
    if (id === null) return null;
    const found = options.people.find((entry) => entry.id === id);
    return { id, displayName: found?.displayName ?? id, avatarUrl: null };
  };
  const readSeq = (who: string, conversationId: string) => lastRead.get(`${who}:${conversationId}`) ?? 0;
  const all = () => [...conversations.values()];
  const principalOf = (ticketId: string, who: string) => all().find((entry) => entry.kind === "ticket" && entry.ticketId === ticketId && entry.ownerId === who);
  const generalOf = (who: string) => all().find((entry) => entry.kind === "general" && entry.ownerId === who);
  const sees = (who: string, entry: StoredConversation) => entry.participants.includes(who);
  const canSeeTicket = (ticket: FakeChatTicket, who: string) => ticket.visibleTo === undefined || ticket.visibleTo.includes(who);
  const create = (input: Omit<StoredConversation, "id" | "messages" | "depth" | "purpose" | "title"> & { messages?: StoredMessage[]; purpose?: "people" | "topic" | "creation"; title?: string | null }): StoredConversation => {
    const parent = input.parentId === null ? null : conversations.get(input.parentId)!;
    const entry: StoredConversation = { ...input, purpose: input.kind === "thread" ? (input.purpose ?? "people") : null, title: input.title ?? null, id: `conv-${++counter}`, depth: parent === null ? 0 : parent.depth + 1, messages: input.messages ?? [] };
    conversations.set(entry.id, entry);
    return entry;
  };
  const ensurePrincipal = (ticketId: string, who: string) => principalOf(ticketId, who) ?? create({ kind: "ticket", ticketId, ownerId: who, parentId: null, participants: [who] });
  const ensureGeneral = (who: string) => generalOf(who) ?? create({ kind: "general", ticketId: null, ownerId: who, parentId: null, participants: [who] });

  const lastSeq = (entry: StoredConversation) => Math.max(0, ...entry.messages.map((message) => message.seq));
  /** Fechada para a pessoa: fechou e nenhuma mensagem de outra pessoa (ou do assistente) chegou depois do ponto de fechamento. */
  const isClosed = (who: string, entry: StoredConversation) => {
    const at = closedAt.get(`${who}:${entry.id}`);
    return at !== undefined && !entry.messages.some((message) => message.authorId !== who && message.seq > at);
  };
  const descendantsOf = (entry: StoredConversation): StoredConversation[] => all().filter((child) => child.parentId === entry.id).flatMap((child) => [child, ...descendantsOf(child)]);
  /** Conta como não lida: de outra pessoa, depois do ponto de leitura, e que não abriu uma thread daqui (essas contam no cartão da thread). */
  const countsAsUnread = (who: string, entry: StoredConversation, message: StoredMessage) => message.authorId !== who && message.seq > readSeq(who, entry.id) && (message.opened === null || message.opened === entry.id);
  const unreadIn = (who: string, entry: StoredConversation) => entry.messages.filter((message) => countsAsUnread(who, entry, message)).length;

  const toMessage = (who: string, entry: StoredConversation, stored: StoredMessage, withCard = true): ChatMessage => {
    const opened = stored.opened === null ? null : conversations.get(stored.opened);
    return {
      id: `m${stored.seq}`,
      cursor: cursorOf(stored.seq),
      unread: countsAsUnread(who, entry, stored),
      authorKind: stored.authorId === null ? "assistant" : "person",
      author: person(stored.authorId),
      body: stored.body,
      createdAt: at(stored.seq),
      model: stored.model,
      marker: stored.marker ?? null,
      thread: withCard && opened && sees(who, opened) ? cardOf(who, opened) : null,
    };
  };
  const cardOf = (who: string, entry: StoredConversation): ThreadCard => {
    const { thread: _ignored, ...opening } = toMessage(who, entry, entry.messages[0]!, false);
    void _ignored;
    return {
      id: entry.id,
      opening,
      participants: entry.participants.map((id) => person(id)!),
      participantCount: entry.participants.length,
      replyCount: entry.messages.length - 1,
      lastActivityAt: at(lastSeq(entry)),
      unread: unreadIn(who, entry),
      startedByMe: entry.ownerId === who,
      purpose: entry.purpose ?? "people",
      title: entry.title,
      creation: entry.creation ?? null,
      closed: isClosed(who, entry),
    };
  };

  const openCreation = (child: StoredConversation) => child.purpose !== "creation" || (child.creation?.state !== "created" && child.creation?.state !== "discarded");
  /** As conversas de dentro que aparecem sob `entry`: as fechadas somem e as de dentro delas sobem para a mais próxima que aparece. */
  const kidsOf = (who: string, entry: StoredConversation): StoredConversation[] =>
    all()
      .filter((child) => child.parentId === entry.id && sees(who, child) && openCreation(child))
      .flatMap((child) => (isClosed(who, child) ? kidsOf(who, child) : [child]));

  /** A trilha: só as conversas de cima que a pessoa lê, em sequência a partir da conversa. */
  const trailOf = (who: string, entry: StoredConversation) => {
    const items: { id: string; kind: StoredConversation["kind"]; label: string | null; title: string | null }[] = [];
    let current = entry;
    while (current.parentId !== null) {
      const parent = conversations.get(current.parentId)!;
      if (!sees(who, parent)) break;
      items.unshift({ id: parent.id, kind: parent.kind, label: parent.kind === "thread" ? parent.messages[0]!.body.slice(0, 40) : null, title: parent.title });
      current = parent;
    }
    return items;
  };

  const nodeOf = (who: string, entry: StoredConversation | null, base: { kind: ConversationNode["kind"]; ticket: FakeChatTicket | null }, extraKids: StoredConversation[] = []): ConversationNode => {
    const kids = [...(entry === null ? [] : kidsOf(who, entry)), ...extraKids].sort((a, b) => lastSeq(b) - lastSeq(a));
    const t = base.ticket;
    const last = entry === null ? 0 : lastSeq(entry);
    const readable = entry === null ? [] : entry.messages;
    return {
      id: entry?.id ?? null,
      kind: base.kind,
      ticket: t === null ? null : { id: t.id, key: t.key, title: t.title, projectId: t.projectId ?? "p1", archived: t.archived === true, status: t.status ?? "todo", blocked: t.blocked === true },
      ownedByMe: entry?.ownerId === who,
      assignedToMe: t !== null && ((t.assignedToMe === true && who === defaultMe) || (options.assignees?.[t.id] ?? []).includes(who)),
      participants: (entry?.participants ?? []).slice(0, 5).map((id) => person(id)!),
      participantCount: entry?.participants.length ?? 0,
      lastActivityAt: last === 0 ? null : at(last),
      unread: entry === null ? 0 : unreadIn(who, entry),
      preview: readable.length === 0 ? null : readable.at(-1)!.body.slice(0, 80),
      ...(entry?.purpose === "topic" ? { label: entry.messages[0]!.body.slice(0, 40) } : {}),
      purpose: entry?.purpose ?? null,
      title: entry?.title ?? null,
      creation: entry?.creation ?? null,
      closed: false,
      children: kids.map((child) => nodeOf(who, child, { kind: "thread", ticket: null })),
    };
  };

  const buildTree = (who: string) => {
    const mine = all().filter((entry) => sees(who, entry));
    const general = generalOf(who);
    const generalOrphans: StoredConversation[] = [];
    const ticketOrphans = new Map<string, StoredConversation[]>();
    for (const entry of mine) {
      if (entry.kind !== "thread") continue;
      const parent = conversations.get(entry.parentId!)!;
      if (sees(who, parent) || isClosed(who, entry)) continue;
      // Quem foi marcado só nesta thread: ela aparece sob o ticket de que trata, ou sob o chat geral da própria pessoa.
      if (entry.ticketId === null) generalOrphans.push(entry);
      else ticketOrphans.set(entry.ticketId, [...(ticketOrphans.get(entry.ticketId) ?? []), entry]);
    }
    const items: ConversationNode[] = [nodeOf(who, general ?? null, { kind: "general", ticket: null }, generalOrphans)];
    const ticketIds = new Set<string>();
    for (const ticket of options.tickets) {
      if (!canSeeTicket(ticket, who)) continue;
      const assigned = (ticket.assignedToMe === true && who === defaultMe) || (options.assignees?.[ticket.id] ?? []).includes(who);
      if (assigned || principalOf(ticket.id, who) || ticketOrphans.has(ticket.id)) ticketIds.add(ticket.id);
    }
    for (const ticket of options.tickets) {
      if (!ticketIds.has(ticket.id)) continue;
      const principal = principalOf(ticket.id, who);
      if (principal !== undefined && isClosed(who, principal)) {
        // O ticket cuja conversa foi fechada some da barra, mesmo com a pessoa responsável; as de dentro que continuam abertas ficam sob ele, sem id.
        const rising = kidsOf(who, principal);
        if (rising.length + (ticketOrphans.get(ticket.id)?.length ?? 0) === 0) continue;
        items.push(nodeOf(who, null, { kind: "ticket", ticket }, [...rising, ...(ticketOrphans.get(ticket.id) ?? [])]));
        continue;
      }
      items.push(nodeOf(who, principal ?? null, { kind: "ticket", ticket }, ticketOrphans.get(ticket.id) ?? []));
    }
    // Ordem: o chat geral primeiro; os tickets pela atividade mais recente.
    const [first, ...rest] = items;
    rest.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    return [first!, ...rest];
  };

  const pageOf = (who: string, entry: StoredConversation, query: { limit?: number; before?: string }): ApiResult<{ items: ChatMessage[]; nextBefore: string | null }> => {
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failed("invalid", "validation_error");
    let list = [...entry.messages].sort((a, b) => b.seq - a.seq);
    if (query.before !== undefined) {
      const before = seqOf(query.before);
      if (before === null) return failed("invalid", "invalid_cursor");
      list = list.filter((message) => message.seq < before);
    }
    const items = list.slice(0, limit);
    return ok({ items: items.map((message) => toMessage(who, entry, message)), nextBefore: list.length > limit ? cursorOf(items.at(-1)!.seq) : null });
  };

  const viewOf = (who: string, entry: StoredConversation | null, ticket: FakeChatTicket | null, query: { limit?: number; before?: string }): ApiResult<ConversationView> => {
    const page = entry === null ? ok({ items: [] as ChatMessage[], nextBefore: null }) : pageOf(who, entry, query);
    if (!page.ok) return page;
    const read = entry === null ? 0 : readSeq(who, entry.id);
    let threads: StoredConversation[] = entry === null ? [] : kidsOf(who, entry);
    if (entry === null || entry.kind === "ticket") {
      // Na leitura do ticket, também as threads em que a pessoa entrou sem ver a de cima.
      const extra = ticket === null ? [] : all().filter((other) => other.kind === "thread" && other.ticketId === ticket.id && sees(who, other) && !sees(who, conversations.get(other.parentId!)!));
      threads = [...threads, ...extra];
    }
    const trail = entry === null ? [] : trailOf(who, entry);
    const levels = trail.length + 1;
    const view: ConversationView = {
      conversation:
        entry === null
          ? null
          : {
              id: entry.id,
              kind: entry.kind,
              purpose: entry.purpose,
              title: entry.title,
              creation: entry.creation ?? null,
              ownedByMe: entry.ownerId === who,
              closed: isClosed(who, entry),
              participants: entry.participants.map((id) => person(id)!),
              canAddParticipants: entry.kind === "thread" && entry.purpose === "people" && entry.ownerId === who,
              canOpenThread: levels < MAX_LEVELS,
              openingMessageId: entry.kind === "thread" ? `m${entry.messages[0]!.seq}` : null,
              opening: entry.kind === "thread" ? cardOf(who, entry).opening : null,
              replyCount: entry.kind === "thread" ? entry.messages.length - 1 : entry.messages.length,
              lastActivityAt: at(lastSeq(entry)),
              trail,
            },
      ticket: ticket === null ? null : { id: ticket.id, key: ticket.key, title: ticket.title, projectId: ticket.projectId ?? "p1", archived: ticket.archived === true, status: ticket.status ?? "todo", blocked: ticket.blocked === true },
      assignedToMe: ticket !== null && ((ticket.assignedToMe === true && who === defaultMe) || (options.assignees?.[ticket.id] ?? []).includes(who)),
      lastRead: read === 0 ? null : cursorOf(read),
      unread: entry === null ? 0 : unreadIn(who, entry),
      messages: page.data,
      threads: threads.sort((a, b) => lastSeq(b) - lastSeq(a)).map((thread) => cardOf(who, thread)),
    };
    return ok(conversationViewSchema.parse(JSON.parse(JSON.stringify(view))));
  };
  const validBody = (body: unknown): body is string => typeof body === "string" && body.trim().length >= 1 && body.trim().length <= 4000;

  const openThread = (who: string, parent: StoredConversation, text: string, mentions: string[], ticketId: string | undefined): ApiResult<{ message: StoredMessage; thread: StoredConversation }> => {
    const levels = trailOf(who, parent).length + 1;
    if (levels >= MAX_LEVELS) return failed("unavailable", "max_depth");
    if (mentions.length > 10) return failed("unavailable", "too_many_mentions", { max: 10 });
    const ticket = parent.ticketId !== null ? ticketOf(parent.ticketId) : ticketId === undefined ? undefined : ticketOf(ticketId);
    if (ticketId !== undefined && parent.ticketId !== null && parent.ticketId !== ticketId) return failed("unavailable", "ticket_mismatch");
    const refused = mentions.filter((id) => !options.people.some((entry) => entry.id === id) || (ticket !== undefined && !canSeeTicket(ticket, id)));
    if (refused.length > 0) return failed("unavailable", "mention_not_allowed", { personIds: refused });
    const heritage = ticket === undefined ? [] : parent.participants.filter((id) => !canSeeTicket(ticket, id));
    if (heritage.length > 0) return failed("unavailable", "participant_cannot_view_ticket");
    const participants = [...new Set([...parent.participants, ...mentions])];
    if (participants.length > 25) return failed("unavailable", "thread_full");
    const message: StoredMessage = { seq: nextSeq(), authorId: who, body: text, model: null, opened: null };
    const thread = create({ kind: "thread", ticketId: ticket?.id ?? null, ownerId: who, parentId: parent.id, participants, messages: [message] });
    message.opened = thread.id;
    // A abertura mora na thread (primeira mensagem) e na conversa de cima (com o cartão): a mesma mensagem, duas leituras.
    parent.messages.push(message);
    return ok({ message, thread });
  };

  const self: FakeChat = {
    options,
    receiveThread(ticketId, { from, body, to = [defaultMe], replies = [] }) {
      const parent = ensurePrincipal(ticketId, from);
      return self.openThreadIn(parent.id, { from, body, to, replies });
    },
    openThreadIn(parentId, { from, body, to, replies = [], ticketId }) {
      const parent = conversations.get(parentId);
      if (!parent) throw new Error(`conversa desconhecida: ${parentId}`);
      const opened = openThread(from, parent, body, to, ticketId);
      if (!opened.ok) throw new Error(`falhou: ${opened.error.code}`);
      for (const reply of replies) opened.data.thread.messages.push({ seq: nextSeq(), authorId: reply.from, body: reply.body, model: null, opened: null });
      return opened.data.thread.id;
    },
    receiveReply(threadId, { from, body }) {
      const thread = conversations.get(threadId);
      if (!thread) throw new Error(`thread desconhecida: ${threadId}`);
      thread.messages.push({ seq: nextSeq(), authorId: from, body, model: null, opened: null });
    },
    setCreation(threadId, patch) {
      const thread = conversations.get(threadId);
      if (!thread?.creation) throw new Error(`thread de criação desconhecida: ${threadId}`);
      thread.creation = { ...thread.creation, ...patch };
    },
    creationOf: (threadId) => conversations.get(threadId)?.creation ?? null,
    seedConversation(ticketId, turns) {
      const entry = ensurePrincipal(ticketId, defaultMe);
      for (const turn of turns) {
        entry.messages.push({ seq: nextSeq(), authorId: defaultMe, body: turn.person, model: null, opened: null });
        entry.messages.push({ seq: nextSeq(), authorId: null, body: turn.assistant, model: "claude-opus-5-5", opened: null });
      }
      return entry.id;
    },
    seedGeneral(turns) {
      const entry = ensureGeneral(defaultMe);
      for (const turn of turns) {
        entry.messages.push({ seq: nextSeq(), authorId: defaultMe, body: turn.person, model: null, opened: null });
        entry.messages.push({ seq: nextSeq(), authorId: null, body: turn.assistant, model: "claude-opus-5-5", opened: null });
      }
      return entry.id;
    },
    seedTopic(parentId, { body, reply, title = null }) {
      const parent = conversations.get(parentId);
      if (!parent) throw new Error(`conversa desconhecida: ${parentId}`);
      const opening: StoredMessage = { seq: nextSeq(), authorId: defaultMe, body, model: null, opened: null };
      const thread = create({ kind: "thread", purpose: "topic", title, ticketId: parent.ticketId, ownerId: defaultMe, parentId, participants: [defaultMe], messages: [opening] });
      opening.opened = thread.id;
      parent.messages.push(opening);
      if (reply !== undefined) thread.messages.push({ seq: nextSeq(), authorId: null, body: reply, model: "claude-opus-5-5", opened: null });
      return thread.id;
    },
    readAll(conversationId) {
      for (const entry of all()) if (conversationId === undefined ? sees(defaultMe, entry) : entry.id === conversationId) lastRead.set(`${defaultMe}:${entry.id}`, lastSeq(entry));
    },
    closeFor(conversationId, personId = defaultMe) {
      const entry = conversations.get(conversationId);
      if (!entry) throw new Error(`conversa desconhecida: ${conversationId}`);
      for (const target of [entry, ...descendantsOf(entry).filter((child) => sees(personId, child))]) closedAt.set(`${personId}:${target.id}`, lastSeq(target));
    },
    isClosedFor: (conversationId, personId = defaultMe) => {
      const entry = conversations.get(conversationId);
      return entry !== undefined && isClosed(personId, entry);
    },
    conversationOf: (ticketId) => (principalOf(ticketId, defaultMe)?.messages ?? []).map((entry) => ({ authorId: entry.authorId, body: entry.body })),
    principalOf: (ticketId, who = defaultMe) => principalOf(ticketId, who)?.id,
    generalOf: (who = defaultMe) => generalOf(who)?.id,
    methods(who = defaultMe) {
      const known = (id: string) => {
        const entry = conversations.get(id);
        return entry && sees(who, entry) ? entry : undefined;
      };
      const sendInner = async (id: string, body: { body: string; mentions?: string[]; ticketId?: string; topic?: boolean; creation?: boolean; projectId?: string }): Promise<ApiResult<SendResult>> => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          if (!validBody(body.body)) return failed("invalid", "validation_error");
          const ticket = entry.ticketId === null ? undefined : ticketOf(entry.ticketId);
          if (ticket?.archived === true) return failed("conflict", "project_archived");
          const text = body.body.trim();
          const mentions = body.mentions ?? [];
          const creatable = options.creatable ?? { p1: "ALFA" };
          /** Abre a thread de criação (pedido direto ou pelo assistente): a abertura mora em cima, a conversa de novo ticket é a de `ticketConversationId`. */
          const openCreationThread = (projectId: string, request: string, openedBy: "person" | "assistant") => {
            const opening: StoredMessage = { seq: nextSeq(), authorId: who, body: text, model: null, opened: null };
            const thread = create({ kind: "thread", purpose: "creation", title: request.slice(0, 60), ticketId: entry.ticketId, ownerId: who, parentId: entry.id, participants: [who], messages: [opening] });
            thread.creation = { ticketConversationId: `tc-${thread.id}`, projectId, projectKey: creatable[projectId] ?? null, state: "draft", openedBy, ticket: null };
            opening.opened = thread.id;
            entry.messages.push(opening);
            return { opening, thread };
          };
          if (entry.purpose === "creation") return failed("invalid", "creation_thread");
          if (body.creation === true) {
            if (mentions.length > 0 || body.topic === true || body.ticketId !== undefined) return failed("invalid", "creation_with_other");
            if (entry.kind === "thread" && entry.purpose === "people") return failed("invalid", "creation_in_thread");
            if (options.assistant === "no_consent") return failed("forbidden", "assistant_consent_required");
            if (options.assistant === "not_configured") return failed("unavailable", "assistant_not_configured");
            const ids = Object.keys(creatable);
            const projectId = body.projectId ?? ticket?.projectId ?? (ids.length === 1 ? ids[0] : undefined);
            if (projectId === undefined) return failed("invalid", "project_required");
            if (!ids.includes(projectId)) return failed("invalid", "project_unavailable");
            if (ticket !== undefined && (ticket.projectId ?? "p1") !== projectId) return failed("invalid", "project_mismatch");
            const { opening, thread } = openCreationThread(projectId, text, "person");
            const sent = { kind: "creation" as const, message: toMessage(who, entry, opening), thread: cardOf(who, thread), reply: null, ticketConversationId: thread.creation!.ticketConversationId };
            return ok(sendResultSchema.parse(JSON.parse(JSON.stringify(sent))));
          }
          if (body.topic === true) {
            if (mentions.length > 0) return failed("unavailable", "topic_with_mentions");
            if (body.ticketId !== undefined) return failed("unavailable", "topic_with_ticket");
            if (entry.kind === "thread") return failed("unavailable", "topic_in_thread");
            if (options.assistant === "no_consent") return failed("forbidden", "assistant_consent_required");
            if (options.assistant === "not_configured") return failed("unavailable", "assistant_not_configured");
            // O assistente pode abrir um rascunho já na primeira mensagem do assunto (`open_ticket_draft`): o servidor responde `creation`.
            const draftRequest = options.assistantOpens?.(text) ?? null;
            const draftProject = body.projectId ?? ticket?.projectId ?? (Object.keys(creatable).length === 1 ? Object.keys(creatable)[0] : undefined);
            if (draftRequest !== null && draftProject !== undefined && draftProject in creatable) {
              const { opening, thread } = openCreationThread(draftProject, draftRequest, "assistant");
              const fixed: StoredMessage = { seq: nextSeq(), authorId: null, body: "Abri um rascunho de ticket (reserva).", model: "claude-opus-5-5", opened: null, marker: "creation_opened" };
              entry.messages.push(fixed);
              const sent = { kind: "creation" as const, message: toMessage(who, entry, opening), thread: cardOf(who, thread), reply: toMessage(who, entry, fixed), ticketConversationId: thread.creation!.ticketConversationId };
              return ok(sendResultSchema.parse(JSON.parse(JSON.stringify(sent))));
            }
            const opening: StoredMessage = { seq: nextSeq(), authorId: who, body: text, model: null, opened: null };
            const thread = create({ kind: "thread", purpose: "topic", title: options.topicTitle?.(text) ?? null, ticketId: entry.ticketId, ownerId: who, parentId: entry.id, participants: [who], messages: [opening] });
            opening.opened = thread.id;
            entry.messages.push(opening);
            const answer: StoredMessage = { seq: nextSeq(), authorId: null, body: options.reply?.(text) ?? "Resposta do assistente.", model: "claude-opus-5-5", opened: null };
            thread.messages.push(answer);
            const sent = { kind: "topic" as const, message: toMessage(who, entry, opening), thread: cardOf(who, thread), reply: toMessage(who, thread, answer) };
            return ok(sendResultSchema.parse(JSON.parse(JSON.stringify(sent))));
          }
          const others = [...new Set(mentions)].filter((personId) => personId !== who);
          const speaks = entry.kind !== "thread" || entry.purpose === "topic";
          if (mentions.length > 0 && others.length === 0 && speaks) return failed("invalid", "assistant_mention_self");
          if (mentions.length > 0 && others.some((personId) => !entry.participants.includes(personId))) {
            const opened = openThread(who, entry, text, others, body.ticketId);
            if (!opened.ok) return opened;
            const sent = { kind: "thread" as const, message: toMessage(who, entry, opened.data.message), thread: cardOf(who, opened.data.thread) };
            return ok(sendResultSchema.parse(JSON.parse(JSON.stringify(sent))));
          }
          if (entry.kind === "thread" && entry.purpose !== "topic") {
            // Mensagem comum (inclusive a que marca só quem já participa): nenhuma thread nasce.
            const message: StoredMessage = { seq: nextSeq(), authorId: who, body: text, model: null, opened: null };
            entry.messages.push(message);
            return ok(sendResultSchema.parse({ kind: "message", message: toMessage(who, entry, message) }));
          }
          if (options.assistant === "no_consent") return failed("forbidden", "assistant_consent_required");
          if (options.assistant === "not_configured") return failed("unavailable", "assistant_not_configured");
          const request = options.assistantOpens?.(text) ?? null;
          const projectOf = body.projectId ?? ticket?.projectId ?? (Object.keys(creatable).length === 1 ? Object.keys(creatable)[0] : undefined);
          if (request !== null && projectOf !== undefined && projectOf in creatable) {
            const { opening, thread } = openCreationThread(projectOf, request, "assistant");
            const fixed: StoredMessage = { seq: nextSeq(), authorId: null, body: "Abri um rascunho de ticket (reserva).", model: "claude-opus-5-5", opened: null, marker: "creation_opened" };
            entry.messages.push(fixed);
            const sent = { kind: "creation" as const, message: toMessage(who, entry, opening), thread: cardOf(who, thread), reply: toMessage(who, entry, fixed), ticketConversationId: thread.creation!.ticketConversationId };
            return ok(sendResultSchema.parse(JSON.parse(JSON.stringify(sent))));
          }
          const sent: StoredMessage = { seq: nextSeq(), authorId: who, body: text, model: null, opened: null };
          const answer: StoredMessage = { seq: nextSeq(), authorId: null, body: options.reply?.(text) ?? "Resposta do assistente.", model: "claude-opus-5-5", opened: null };
          entry.messages.push(sent, answer);
          return ok(sendResultSchema.parse({ kind: "assistant", message: toMessage(who, entry, sent), reply: toMessage(who, entry, answer) }));
      };
      return {
        listConversationTree: vi.fn(async () => ok(conversationTreeSchema.parse({ items: buildTree(who) }))),
        getConversationView: vi.fn(async (id: string, query: { limit?: number; before?: string } = {}) => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          return viewOf(who, entry, entry.ticketId === null ? null : (ticketOf(entry.ticketId) ?? null), query);
        }),
        getTicketConversationView: vi.fn(async (ticketId: string, query: { limit?: number; before?: string } = {}) => {
          const ticket = ticketOf(ticketId);
          if (!ticket || !canSeeTicket(ticket, who)) return failed("not_found", "not_found");
          return viewOf(who, principalOf(ticketId, who) ?? null, ticket, query);
        }),
        openTicketConversation: vi.fn(async (ticketId: string) => {
          const ticket = ticketOf(ticketId);
          if (!ticket || !canSeeTicket(ticket, who)) return failed("not_found", "not_found");
          return ok({ id: ensurePrincipal(ticketId, who).id });
        }),
        openGeneralConversation: vi.fn(async () => ok({ id: ensureGeneral(who).id })),
        sendChatMessage: vi.fn(async (id: string, body: { body: string; mentions?: string[]; ticketId?: string; topic?: boolean; creation?: boolean; projectId?: string }): Promise<ApiResult<SendResult>> => {
          const result = await sendInner(id, body);
          // Quem escreve numa conversa a reabre para si (ADR 0059).
          if (result.ok) closedAt.delete(`${who}:${id}`);
          return result;
        }),
        closeConversation: vi.fn(async (id: string) => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          if (entry.kind === "general") return failed("invalid", "cannot_close_general");
          // Como o servidor: só fecha (e só devolve) o que ainda não estava fechado para a pessoa.
          const targets = [entry, ...descendantsOf(entry).filter((child) => sees(who, child))].filter((target) => !isClosed(who, target));
          for (const target of targets) closedAt.set(`${who}:${target.id}`, lastSeq(target));
          return ok(closedResultSchema.parse({ closed: true, closedIds: targets.map((target) => target.id) }));
        }),
        reopenConversation: vi.fn(async (id: string) => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          closedAt.delete(`${who}:${id}`);
          return ok(reopenedResultSchema.parse({ closed: false }));
        }),
        listClosedConversations: vi.fn(async () => {
          const items = all()
            .filter((entry) => sees(who, entry) && isClosed(who, entry))
            .sort((x, y) => lastSeq(y) - lastSeq(x))
            .map((entry) => ({ ...nodeOf(who, entry, { kind: entry.kind, ticket: entry.ticketId === null ? null : (ticketOf(entry.ticketId) ?? null) }), children: [], closed: true }));
          return ok(conversationTreeSchema.parse({ items }));
        }),
        addConversationParticipants: vi.fn(async (id: string, personIds: string[]) => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          if (entry.kind !== "thread") return failed("unavailable", "principal_conversation");
          if (entry.purpose === "topic") return failed("unavailable", "private_thread");
          if (entry.ownerId !== who) return failed("forbidden", "not_thread_owner");
          const ticket = entry.ticketId === null ? undefined : ticketOf(entry.ticketId);
          const refused = personIds.filter((personId) => !options.people.some((entry) => entry.id === personId) || (ticket !== undefined && !canSeeTicket(ticket, personId)));
          if (refused.length > 0) return failed("unavailable", "mention_not_allowed", { personIds: refused });
          const added = personIds.filter((personId) => !entry.participants.includes(personId));
          if (entry.participants.length + added.length > 25) return failed("unavailable", "thread_full");
          const stack = [entry];
          while (stack.length > 0) {
            const next = stack.pop()!;
            next.participants.push(...added.filter((personId) => !next.participants.includes(personId)));
            stack.push(...all().filter((child) => child.parentId === next.id));
          }
          return ok({ participants: entry.participants.map((personId) => person(personId)!) });
        }),
        markConversationRead: vi.fn(async (id: string, body: { upTo?: string } = {}) => {
          const entry = known(id);
          if (!entry) return failed("not_found", "not_found");
          const newest = lastSeq(entry);
          let target = newest;
          if (body.upTo !== undefined) {
            const upTo = seqOf(body.upTo);
            if (upTo === null) return failed("invalid", "invalid_cursor");
            target = Math.min(upTo, newest);
          }
          lastRead.set(`${who}:${entry.id}`, Math.max(readSeq(who, entry.id), target));
          const read = readSeq(who, entry.id);
          return ok({ lastRead: read === 0 ? null : cursorOf(read), unread: unreadIn(who, entry) });
        }),
        clearConversationMessages: vi.fn(async (id: string) => {
          const entry = known(id);
          if (!entry || entry.ownerId !== who) return failed("not_found", "not_found");
          if (entry.kind === "thread") return failed("unavailable", "not_principal");
          entry.messages = entry.messages.filter((message) => message.opened !== null);
          return ok(undefined);
        }),
      };
    },
  };
  return self;
}
