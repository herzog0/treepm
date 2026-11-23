import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CHAT_ASSISTANT_PER_PERSON_PER_MINUTE, CHAT_MAX_MENTIONS, CHAT_MAX_THREAD_PARTICIPANTS, CHAT_THREAD_PER_PERSON_PER_MINUTE, canReadChatMessage, trimChatHistory } from "@treepm/domain";
import type { Actor } from "@treepm/domain";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { RateLimiter } from "../access-tokens/rate-limiter.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { decodeChatCursor, encodeChatCursor } from "./chat-cursor.js";
import { readEffectivePriorities } from "../tickets/ticket-priority.read.js";
import { MAX_TREE_DEPTH, scopeOf } from "../tickets/ticket-scope.js";
import type { ProjectRow } from "../tickets/tickets.service.js";
import type { ChatTicketContext, ChatTicketRef } from "./ports.js";
import {
  chatListSchema,
  chatViewSchema,
  readResultSchema,
  replyResultSchema,
  threadViewSchema,
} from "./chat.schema.js";
import type { ChatList, ChatMessage, ChatView, PageQuery, ThreadSummary, ThreadView } from "./chat.schema.js";

/** Quantos filhos e dependências do ticket vão ao provedor, no máximo (ADR 0049: o contexto tem teto). */
export const CHAT_CONTEXT_MAX_RELATED = 50;
/** Quantos ancestrais (os mais próximos) vão ao provedor. */
export const CHAT_CONTEXT_MAX_PATH = 50;
/** Teto da lista "Meus chats" e das threads de um ticket numa leitura. */
export const CHAT_LIST_MAX = 100;
const THREADS_PER_VIEW_MAX = 100;
const HISTORY_FETCH = 60;
const WINDOW_MS = 60_000;
const ALL_READ = 1n << 62n;
/** Uma vez reservada, a vez do assistente vence sozinha depois disto (o prazo do provedor é 60 s). */
const TURN_TTL_MS = 120_000;

type PersonRef = { id: string; displayName: string; avatarUrl: string | null };
type MessageRow = {
  id: string;
  seq: bigint;
  authorPersonId: string | null;
  body: string;
  model: string | null;
  createdAt: Date;
  threadId: string | null;
};
type Ticket = { id: string; projectId: string; number: number; title: string; description: string; status: string; parentId: string | null };
export type Visible = { project: ProjectRow; ticket: Ticket };

/** O que a primeira transação da mensagem ao assistente leu: o que vai ao provedor e o que conferir na volta. */
export type AssistantPrep = { context: ChatTicketContext; history: { author: "person" | "assistant"; body: string }[]; seenLastSeq: number };

const apiError = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new HttpException({ code, message, ...(details ? { details } : {}) }, status);

/**
 * Chat de trabalho por ticket (ADR 0049). A regra de quem lê o quê é UMA só (`canReadChatMessage` de @treepm/domain) e as
 * leituras são montadas para respeitá-la já na consulta: a conversa com o assistente só é lida pelo chat da própria pessoa
 * (`chatId` do chat DELA), a mensagem de thread só por quem consta em `ticket_chat_thread_members`. Nenhum papel entra nisso.
 * Nada aqui grava atividade nem toca a versão do projeto ou a trava de estrutura (ADR 0045 e 0046): o chat não é estrutura.
 * O conteúdo das mensagens nunca vai para log.
 */
@Injectable()
export class ChatService {
  private readonly limiter: RateLimiter;
  private readonly threadLimiter: RateLimiter;

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ACCESS_TOKEN_CLOCK) clock: AccessTokenClock,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.limiter = new RateLimiter(clock, CHAT_ASSISTANT_PER_PERSON_PER_MINUTE, WINDOW_MS);
    this.threadLimiter = new RateLimiter(clock, CHAT_THREAD_PER_PERSON_PER_MINUTE, WINDOW_MS);
  }

  private cursor(orgId: string, seq: bigint): string {
    return encodeChatCursor(this.config.CLERK_SECRET_KEY, orgId, seq);
  }

  /** O `seq` de um cursor recebido; cursor que não é desta API e organização é 400 `invalid_cursor`. */
  private seqOf(principal: Principal, cursor: string): bigint {
    const seq = decodeChatCursor(this.config.CLERK_SECRET_KEY, principal.organization.orgId, cursor);
    if (seq === null) throw new BadRequestException({ code: "invalid_cursor", message: "Cursor inválido." });
    return seq;
  }

  // ---- acesso ---------------------------------------------------------------------------------------------

  /** Quem enxerga o ticket abre o chat; inexistente, de outra organização (RLS) ou de projeto invisível: o mesmo 404. */
  async visible(tx: TenantClient, principal: Principal, ticketId: string): Promise<Visible> {
    const ticket = await tx.ticket.findFirst({
      where: { id: ticketId },
      select: { id: true, projectId: true, number: true, title: true, description: true, status: true, parentId: true },
    });
    const project = ticket ? await tx.project.findFirst({ where: { id: ticket.projectId } }) : null;
    if (!ticket || !project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  private writable({ project }: Visible): void {
    if (project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
  }

  // ---- leituras -------------------------------------------------------------------------------------------

  /** "Meus chats": os chats da pessoa e os tickets de que ela é responsável, dos projetos que ela enxerga. */
  async list(tx: TenantClient, principal: Principal): Promise<ChatList> {
    const me = principal.person.id;
    const projects = await tx.project.findMany({ select: { id: true, visibility: true } });
    const projectIds = projects.filter((p) => this.authorization.canView(principal.actor, p)).map((p) => p.id);
    if (projectIds.length === 0) return parseOutput(chatListSchema, { items: [] });
    const chats = await tx.ticketChat.findMany({
      where: { personId: me, projectId: { in: projectIds } },
      orderBy: { lastActivityAt: "desc" },
      take: CHAT_LIST_MAX,
      select: { id: true, ticketId: true, projectId: true, lastReadSeq: true, lastActivityAt: true },
    });
    const withChat = new Set(chats.map((c) => c.ticketId));
    const assigned = await tx.ticketAssignee.findMany({
      where: { personId: me, ticket: { projectId: { in: projectIds } } },
      orderBy: { createdAt: "desc" },
      take: CHAT_LIST_MAX,
      select: { ticketId: true, createdAt: true, ticket: { select: { projectId: true } } },
    });
    const assignedIds = new Set(assigned.map((a) => a.ticketId));
    const ticketIds = [...new Set([...chats.map((c) => c.ticketId), ...assigned.map((a) => a.ticketId)])];
    const tickets = await tx.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, number: true, title: true, projectId: true, project: { select: { key: true } } } });
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const unread = await this.unreadByChat(tx, me, chats);
    const rows = [
      ...chats.map((c) => ({ ticketId: c.ticketId, chatId: c.id, at: c.lastActivityAt, unread: unread.get(c.id) ?? 0 })),
      ...assigned.filter((a) => !withChat.has(a.ticketId)).map((a) => ({ ticketId: a.ticketId, chatId: null, at: a.createdAt, unread: 0 })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, CHAT_LIST_MAX);
    const items = rows.flatMap((row) => {
      const t = byId.get(row.ticketId);
      if (!t) return [];
      return [{ ticketId: t.id, ticketKey: `${t.project.key}-${t.number}`, title: t.title, projectId: t.projectId, chatId: row.chatId, assignedToMe: assignedIds.has(t.id), lastActivityAt: row.at.toISOString(), unread: row.unread }];
    });
    return parseOutput(chatListSchema, { items });
  }

  /** O chat da pessoa neste ticket: a conversa com o assistente (paginada) e as threads de que ela participa. */
  async view(tx: TenantClient, principal: Principal, ticketId: string, page: PageQuery): Promise<ChatView> {
    const me = principal.person.id;
    const seen = await this.visible(tx, principal, ticketId);
    const chat = await tx.ticketChat.findFirst({ where: { ticketId, personId: me }, select: { id: true, personId: true, lastReadSeq: true } });
    const memberships = await tx.ticketChatThreadMember.findMany({ where: { ticketId, personId: me }, select: { threadId: true } });
    const myThreads = new Set(memberships.map((m) => m.threadId));
    const rows = chat
      ? await tx.ticketChatMessage.findMany({
          where: { chatId: chat.id, ...(page.before ? { seq: { lt: this.seqOf(principal, page.before) } } : {}) },
          orderBy: { seq: "desc" },
          take: page.limit + 1,
          select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true },
        })
      : [];
    const allowed = rows.filter((row) => canReadChatMessage(me, { chatOwnerPersonId: chat?.personId ?? null, threadId: row.threadId }, myThreads));
    const items = allowed.slice(0, page.limit);
    const people = await this.people(tx, items.map((r) => r.authorPersonId));
    const threads = await this.threadSummaries(tx, principal, ticketId, [...myThreads].slice(0, THREADS_PER_VIEW_MAX), chat?.lastReadSeq ?? 0n);
    const unread = chat ? ((await this.unreadByChat(tx, me, [{ id: chat.id, ticketId, lastReadSeq: chat.lastReadSeq }])).get(chat.id) ?? 0) : 0;
    const assigned = (await tx.ticketAssignee.count({ where: { ticketId, personId: me } })) > 0;
    return parseOutput(chatViewSchema, {
      ticket: this.ticketRef(seen),
      chatId: chat?.id ?? null,
      assignedToMe: assigned,
      lastRead: chat && chat.lastReadSeq > 0n ? this.cursor(principal.organization.orgId, chat.lastReadSeq) : null,
      unread,
      messages: { items: items.map((r) => this.message(r, people, principal, chat?.lastReadSeq ?? 0n)), nextBefore: allowed.length > page.limit && items.length > 0 ? this.cursor(principal.organization.orgId, items[items.length - 1]!.seq) : null },
      threads,
    });
  }

  /** Uma thread, só para quem participa dela e ainda enxerga o ticket; as respostas, as mais recentes primeiro. */
  async thread(tx: TenantClient, principal: Principal, threadId: string, page: PageQuery): Promise<ThreadView> {
    const { seen, root } = await this.openThread(tx, principal, threadId);
    const me = principal.person.id;
    const chat = await tx.ticketChat.findFirst({ where: { ticketId: root.ticketId, personId: me }, select: { lastReadSeq: true } });
    const rows = await tx.ticketChatMessage.findMany({
      where: { threadId, id: { not: threadId }, ...(page.before ? { seq: { lt: this.seqOf(principal, page.before) } } : {}) },
      orderBy: { seq: "desc" },
      take: page.limit + 1,
      select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true },
    });
    const items = rows.slice(0, page.limit);
    const people = await this.people(tx, items.map((r) => r.authorPersonId));
    const [summary] = await this.threadSummaries(tx, principal, root.ticketId, [threadId], chat?.lastReadSeq ?? 0n);
    return parseOutput(threadViewSchema, {
      ticket: this.ticketRef(seen),
      thread: summary,
      replies: { items: items.map((r) => this.message(r, people, principal, chat?.lastReadSeq ?? 0n)), nextBefore: rows.length > page.limit && items.length > 0 ? this.cursor(principal.organization.orgId, items[items.length - 1]!.seq) : null },
    });
  }

  // ---- mensagem ao assistente -----------------------------------------------------------------------------

  /** Primeira transação: confere o acesso, lê o contexto do ticket e a conversa DA PRÓPRIA PESSOA, e monta o que vai ao provedor. */
  async prepareAssistantTurn(tx: TenantClient, principal: Principal, ticketId: string, body: string): Promise<AssistantPrep> {
    const me = principal.person.id;
    const seen = await this.visible(tx, principal, ticketId);
    this.writable(seen);
    this.requireAssistantQuota(principal);
    const chat = await this.ensureChat(tx, seen, me);
    // Reserva a vez ANTES de chamar o provedor: uma conversa por vez por chat. A segunda requisição recebe o conflito sem gastar IA.
    const claimed = await tx.ticketChat.updateMany({
      where: { id: chat.id, OR: [{ turnStartedAt: null }, { turnStartedAt: { lt: new Date(Date.now() - TURN_TTL_MS) } }] },
      data: { turnStartedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException({ code: "chat_busy", message: "O assistente ainda está respondendo à mensagem anterior. Espere a resposta." });
    const previous = await tx.ticketChatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { seq: "desc" },
      take: HISTORY_FETCH,
      select: { seq: true, authorPersonId: true, body: true },
    });
    const history = trimChatHistory([
      ...previous.reverse().map((m) => ({ author: m.authorPersonId === null ? ("assistant" as const) : ("person" as const), body: m.body })),
      { author: "person" as const, body },
    ]);
    const seenLastSeq = previous.length > 0 ? Math.max(...previous.map((m) => Number(m.seq))) : 0;
    return { context: await this.context(tx, seen), history, seenLastSeq };
  }

  /** Solta a vez do assistente (provedor falhou ou a gravação não ocorreu). */
  async releaseTurn(tx: TenantClient, principal: Principal, ticketId: string): Promise<void> {
    await tx.ticketChat.updateMany({ where: { ticketId, personId: principal.person.id }, data: { turnStartedAt: null } });
  }

  /** Mensagens de thread por pessoa por minuto (abrir e responder), separado do limite do assistente. */
  private requireThreadQuota(principal: Principal): void {
    const hit = this.threadLimiter.hit(`${principal.organization.orgId}:${principal.person.id}`);
    if (!hit.allowed) {
      const seconds = Math.max(1, Math.ceil(hit.retryAfterMs / 1000));
      throw apiError(HttpStatus.TOO_MANY_REQUESTS, "chat_thread_rate_limited", `Muitas mensagens em threads. Tente de novo em ${seconds} s.`, { retryAfterSeconds: seconds });
    }
  }

  /** Um pedido ao assistente por pessoa por minuto: acima do teto, 429 claro. Em memória do processo, como o do MCP. */
  requireAssistantQuota(principal: Principal): void {
    const hit = this.limiter.hit(`${principal.organization.orgId}:${principal.person.id}`);
    if (!hit.allowed) {
      const seconds = Math.max(1, Math.ceil(hit.retryAfterMs / 1000));
      throw apiError(HttpStatus.TOO_MANY_REQUESTS, "chat_rate_limited", `Muitas mensagens ao assistente. Tente de novo em ${seconds} s.`, { retryAfterSeconds: seconds });
    }
  }

  /** Segunda transação: confere tudo de novo e grava a mensagem da pessoa e a resposta, nesta ordem. */
  async recordAssistantTurn(tx: TenantClient, principal: Principal, ticketId: string, body: string, reply: { message: string; model: string }, seenLastSeq: number) {
    const me = principal.person.id;
    const seen = await this.visible(tx, principal, ticketId);
    this.writable(seen);
    const chat = await this.ensureChat(tx, seen, me);
    await tx.$queryRaw`select 1 from ticket_chats where id = ${chat.id}::uuid for update`; // serializa turnos concorrentes da mesma pessoa
    const last = await tx.ticketChatMessage.aggregate({ where: { chatId: chat.id }, _max: { seq: true } });
    if (Number(last._max.seq ?? 0n) !== seenLastSeq) {
      throw new ConflictException({ code: "chat_changed", message: "A conversa mudou enquanto o assistente respondia. Recarregue e envie de novo." });
    }
    const base = { orgId: seen.project.orgId, projectId: seen.project.id, ticketId, chatId: chat.id };
    const person = await tx.ticketChatMessage.create({ data: { ...base, authorPersonId: me, body }, select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true } });
    const assistant = await tx.ticketChatMessage.create({ data: { ...base, body: reply.message, model: reply.model }, select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true } });
    await tx.ticketChat.updateMany({ where: { id: chat.id }, data: { lastActivityAt: assistant.createdAt, turnStartedAt: null } });
    const people = await this.people(tx, [me]);
    return { message: this.message(person, people, principal, ALL_READ), reply: this.message(assistant, people, principal, ALL_READ) };
  }

  // ---- threads --------------------------------------------------------------------------------------------

  /** Mensagem com menção: não vai ao assistente; vira a raiz de uma thread, com quem a abriu e os mencionados como participantes. */
  async startThread(tx: TenantClient, principal: Principal, ticketId: string, body: string, mentions: readonly string[]): Promise<ThreadSummary> {
    const me = principal.person.id;
    const seen = await this.visible(tx, principal, ticketId);
    this.writable(seen);
    const mentioned = await this.resolveMentions(tx, principal, seen.project, mentions);
    this.requireThreadQuota(principal);
    const id = randomUUID();
    const root = await tx.ticketChatMessage.create({
      data: { orgId: seen.project.orgId, id, projectId: seen.project.id, ticketId, threadId: id, authorPersonId: me, body },
      select: { id: true, createdAt: true },
    });
    await this.addMembers(tx, seen, id, [me, ...mentioned], root.createdAt);
    const [summary] = await this.threadSummaries(tx, principal, ticketId, [id], (await tx.ticketChat.findFirst({ where: { ticketId, personId: me }, select: { lastReadSeq: true } }))?.lastReadSeq ?? 0n);
    return summary as ThreadSummary;
  }

  /** Responder numa thread: só participante, e só enquanto enxerga o ticket. A resposta pode mencionar mais gente. */
  async replyInThread(tx: TenantClient, principal: Principal, threadId: string, body: string, mentions: readonly string[]) {
    const me = principal.person.id;
    const { seen, root } = await this.openThread(tx, principal, threadId);
    this.writable(seen);
    const mentioned = await this.resolveMentions(tx, principal, seen.project, mentions);
    this.requireThreadQuota(principal);
    const created = await tx.ticketChatMessage.create({
      data: { orgId: seen.project.orgId, projectId: seen.project.id, ticketId: root.ticketId, threadId, authorPersonId: me, body },
      select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true },
    });
    await this.addMembers(tx, seen, threadId, mentioned, created.createdAt, true);
    const people = await this.people(tx, [me]);
    const [summary] = await this.threadSummaries(tx, principal, root.ticketId, [threadId], (await tx.ticketChat.findFirst({ where: { ticketId: root.ticketId, personId: me }, select: { lastReadSeq: true } }))?.lastReadSeq ?? 0n);
    return parseOutput(replyResultSchema, { message: this.message(created, people, principal, ALL_READ), thread: summary });
  }

  // ---- leitura e limpeza ----------------------------------------------------------------------------------

  async markRead(tx: TenantClient, principal: Principal, ticketId: string, upTo: string | undefined) {
    const me = principal.person.id;
    await this.visible(tx, principal, ticketId);
    const chat = await tx.ticketChat.findFirst({ where: { ticketId, personId: me }, select: { id: true, lastReadSeq: true } });
    if (!chat) return parseOutput(readResultSchema, { lastRead: null, unread: 0 });
    // Sem `upToSeq`: até a mensagem mais nova que ELA pode ler (a conversa e as threads de que participa), nunca além.
    // Nunca além do mais novo que ela pode ler: um cursor à frente não marca como lida mensagem que ainda vai chegar.
    const newest = await this.newestReadable(tx, me, ticketId, chat.id);
    const asked = upTo === undefined ? newest : this.seqOf(principal, upTo);
    const target = asked < newest ? asked : newest;
    if (target > chat.lastReadSeq) await tx.ticketChat.updateMany({ where: { id: chat.id, lastReadSeq: { lt: target } }, data: { lastReadSeq: target } });
    const now = await tx.ticketChat.findFirstOrThrow({ where: { id: chat.id }, select: { id: true, lastReadSeq: true } });
    const unread = (await this.unreadByChat(tx, me, [{ id: now.id, ticketId, lastReadSeq: now.lastReadSeq }])).get(now.id) ?? 0;
    return parseOutput(readResultSchema, { lastRead: now.lastReadSeq > 0n ? this.cursor(principal.organization.orgId, now.lastReadSeq) : null, unread });
  }

  /** Apaga a conversa da pessoa com o assistente. As threads (de que outras pessoas também participam) ficam como estão. */
  async clear(tx: TenantClient, principal: Principal, ticketId: string): Promise<void> {
    // A pessoa sempre apaga a própria conversa, mesmo sem enxergar mais o ticket (não lê nada: só apaga o que é dela).
    const chat = await tx.ticketChat.findFirst({ where: { ticketId, personId: principal.person.id }, select: { id: true } });
    if (!chat) return;
    await tx.ticketChatMessage.deleteMany({ where: { chatId: chat.id, threadId: null } });
  }

  // ---- peças ----------------------------------------------------------------------------------------------

  private ticketRef({ project, ticket }: Visible) {
    return { id: ticket.id, key: `${project.key}-${ticket.number}`, title: ticket.title, projectId: project.id, archived: project.archivedAt !== null };
  }

  private message(row: MessageRow, people: Map<string, PersonRef>, principal: Principal, lastRead: bigint): ChatMessage {
    return {
      id: row.id,
      cursor: this.cursor(principal.organization.orgId, row.seq),
      unread: row.authorPersonId !== principal.person.id && row.seq > lastRead,
      authorKind: row.authorPersonId === null ? "assistant" : "person",
      author: row.authorPersonId === null ? null : (people.get(row.authorPersonId) ?? null),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      model: row.model,
      threadId: row.threadId,
    };
  }

  private async people(tx: TenantClient, ids: readonly (string | null)[]): Promise<Map<string, PersonRef>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await tx.person.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, avatarUrl: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** A thread, para quem participa dela e enxerga o ticket; qualquer outro caso é o mesmo 404. */
  private async openThread(tx: TenantClient, principal: Principal, threadId: string) {
    const member = await tx.ticketChatThreadMember.findUnique({ where: { orgId_threadId_personId: { orgId: principal.organization.orgId, threadId, personId: principal.person.id } }, select: { ticketId: true } });
    if (!member) throw new NotFoundException("Thread não encontrada.");
    const root = await tx.ticketChatMessage.findFirst({ where: { id: threadId, threadId }, select: { ticketId: true } });
    if (!root) throw new NotFoundException("Thread não encontrada.");
    let seen: Visible;
    try {
      seen = await this.visible(tx, principal, root.ticketId);
    } catch {
      throw new NotFoundException("Thread não encontrada.");
    }
    return { seen, root };
  }

  /** O resumo de cada thread pedida, na ordem da última mensagem (a mais nova primeiro). Só vai quem participa. */
  private async threadSummaries(tx: TenantClient, principal: Principal, ticketId: string, threadIds: readonly string[], lastRead: bigint): Promise<ThreadSummary[]> {
    if (threadIds.length === 0) return [];
    const me = principal.person.id;
    const roots = await tx.ticketChatMessage.findMany({ where: { id: { in: [...threadIds] }, threadId: { not: null }, ticketId }, select: { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true, threadId: true } });
    const stats = await tx.ticketChatMessage.groupBy({ by: ["threadId"], where: { threadId: { in: [...threadIds] } }, _count: { _all: true }, _max: { seq: true, createdAt: true } });
    const unread = await tx.ticketChatMessage.groupBy({ by: ["threadId"], where: { threadId: { in: [...threadIds] }, seq: { gt: lastRead }, authorPersonId: { not: me } }, _count: { _all: true } });
    const members = await tx.ticketChatThreadMember.findMany({ where: { threadId: { in: [...threadIds] } }, select: { threadId: true, personId: true }, orderBy: { addedAt: "asc" } });
    const people = await this.people(tx, [...roots.map((r) => r.authorPersonId), ...members.map((m) => m.personId)]);
    const out = roots.flatMap((root) => {
      const s = stats.find((x) => x.threadId === root.id);
      if (!s) return [];
      return [
        {
          id: root.id,
          ticketId,
          root: this.message(root, people, principal, lastRead),
          replyCount: Math.max(0, s._count._all - 1),
          lastMessageAt: (s._max.createdAt ?? root.createdAt).toISOString(),
          unread: unread.find((x) => x.threadId === root.id)?._count._all ?? 0,
          startedByMe: root.authorPersonId === me,
          participants: members.filter((m) => m.threadId === root.id).flatMap((m) => (people.get(m.personId) ? [people.get(m.personId) as PersonRef] : [])),
        },
      ];
    });
    const order = new Map(roots.map((r) => [r.id, stats.find((x) => x.threadId === r.id)?._max.seq ?? r.seq]));
    return out.sort((a, b) => Number((order.get(b.id) ?? 0n) - (order.get(a.id) ?? 0n)));
  }

  /** O chat da pessoa neste ticket; nasce na primeira necessidade. Duas criações ao mesmo tempo acabam no mesmo chat. */
  private async ensureChat(tx: TenantClient, { project, ticket }: Visible, personId: string): Promise<{ id: string }> {
    await tx.ticketChat.createMany({ data: [{ orgId: project.orgId, projectId: project.id, ticketId: ticket.id, personId }], skipDuplicates: true });
    return tx.ticketChat.findFirstOrThrow({ where: { ticketId: ticket.id, personId }, select: { id: true } });
  }

  /**
   * Quem pode ser mencionado: gente que enxerga o ticket (mencionar não concede acesso). Recusa a própria pessoa, mais gente que o
   * teto e quem não puder, SEM dizer nada além dos ids que a pessoa mesma mandou (inexistente, de outra organização, inativa e sem
   * acesso dão a mesma resposta).
   */
  private async resolveMentions(tx: TenantClient, principal: Principal, project: ProjectRow, raw: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(raw)];
    if (wanted.length === 0) return [];
    if (wanted.length > CHAT_MAX_MENTIONS) {
      throw new UnprocessableEntityException({ code: "too_many_mentions", message: `Mencione no máximo ${CHAT_MAX_MENTIONS} pessoas por mensagem.`, details: { max: CHAT_MAX_MENTIONS } });
    }
    if (wanted.includes(principal.person.id)) {
      throw new UnprocessableEntityException({ code: "cannot_mention_self", message: "Você não pode mencionar a si mesma." });
    }
    const people = await tx.person.findMany({ where: { id: { in: wanted }, active: true }, select: { id: true, clerkRole: true } });
    const ok = new Set<string>();
    for (const person of people) {
      const actor: Actor = await this.authorization.loadActor(tx, person.id, person.clerkRole);
      if (this.authorization.canView(actor, project)) ok.add(person.id);
    }
    const refused = wanted.filter((id) => !ok.has(id));
    if (refused.length > 0) {
      throw new UnprocessableEntityException({ code: "mention_not_allowed", message: "Só se pode mencionar quem enxerga este ticket.", details: { personIds: refused } });
    }
    return wanted;
  }

  /** Inclui participantes (quem já é não conta), dá a cada um o chat daquele ticket e registra a atividade em todos os chats. */
  private async addMembers(tx: TenantClient, seen: Visible, threadId: string, personIds: readonly string[], at: Date, onlyNew = false): Promise<void> {
    const { project, ticket } = seen;
    const existing = await tx.ticketChatThreadMember.findMany({ where: { threadId }, select: { personId: true } });
    const have = new Set(existing.map((m) => m.personId));
    const fresh = [...new Set(personIds)].filter((id) => !have.has(id));
    if (have.size + fresh.length > CHAT_MAX_THREAD_PARTICIPANTS) {
      throw new UnprocessableEntityException({ code: "thread_full", message: `Uma thread tem no máximo ${CHAT_MAX_THREAD_PARTICIPANTS} participantes.`, details: { max: CHAT_MAX_THREAD_PARTICIPANTS } });
    }
    if (fresh.length > 0) {
      await tx.ticketChatThreadMember.createMany({ data: fresh.map((personId) => ({ orgId: project.orgId, threadId, personId, projectId: project.id, ticketId: ticket.id })) });
    }
    const all = [...have, ...fresh];
    void onlyNew;
    await tx.ticketChat.createMany({ data: all.map((personId) => ({ orgId: project.orgId, projectId: project.id, ticketId: ticket.id, personId })), skipDuplicates: true });
    await tx.ticketChat.updateMany({ where: { ticketId: ticket.id, personId: { in: all } }, data: { lastActivityAt: at } });
  }

  /** A mensagem de maior `seq` que a pessoa pode ler neste ticket (a conversa dela e as threads de que participa). */
  private async newestReadable(tx: TenantClient, me: string, ticketId: string, chatId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ seq: bigint | null }[]>`
      select max(m.seq) as seq from ticket_chat_messages m
      where m.ticket_id = ${ticketId}::uuid and (
        m.chat_id = ${chatId}::uuid
        or m.thread_id in (select tm.thread_id from ticket_chat_thread_members tm where tm.ticket_id = ${ticketId}::uuid and tm.person_id = ${me}::uuid))`;
    return rows[0]?.seq ?? 0n;
  }

  /**
   * Não lidas por chat: respostas do assistente no chat da pessoa e mensagens de OUTRAS pessoas nas threads de que ela participa,
   * depois do ponto de leitura. Uma consulta, pelos índices do chat e dos participantes; não varre o projeto.
   */
  private async unreadByChat(tx: TenantClient, me: string, chats: readonly { id: string; ticketId: string; lastReadSeq: bigint }[]): Promise<Map<string, number>> {
    if (chats.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ chat_id: string; unread: number }[]>`
      select c.id as chat_id,
        ((select count(*) from ticket_chat_messages m
            where m.org_id = c.org_id and m.chat_id = c.id and m.seq > c.last_read_seq and m.author_person_id is null)
        + (select count(*) from ticket_chat_thread_members tm
            join ticket_chat_messages m on m.org_id = tm.org_id and m.thread_id = tm.thread_id
            where tm.org_id = c.org_id and tm.person_id = c.person_id and tm.ticket_id = c.ticket_id
              and m.seq > c.last_read_seq and m.author_person_id <> c.person_id))::int as unread
      from ticket_chats c
      where c.person_id = ${me}::uuid and c.id = any(${chats.map((c) => c.id)}::uuid[])`;
    return new Map(rows.map((r) => [r.chat_id, r.unread]));
  }

  // ---- o que vai ao provedor ----------------------------------------------------------------------------

  /**
   * O contexto do ticket para o assistente (ADR 0049), lido agora, com `select` explícito: título, descrição, situação, prioridade que
   * vale, caminho até a raiz, filhos e dependências (chave, título e situação). Nunca comentários, histórico, áreas, nota do marcador
   * de trabalho nem qualquer dado de pessoa; nenhum id sai daqui.
   */
  private async context(tx: TenantClient, { project, ticket }: Visible): Promise<ChatTicketContext> {
    const key = (number: number) => `${project.key}-${number}`;
    const ref = (t: { number: number; title: string; status: string }): ChatTicketRef => ({ key: key(t.number), title: t.title, status: t.status });
    const scope = scopeOf(project);
    const [priorities, ancestors, children, dependsOn, blocks] = await Promise.all([
      readEffectivePriorities(tx, scope, [ticket.id]),
      tx.$queryRaw<{ number: number; title: string }[]>`
        with recursive up as (
          select t.org_id, t.project_id, t.id, t.parent_id, t.number, t.title, 0 as depth
          from tickets t where t.org_id = ${scope.orgId} and t.project_id = ${scope.projectId}::uuid and t.id = ${ticket.id}::uuid
          union all
          select p.org_id, p.project_id, p.id, p.parent_id, p.number, p.title, up.depth + 1
          from tickets p join up on p.org_id = up.org_id and p.project_id = up.project_id and p.id = up.parent_id
          where up.depth < ${MAX_TREE_DEPTH}::int
        )
        select number, title from up where depth > 0 order by depth asc limit ${CHAT_CONTEXT_MAX_PATH}::int`,
      tx.ticket.findMany({ where: { parentId: ticket.id, projectId: project.id }, orderBy: { number: "asc" }, take: CHAT_CONTEXT_MAX_RELATED, select: { number: true, title: true, status: true } }),
      tx.ticketRelation.findMany({ where: { kind: "depends_on", fromTicketId: ticket.id }, orderBy: { createdAt: "asc" }, take: CHAT_CONTEXT_MAX_RELATED, select: { to: { select: { number: true, title: true, status: true } } } }),
      tx.ticketRelation.findMany({ where: { kind: "depends_on", toTicketId: ticket.id }, orderBy: { createdAt: "asc" }, take: CHAT_CONTEXT_MAX_RELATED, select: { from: { select: { number: true, title: true, status: true } } } }),
    ]);
    return {
      key: key(ticket.number),
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: priorities.get(ticket.id) ?? 0,
      // Do topo até o pai: a consulta devolve do pai para cima.
      path: [...ancestors].reverse().map((a) => ({ key: key(a.number), title: a.title })),
      children: children.map(ref),
      dependsOn: dependsOn.map((r) => ref(r.to)),
      blocks: blocks.map((r) => ref(r.from)),
    };
  }
}
