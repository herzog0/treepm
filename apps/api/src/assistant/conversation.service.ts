import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import {
  CHAT_ASSISTANT_PER_PERSON_PER_MINUTE,
  CHAT_MAX_MENTIONS,
  CHAT_THREAD_PER_PERSON_PER_MINUTE,
  CONVERSATION_MAX_PARTICIPANTS,
  assistantSpeaksIn,
  canOpenThreadBelow,
  chatTitleOf,
  creationTitleOf,
  hasForbiddenChatChars,
  mentionsOpenThread,
  newThreadParticipants,
  participantCountAfter,
  withoutPersonLinks,
  withoutPersonLinksDeep,
  shownTree,
  trimChatHistory,
} from "@treepm/domain";
import type { Actor, ConversationNode } from "@treepm/domain";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { RateLimiter } from "../access-tokens/rate-limiter.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { readEffectivePriorities } from "../tickets/ticket-priority.read.js";
import { MAX_TREE_DEPTH, scopeOf } from "../tickets/ticket-scope.js";
import type { ProjectRow } from "../tickets/tickets.service.js";
import { decodeChatCursor, encodeChatCursor } from "./chat-cursor.js";
import { ConversationAccess, notFound } from "./conversation-access.js";
import type { Resolved, Visible } from "./conversation-access.js";
import {
  conversationTreeSchema,
  closedResultSchema,
  conversationViewSchema,
  participantsResultSchema,
  reopenedResultSchema,
  readResultSchema,
  sendResultSchema,
} from "./conversation.schema.js";
import type { ChatMessage, ConversationNodeShape, ConversationTree, ConversationView, PageQuery, ThreadCard, creationSchema } from "./conversation.schema.js";
import { readDecisionSafely } from "./placement-decision.js";
import type { ChatTicketContext, ChatTicketRef, ConversationTurn, DraftToolState } from "./ports.js";
import { CREATION_OPENED_PREFIX, CREATION_OPENED_REPLY, creationOpenedBody } from "./prompts.js";
import { TicketDraftService, draftMarkOf } from "./ticket-draft.service.js";
import type { z } from "zod";

/** Quantos filhos e dependências do ticket vão ao provedor, no máximo (ADR 0049: o contexto tem teto). */
export const CHAT_CONTEXT_MAX_RELATED = 50;
/** Quantos ancestrais (os mais próximos) vão ao provedor. */
export const CHAT_CONTEXT_MAX_PATH = 50;
/** Teto de tickets na árvore da barra e de conversas carregadas numa leitura. */
export const CHAT_LIST_MAX = 100;
const TREE_MAX = 500;
/** Quantas conversas fechadas a lista "Fechadas" traz, no máximo, da mais recente para a mais antiga. */
export const CLOSED_LIST_MAX = 100;
const THREADS_PER_VIEW_MAX = 100;
const AVATARS_MAX = 5;
const PREVIEW_MAX = 80;
const HISTORY_FETCH = 60;
const WINDOW_MS = 60_000;
const ALL_READ = 1n << 62n;
/** Uma vez reservada, a vez do assistente vence sozinha depois disto (o prazo do provedor é 60 s). */
const TURN_TTL_MS = 120_000;

type NodeRow = {
  id: string;
  kind: string;
  purpose: string | null;
  title: string | null;
  ownerPersonId: string;
  ticketId: string | null;
  parentId: string | null;
  lastActivityAt: Date;
  openingMessageId: string | null;
  ticketConversationId: string | null;
};
type PersonRef = { id: string; displayName: string; avatarUrl: string | null };
type MessageRow = { id: string; seq: bigint; authorPersonId: string | null; body: string; model: string | null; createdAt: Date };
const MSG_SELECT = { id: true, seq: true, authorPersonId: true, body: true, model: true, createdAt: true } as const;
type TicketRef = { id: string; key: string; title: string; projectId: string; archived: boolean; status: string; blocked: boolean };
/** O começo da mensagem para a lista: o elo de pessoa vira `@Nome` antes do corte, para o corte não partir um elo no meio. */
const previewOf = (body: string): string => withoutPersonLinks(body).slice(0, PREVIEW_MAX);

/** Uma conversa como o MCP a entrega (ADR 0062): ids de pessoa e texto cru; quem monta a resposta resolve os nomes e limpa as menções. */
export type McpConversation = {
  id: string;
  kind: "ticket" | "general" | "thread";
  purpose: "people" | "topic" | "creation" | null;
  ticketKey: string | null;
  title: string | null;
  /** A mensagem que abriu a thread (cru), para o título quando a thread não tem um. */
  openingBody: string | null;
  participantIds: string[];
  lastActivityAt: Date;
  closed: boolean;
  parentId: string | null;
  creation: { state: string; ticketKey: string | null } | null;
};
export type McpMessage = { id: string; seq: bigint; authorPersonId: string | null; createdAt: Date; marker: "creation_opened" | null; body: string };

type Stats = { unread: number; replyCount: number; lastReadSeq: bigint; preview: string | null; closed: boolean };

/** O que a primeira transação da mensagem ao assistente leu: o que vai ao provedor e o que conferir na volta. */
export type AssistantPrep = {
  context: ChatTicketContext | null;
  history: { author: "person" | "assistant"; body: string }[];
  seenLastSeq: number;
  /** Os projetos que a pessoa enxerga agora e não estão arquivados: é só neles que as ferramentas consultam (ADR 0056). */
  projects: { id: string; key: string }[];
  /** Primeira resposta de uma thread de assunto: o provedor devolve também o título (ADR 0056). */
  wantTitle: boolean;
  /** A ferramenta que abre o rascunho de um ticket novo (ADR 0056, item 5); `null` onde a pessoa não pode criar ticket em projeto nenhum. */
  draftTool: DraftToolState | null;
};

type CreationBlock = z.output<typeof creationSchema>;
type CreationInfo = { title: string | null; block: CreationBlock; hidden?: true };
type CreationLink = { id: string; title: string | null; ticketConversationId: string | null };

const apiError = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new HttpException({ code, message, ...(details ? { details } : {}) }, status);

/**
 * Conversas em níveis (ADR 0055; substitui o chat da ADR 0049). Quem lê o quê é UMA regra (`@treepm/domain`, `conversations.ts`) e
 * toda rota entra por `ConversationAccess.resolve`, que devolve a conversa só a quem participa dela. Aqui nada decide privacidade
 * por conta própria: as consultas já saem filtradas por "a pessoa participa". Nada grava atividade nem toca a versão do projeto ou
 * a trava de estrutura (ADR 0045 e 0046): conversa não é estrutura. O conteúdo das mensagens nunca vai para log.
 */
/** O assistente só fala na conversa principal e na thread de assunto: o serviço recusa qualquer outra thread antes de ler qualquer histórico, qualquer que seja o chamador. */
const notPrincipalForAssistant = (): UnprocessableEntityException => new UnprocessableEntityException({ code: "not_principal", message: "O assistente só responde na conversa principal e nas threads de assunto." });

@Injectable()
export class ConversationService {
  private readonly limiter: RateLimiter;
  private readonly threadLimiter: RateLimiter;

  constructor(
    @Inject(ConversationAccess) private readonly access: ConversationAccess,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ACCESS_TOKEN_CLOCK) clock: AccessTokenClock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(TicketDraftService) private readonly drafts: TicketDraftService,
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

  // ---- peças ----------------------------------------------------------------------------------------------

  private async people(tx: TenantClient, ids: readonly (string | null)[]): Promise<Map<string, PersonRef>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await tx.person.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, avatarUrl: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async visibleProjectIds(tx: TenantClient, principal: Principal): Promise<string[]> {
    const projects = await tx.project.findMany({ select: { id: true, visibility: true } });
    return projects.filter((p) => this.authorization.canView(principal.actor, p)).map((p) => p.id);
  }

  /** Os tickets pedidos que existem (cabeçalho para a barra e a conversa), com situação e bloqueio. Quem filtra por acesso é quem chama. */
  private async ticketRefs(tx: TenantClient, ids: readonly string[]): Promise<Map<string, TicketRef>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ id: string; project_id: string; number: number; title: string; status: string; key: string; archived: boolean; blocked: boolean }[]>`
      select t.id, t.project_id, t.number, t.title, t.status, p.key, (p.archived_at is not null) as archived,
             exists (
               select 1 from ticket_relations r join tickets d on d.org_id = r.org_id and d.id = r.to_ticket_id
               where r.org_id = t.org_id and r.from_ticket_id = t.id and r.kind = 'depends_on' and d.status not in ('done', 'cancelled')
             ) as blocked
      from tickets t join projects p on p.org_id = t.org_id and p.id = t.project_id
      where t.id = any(${wanted}::uuid[])`;
    return new Map(rows.map((r) => [r.id, { id: r.id, key: `${r.key}-${r.number}`, title: r.title, projectId: r.project_id, archived: r.archived, status: r.status, blocked: r.blocked }]));
  }

  /** Os participantes de cada conversa pedida, na ordem em que entraram. Só se chama com conversas que a pessoa lê. */
  private async participantsOf(tx: TenantClient, ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await tx.conversationParticipant.findMany({ where: { conversationId: { in: [...ids] } }, orderBy: [{ addedAt: "asc" }, { personId: "asc" }], select: { conversationId: true, personId: true } });
    for (const row of rows) out.set(row.conversationId, [...(out.get(row.conversationId) ?? []), row.personId]);
    return out;
  }

  /**
   * Não lidas, respostas e prévia das conversas pedidas, do ponto de vista de `me`. Uma consulta pelos índices; só as conversas de
   * que `me` participa entram (o `join` com o participante). A mensagem de abertura conta na thread (é a primeira dela), e na
   * conversa de cima não conta como não lida, porque quem a lê lá também a lê na thread.
   */
  private async stats(tx: TenantClient, me: string, ids: readonly string[]): Promise<Map<string, Stats>> {
    const out = new Map<string, Stats>();
    if (ids.length === 0) return out;
    const rows = await tx.$queryRaw<{ id: string; unread: number; reply_count: number; last_read_seq: bigint; preview: string | null; closed: boolean }[]>`
      select cp.conversation_id as id, cp.last_read_seq,
        (cp.closed_seq is not null and not exists (select 1 from conversation_messages m
          where m.org_id = cp.org_id and m.conversation_id = cp.conversation_id and m.seq > cp.closed_seq and m.author_person_id is distinct from cp.person_id)) as closed,
        (select count(*) from conversation_messages m
          where m.org_id = c.org_id and (m.conversation_id = c.id or m.id = c.opening_message_id)
            and m.seq > cp.last_read_seq and m.author_person_id is distinct from cp.person_id
            and not exists (select 1 from conversations o where o.org_id = m.org_id and o.opening_message_id = m.id and o.parent_id = c.id))::int as unread,
        (select count(*) from conversation_messages m where m.org_id = c.org_id and m.conversation_id = c.id)::int as reply_count,
        (select m.body from conversation_messages m
          where m.org_id = c.org_id and (m.conversation_id = c.id or m.id = c.opening_message_id) order by m.seq desc limit 1) as preview
      from conversation_participants cp join conversations c on c.org_id = cp.org_id and c.id = cp.conversation_id
      where cp.person_id = ${me}::uuid and cp.conversation_id = any(${[...ids]}::uuid[])`;
    for (const r of rows) out.set(r.id, { unread: r.unread, replyCount: r.reply_count, lastReadSeq: r.last_read_seq, preview: r.preview === null ? null : previewOf(r.preview), closed: r.closed });
    return out;
  }

  private baseMessage(row: MessageRow, people: Map<string, PersonRef>, principal: Principal, lastRead: bigint, countAsUnread = true) {
    const marked = row.authorPersonId === null && row.body.startsWith(CREATION_OPENED_PREFIX);
    return {
      id: row.id,
      cursor: this.cursor(principal.organization.orgId, row.seq),
      unread: countAsUnread && row.authorPersonId !== principal.person.id && row.seq > lastRead,
      authorKind: row.authorPersonId === null ? ("assistant" as const) : ("person" as const),
      author: row.authorPersonId === null ? null : (people.get(row.authorPersonId) ?? null),
      createdAt: row.createdAt.toISOString(),
      // A resposta fixa do assistente é guardada como marcador; o texto em português vai só como reserva.
      body: marked ? CREATION_OPENED_REPLY : row.body,
      model: row.model,
      marker: marked ? ("creation_opened" as const) : null,
    };
  }

  /** A mensagem que abriu uma thread conta como não lida na thread (no cartão), nunca duas vezes. */
  private message(row: MessageRow, people: Map<string, PersonRef>, principal: Principal, lastRead: bigint, thread: ThreadCard | null = null, opensThread = thread !== null): ChatMessage {
    // A mensagem que abriu uma thread nunca conta como não lida nesta conversa, mesmo com o cartão escondido (projeto sem acesso).
    return { ...this.baseMessage(row, people, principal, lastRead, !opensThread), thread };
  }

  /** Os cartões das threads pedidas, só das de que a pessoa participa. */
  private async cards(tx: TenantClient, principal: Principal, ids: readonly string[]): Promise<Map<string, ThreadCard>> {
    const out = new Map<string, ThreadCard>();
    if (ids.length === 0) return out;
    const me = principal.person.id;
    // Thread de projeto que a pessoa não enxerga (nunca viu, ou perdeu o acesso depois) não vira cartão: o mesmo que a árvore faz.
    const visible = await this.visibleProjectIds(tx, principal);
    const threads = await tx.conversation.findMany({
      where: { id: { in: [...ids] }, kind: "thread", participants: { some: { personId: me } }, OR: [{ projectId: null }, { projectId: { in: visible } }] },
      select: { id: true, ownerPersonId: true, openingMessageId: true, lastActivityAt: true, purpose: true, title: true, ticketConversationId: true },
    });
    const creations = await this.creationInfo(tx, principal, threads.filter((t) => t.purpose === "creation"));
    const openings = await tx.conversationMessage.findMany({ where: { id: { in: threads.flatMap((t) => (t.openingMessageId ? [t.openingMessageId] : [])) } }, select: MSG_SELECT });
    const byOpening = new Map(openings.map((o) => [o.id, o]));
    const parts = await this.participantsOf(tx, threads.map((t) => t.id));
    const stats = await this.stats(tx, me, threads.map((t) => t.id));
    const people = await this.people(tx, [...openings.map((o) => o.authorPersonId), ...[...parts.values()].flat()]);
    for (const t of threads) {
      const opening = t.openingMessageId ? byOpening.get(t.openingMessageId) : undefined;
      const stat = stats.get(t.id);
      if (!opening || !stat) continue;
      const creation = creations.get(t.id) ?? null;
      const members = parts.get(t.id) ?? [];
      out.set(t.id, {
        id: t.id,
        opening: this.baseMessage(opening, people, principal, stat.lastReadSeq),
        participants: members.flatMap((p) => (people.get(p) ? [people.get(p) as PersonRef] : [])),
        participantCount: members.length,
        replyCount: t.purpose === "creation" ? 0 : stat.replyCount,
        lastActivityAt: t.lastActivityAt.toISOString(),
        unread: stat.unread,
        startedByMe: t.ownerPersonId === me,
        purpose: (t.purpose ?? "people") as ThreadCard["purpose"],
        title: creation ? creation.title : t.title,
        creation: creation ? creation.block : null,
        closed: stat.closed,
      });
    }
    return out;
  }

  // ---- leituras -------------------------------------------------------------------------------------------

  /** As colunas de uma conversa que a barra precisa, para as duas listas (a árvore e as fechadas). */
  private static readonly NODE_SELECT = { id: true, kind: true, purpose: true, title: true, ownerPersonId: true, ticketId: true, parentId: true, lastActivityAt: true, openingMessageId: true, ticketConversationId: true } as const;

  /** Só entram conversas de projeto que a pessoa enxerga, e a thread de criação só enquanto está aberta (ADR 0056, item 5). */
  private async barFilter(tx: TenantClient, principal: Principal) {
    const visibleProjects = await this.visibleProjectIds(tx, principal);
    // O filtro da thread de criação vai na consulta, antes do `take`.
    const openCreations = await this.openCreationIds(tx, principal.person.id, visibleProjects);
    return { visibleProjects, where: { AND: [{ OR: [{ projectId: null }, { projectId: { in: visibleProjects } }] }, { OR: [{ purpose: null }, { purpose: { not: "creation" as const } }, { id: { in: openCreations } }] }] } };
  }

  /**
   * O que os nós da barra precisam das conversas dadas (participantes, estatísticas, tickets, criação) e a função que monta um nó. Só
   * recebe conversas de que a pessoa participa; `ticketIds` são tickets a mais cujo cabeçalho a barra também mostra.
   */
  private async nodeFactory(tx: TenantClient, principal: Principal, convs: readonly NodeRow[], ticketIds: readonly string[]) {
    const me = principal.person.id;
    const creations = await this.creationInfo(tx, principal, convs.filter((c) => c.purpose === "creation"));
    const ids = convs.map((c) => c.id);
    // O começo da mensagem que abriu cada thread: é a primeira mensagem da própria thread, que a pessoa já lê (só entram aqui as dela).
    const openings = await tx.conversationMessage.findMany({ where: { id: { in: convs.flatMap((c) => (c.openingMessageId ? [c.openingMessageId] : [])) } }, select: { id: true, body: true } });
    const openingLabel = new Map(openings.map((m) => [m.id, previewOf(m.body)]));
    const parts = await this.participantsOf(tx, ids);
    const stats = await this.stats(tx, me, ids);
    const refs = await this.ticketRefs(tx, [...convs.flatMap((c) => (c.ticketId ? [c.ticketId] : [])), ...ticketIds]);
    const people = await this.people(tx, ids.flatMap((id) => (parts.get(id) ?? []).slice(0, AVATARS_MAX)));
    const wantedTickets = [...new Set([...ticketIds, ...convs.flatMap((c) => (c.ticketId ? [c.ticketId] : []))])];
    const assignedIds = new Set((wantedTickets.length === 0 ? [] : await tx.ticketAssignee.findMany({ where: { personId: me, ticketId: { in: wantedTickets } }, select: { ticketId: true } })).map((a) => a.ticketId));
    const make = (c: NodeRow | null, ticketId: string | null, kind: ConversationNodeShape["kind"], at: Date | null): ConversationNodeShape => {
      const members = c ? (parts.get(c.id) ?? []) : [me];
      const stat = c ? stats.get(c.id) : undefined;
      return {
        id: c?.id ?? null,
        kind,
        ticket: ticketId ? (refs.get(ticketId) ?? null) : null,
        ownedByMe: c ? c.ownerPersonId === me : true,
        assignedToMe: ticketId !== null && assignedIds.has(ticketId),
        participants: members.slice(0, AVATARS_MAX).flatMap((p) => (people.get(p) ? [people.get(p) as PersonRef] : [])),
        participantCount: members.length,
        lastActivityAt: at ? at.toISOString() : null,
        unread: stat?.unread ?? 0,
        preview: stat?.preview ?? null,
        label: kind === "thread" && c?.openingMessageId ? (openingLabel.get(c.openingMessageId) ?? null) : null,
        purpose: (c?.purpose ?? null) as ConversationNodeShape["purpose"],
        title: c ? (creations.get(c.id)?.title ?? c.title) : null,
        creation: c ? (creations.get(c.id)?.block ?? null) : null,
        closed: stat?.closed ?? false,
        children: [],
      };
    };
    return { make, stats, parts, refs };
  }

  /**
   * A árvore que a pessoa enxerga: o chat geral dela, as conversas de tickets e, em cada uma, as threads de que participa. Conversa
   * que ela fechou não entra; as de dentro que continuam abertas sobem para a conversa mais próxima que aparece (ADR 0059).
   */
  async tree(tx: TenantClient, principal: Principal): Promise<ConversationTree> {
    const me = principal.person.id;
    const { visibleProjects, where } = await this.barFilter(tx, principal);
    const convs = await tx.conversation.findMany({
      where: { participants: { some: { personId: me } }, ...where },
      orderBy: { lastActivityAt: "desc" },
      take: TREE_MAX,
      select: ConversationService.NODE_SELECT,
    });
    const assigned = visibleProjects.length === 0 ? [] : await tx.ticketAssignee.findMany({ where: { personId: me, ticket: { projectId: { in: visibleProjects } } }, orderBy: { createdAt: "desc" }, take: CHAT_LIST_MAX, select: { ticketId: true, createdAt: true } });
    const { make, stats, parts, refs } = await this.nodeFactory(tx, principal, convs, assigned.map((a) => a.ticketId));
    const closedIds = new Set(convs.filter((c) => stats.get(c.id)?.closed).map((c) => c.id));
    const domainNodes: ConversationNode[] = convs.map((c) => ({ id: c.id, parentId: c.parentId, participantIds: new Set(parts.get(c.id) ?? []) }));
    // A regra: o pai de cada conversa é a mais próxima acima que a pessoa LÊ e não fechou; sem ela, a thread é uma ponta de baixo da árvore dela.
    const parentOf = shownTree(me, domainNodes, closedIds);
    // O ticket cuja conversa a pessoa fechou some da barra, mesmo sendo ela responsável por ele (fechou porque quis).
    const closedTickets = new Set(convs.flatMap((c) => (c.kind === "ticket" && c.ownerPersonId === me && c.ticketId && closedIds.has(c.id) ? [c.ticketId] : [])));
    const nodeOf = new Map<string, ConversationNodeShape>();
    for (const c of convs) if (parentOf.has(c.id)) nodeOf.set(c.id, make(c, c.ticketId, c.kind as ConversationNodeShape["kind"], c.lastActivityAt));
    const ticketNodes = new Map<string, ConversationNodeShape>();
    let general: ConversationNodeShape | null = null;
    const orphans: NodeRow[] = [];
    for (const c of convs) {
      const node = nodeOf.get(c.id);
      if (!node) continue;
      const parent = parentOf.get(c.id) ?? null;
      if (parent !== null) nodeOf.get(parent)?.children.push(node);
      else if (c.kind === "ticket" && c.ticketId) ticketNodes.set(c.ticketId, node);
      else if (c.kind === "general") general = node;
      else orphans.push(c);
    }
    // Ticket com responsável e sem conversa ainda: aparece, sem id.
    for (const a of assigned) if (!ticketNodes.has(a.ticketId) && refs.has(a.ticketId) && !closedTickets.has(a.ticketId)) ticketNodes.set(a.ticketId, make(null, a.ticketId, "ticket", a.createdAt));
    const generalNode = general ?? make(null, null, "general", null);
    // Thread em que a pessoa entrou sem ver a de cima: fica sob o ticket de que trata (ou sob o chat geral dela), sem dado do pai real.
    for (const c of orphans) {
      const node = nodeOf.get(c.id) as ConversationNodeShape;
      if (c.ticketId && refs.has(c.ticketId)) {
        let group = ticketNodes.get(c.ticketId);
        if (!group) {
          group = make(null, c.ticketId, "ticket", c.lastActivityAt);
          ticketNodes.set(c.ticketId, group);
        }
        group.children.push(node);
        if (group.id === null && (!group.lastActivityAt || group.lastActivityAt < c.lastActivityAt.toISOString())) group.lastActivityAt = c.lastActivityAt.toISOString();
      } else {
        generalNode.children.push(node);
      }
    }
    const byActivity = (a: ConversationNodeShape, b: ConversationNodeShape) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
    const sortDeep = (node: ConversationNodeShape): void => {
      node.children.sort(byActivity);
      node.children.forEach(sortDeep);
    };
    const tickets = [...ticketNodes.values()].sort(byActivity).slice(0, CHAT_LIST_MAX);
    for (const node of [generalNode, ...tickets]) sortDeep(node);
    return parseOutput(conversationTreeSchema, { items: [generalNode, ...tickets] });
  }

  /**
   * As conversas que a pessoa fechou e continuam fechadas, da mais recente para a mais antiga, planas (sem filhos), para a tela oferecer
   * "reabrir". Só as dela, e só as que ela lê (projeto que deixou de enxergar não aparece).
   */
  async closedList(tx: TenantClient, principal: Principal): Promise<ConversationTree> {
    const me = principal.person.id;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      select cp.conversation_id as id
      from conversation_participants cp join conversations c on c.org_id = cp.org_id and c.id = cp.conversation_id
      where cp.person_id = ${me}::uuid and cp.closed_seq is not null
        and not exists (select 1 from conversation_messages m where m.org_id = cp.org_id and m.conversation_id = cp.conversation_id and m.seq > cp.closed_seq and m.author_person_id is distinct from cp.person_id)
      order by c.last_activity_at desc, c.id desc
      limit ${TREE_MAX}`;
    const { where } = await this.barFilter(tx, principal);
    const found = await tx.conversation.findMany({ where: { id: { in: rows.map((r) => r.id) }, participants: { some: { personId: me } }, ...where }, select: ConversationService.NODE_SELECT });
    const order = new Map(rows.map((r, i) => [r.id, i]));
    const convs = found.sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number)).slice(0, CLOSED_LIST_MAX);
    const { make } = await this.nodeFactory(tx, principal, convs, []);
    return parseOutput(conversationTreeSchema, { items: convs.map((c) => make(c, c.ticketId, c.kind as ConversationNodeShape["kind"], c.lastActivityAt)) });
  }

  /** Uma conversa, só para quem participa dela; as mensagens, as mais recentes primeiro. */
  async view(tx: TenantClient, principal: Principal, id: string, page: PageQuery): Promise<ConversationView> {
    const resolved = await this.access.resolve(tx, principal, id);
    return this.build(tx, principal, resolved, resolved.seen, page, []);
  }

  /** A conversa da pessoa neste ticket (sem criar nada) e as threads do ticket em que ela entrou sem ver a de cima. */
  async ticketView(tx: TenantClient, principal: Principal, ticketId: string, page: PageQuery): Promise<ConversationView> {
    const me = principal.person.id;
    const seen = await this.access.visible(tx, principal, ticketId);
    const mine = await tx.conversation.findFirst({ where: { kind: "ticket", ticketId, ownerPersonId: me }, select: { id: true } });
    const resolved = mine ? await this.access.resolve(tx, principal, mine.id) : null;
    const orphans = await tx.conversation.findMany({
      where: { kind: "thread", ticketId, participants: { some: { personId: me } }, parent: { participants: { none: { personId: me } } } },
      orderBy: { lastActivityAt: "desc" },
      take: THREADS_PER_VIEW_MAX,
      select: { id: true },
    });
    return this.build(tx, principal, resolved, seen, page, orphans.map((o) => o.id));
  }

  private async build(tx: TenantClient, principal: Principal, resolved: Resolved | null, seen: Visible | null, page: PageQuery, extraThreadIds: readonly string[]): Promise<ConversationView> {
    const me = principal.person.id;
    const orgId = principal.organization.orgId;
    const ticketId = seen?.ticket.id ?? null;
    const refs = ticketId ? await this.ticketRefs(tx, [ticketId]) : new Map<string, TicketRef>();
    const conv = resolved?.conv ?? null;
    const lastRead = resolved?.lastReadSeq ?? 0n;
    const before = page.before ? { seq: { lt: this.seqOf(principal, page.before) } } : {};
    const rows = conv
      ? await tx.conversationMessage.findMany({
          where: { AND: [{ OR: [{ conversationId: conv.id }, ...(conv.openingMessageId ? [{ id: conv.openingMessageId }] : [])] }, before] },
          orderBy: { seq: "desc" },
          take: page.limit + 1,
          select: MSG_SELECT,
        })
      : [];
    const items = rows.slice(0, page.limit);
    const opened = conv && items.length > 0 ? await tx.conversation.findMany({ where: { parentId: conv.id, openingMessageId: { in: items.map((m) => m.id) }, participants: { some: { personId: me } } }, select: { id: true, openingMessageId: true } }) : [];
    const openCreations = conv ? await this.openCreationIds(tx, me, await this.visibleProjectIds(tx, principal)) : [];
    const directThreads = conv ? await tx.conversation.findMany({ where: { parentId: conv.id, participants: { some: { personId: me } }, OR: [{ purpose: null }, { purpose: { not: "creation" } }, { id: { in: openCreations } }] }, orderBy: { lastActivityAt: "desc" }, take: THREADS_PER_VIEW_MAX, select: { id: true } }) : [];
    const threadIds = [...new Set([...directThreads.map((t) => t.id), ...extraThreadIds])];
    const cards = await this.cards(tx, principal, [...new Set([...opened.map((o) => o.id), ...threadIds])]);
    const openingIds = new Set((conv && items.length > 0 ? await tx.conversation.findMany({ where: { parentId: conv.id, openingMessageId: { in: items.map((m) => m.id) } }, select: { openingMessageId: true } }) : []).flatMap((o) => (o.openingMessageId ? [o.openingMessageId] : [])));
    const cardByOpening = new Map(opened.flatMap((o) => (o.openingMessageId && cards.get(o.id) ? [[o.openingMessageId, cards.get(o.id) as ThreadCard] as const] : [])));
    const people = await this.people(tx, items.map((m) => m.authorPersonId));
    const stats = conv ? (await this.stats(tx, me, [conv.id])).get(conv.id) : undefined;
    const trail = conv ? await this.access.trail(tx, principal, conv.id) : [];
    const trailOpenings = await tx.conversationMessage.findMany({ where: { id: { in: trail.flatMap((t) => (t.openingMessageId ? [t.openingMessageId] : [])) } }, select: { id: true, body: true } });
    const labels = new Map(trailOpenings.map((m) => [m.id, previewOf(m.body)]));
    const openingRow = conv?.openingMessageId ? await tx.conversationMessage.findFirst({ where: { id: conv.openingMessageId }, select: MSG_SELECT }) : null;
    const openingPeople = await this.people(tx, [openingRow?.authorPersonId ?? null]);
    const members = conv ? [...(resolved as Resolved).participantIds] : [];
    const memberPeople = await this.people(tx, members);
    const assigned = ticketId ? (await tx.ticketAssignee.count({ where: { ticketId, personId: me } })) > 0 : false;
    const creation = conv?.purpose === "creation" ? ((await this.creationInfo(tx, principal, [conv])).get(conv.id) ?? null) : null;
    // Perdeu o acesso ao projeto da criação: a thread responde 404, como qualquer conversa de projeto que a pessoa não vê.
    if (creation?.hidden) throw notFound();
    return parseOutput(conversationViewSchema, {
      conversation: conv
        ? {
            id: conv.id,
            kind: conv.kind,
            purpose: conv.purpose,
            title: creation ? creation.title : conv.title,
            creation: creation ? creation.block : null,
            ownedByMe: conv.ownerPersonId === me,
            participants: members.flatMap((p) => (memberPeople.get(p) ? [memberPeople.get(p) as PersonRef] : [])),
            canAddParticipants: conv.kind === "thread" && conv.purpose === "people" && conv.ownerPersonId === me,
            canOpenThread: conv.purpose !== "creation" && canOpenThreadBelow(trail.length, conv.depth),
            openingMessageId: conv.openingMessageId,
            opening: openingRow ? this.baseMessage(openingRow, openingPeople, principal, lastRead) : null,
            replyCount: stats?.replyCount ?? 0,
            lastActivityAt: conv.lastActivityAt.toISOString(),
            trail: trail.map((t) => ({ id: t.id, kind: t.kind, label: t.openingMessageId ? (labels.get(t.openingMessageId) ?? null) : null, title: t.title })),
            closed: stats?.closed ?? false,
          }
        : null,
      ticket: ticketId ? (refs.get(ticketId) ?? null) : null,
      assignedToMe: assigned,
      lastRead: lastRead > 0n ? this.cursor(orgId, lastRead) : null,
      unread: stats?.unread ?? 0,
      messages: {
        items: items.map((r) => this.message(r, people, principal, lastRead, cardByOpening.get(r.id) ?? null, openingIds.has(r.id))),
        nextBefore: rows.length > page.limit && items.length > 0 ? this.cursor(orgId, items[items.length - 1]!.seq) : null,
      },
      threads: threadIds.flatMap((id) => (cards.get(id) ? [cards.get(id) as ThreadCard] : [])),
    });
  }

  // ---- leitura para o MCP (ADR 0062, fatia 3) ----------------------------------------------------------------

  /**
   * O que a barra já filtra (participa, projeto que a pessoa enxerga, thread de criação só aberta) e mais o recorte do MCP: só o PROJETO do
   * token, pela própria conversa e pela principal de onde ela descende (a thread de Meu chat tem projeto quando cita ticket, mas a raiz não).
   * `null` quando a pessoa já não enxerga o projeto. É a UMA regra que a lista e a leitura do MCP usam.
   */
  private async mcpScope(tx: TenantClient, principal: Principal, projectId: string) {
    const { visibleProjects, where } = await this.barFilter(tx, principal);
    if (!visibleProjects.includes(projectId)) return null;
    return { AND: [{ participants: { some: { personId: principal.person.id } } }, where, { projectId }, { root: { projectId } }] };
  }

  /** As conversas dadas (já dentro do recorte), como o MCP as entrega: nada de nome, só ids de pessoa; o texto vai cru para o MCP limpar. */
  private async mcpCards(tx: TenantClient, principal: Principal, projectId: string, scope: NonNullable<Awaited<ReturnType<ConversationService["mcpScope"]>>>, convs: readonly NodeRow[]): Promise<McpConversation[]> {
    const ids = convs.map((c) => c.id);
    const [parts, stats, creations, refs] = await Promise.all([
      this.participantsOf(tx, ids),
      this.stats(tx, principal.person.id, ids),
      // Pelo MCP, o rascunho só vale se for do projeto do token: de outro projeto (só com dado plantado), a thread some, sem título nem estado.
      this.creationInfo(tx, principal, convs.filter((c) => c.purpose === "creation"), projectId),
      this.ticketRefs(tx, convs.flatMap((c) => (c.ticketId ? [c.ticketId] : []))),
    ]);
    const openings = await tx.conversationMessage.findMany({ where: { id: { in: convs.flatMap((c) => (c.openingMessageId ? [c.openingMessageId] : [])) } }, select: { id: true, body: true } });
    const openingBody = new Map(openings.map((m) => [m.id, m.body]));
    // O pai só é dito quando a pessoa também lê o pai (e ele está no mesmo recorte): quem entrou numa thread sem ver a de cima não o descobre.
    const parentIds = [...new Set(convs.flatMap((c) => (c.parentId ? [c.parentId] : [])))];
    const readable = new Set((parentIds.length === 0 ? [] : await tx.conversation.findMany({ where: { AND: [{ id: { in: parentIds } }, scope] }, select: { id: true } })).map((c) => c.id));
    return convs.flatMap((c): McpConversation[] => {
      const creation = creations.get(c.id);
      if (creation?.hidden) return [];
      const marker = c.openingMessageId && !creation ? (openingBody.get(c.openingMessageId) ?? null) : null;
      return [
        {
          id: c.id,
          kind: c.kind as McpConversation["kind"],
          purpose: c.purpose as McpConversation["purpose"],
          ticketKey: c.ticketId ? (refs.get(c.ticketId)?.key ?? null) : null,
          title: creation ? creation.title : c.title,
          openingBody: marker,
          participantIds: parts.get(c.id) ?? [],
          lastActivityAt: c.lastActivityAt,
          closed: stats.get(c.id)?.closed ?? false,
          parentId: c.parentId && readable.has(c.parentId) ? c.parentId : null,
          creation: creation ? { state: creation.block.state, ticketKey: creation.block.ticket?.key ?? null } : null,
        },
      ];
    });
  }

  /** As conversas do projeto do token de que a pessoa participa (inclusive as que fechou), da mais recente para a mais antiga. */
  async mcpList(tx: TenantClient, principal: Principal, projectId: string, page: { after: { at: Date; id: string } | null; limit: number }): Promise<{ items: McpConversation[]; more: boolean }> {
    const scope = await this.mcpScope(tx, principal, projectId);
    if (scope === null) return { items: [], more: false };
    const keyset = page.after ? [{ OR: [{ lastActivityAt: { lt: page.after.at } }, { lastActivityAt: page.after.at, id: { lt: page.after.id } }] }] : [];
    const rows = await tx.conversation.findMany({ where: { AND: [scope, ...keyset] }, orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }], take: page.limit + 1, select: ConversationService.NODE_SELECT });
    const shown = rows.slice(0, page.limit);
    return { items: await this.mcpCards(tx, principal, projectId, scope, shown), more: rows.length > page.limit };
  }

  /**
   * Uma conversa e as mensagens dela, da mais antiga para a mais nova, pelas mesmas regras da lista. Conversa que não existe, de outra pessoa,
   * de outro projeto, do Meu chat ou que a pessoa não lê: o MESMO 404.
   */
  async mcpMessages(tx: TenantClient, principal: Principal, projectId: string, id: string, page: { afterSeq: bigint | null; limit: number }): Promise<{ conversation: McpConversation; messages: McpMessage[]; more: boolean }> {
    const resolved = await this.access.resolve(tx, principal, id);
    const scope = await this.mcpScope(tx, principal, projectId);
    if (scope === null) throw notFound();
    const inScope = await tx.conversation.findFirst({ where: { AND: [{ id }, scope] }, select: ConversationService.NODE_SELECT });
    if (!inScope) throw notFound();
    const [conversation] = await this.mcpCards(tx, principal, projectId, scope, [inScope]);
    if (!conversation) throw notFound();
    const conv = resolved.conv;
    const after = page.afterSeq === null ? {} : { seq: { gt: page.afterSeq } };
    const rows = await tx.conversationMessage.findMany({
      where: { AND: [{ OR: [{ conversationId: conv.id }, ...(conv.openingMessageId ? [{ id: conv.openingMessageId }] : [])] }, after] },
      orderBy: { seq: "asc" },
      take: page.limit + 1,
      select: MSG_SELECT,
    });
    const messages = rows.slice(0, page.limit).map((row): McpMessage => {
      const marked = row.authorPersonId === null && row.body.startsWith(CREATION_OPENED_PREFIX);
      // O marcador guarda o id da thread e o pedido: sai só o tipo, nunca o texto.
      return { id: row.id, seq: row.seq, authorPersonId: row.authorPersonId, createdAt: row.createdAt, marker: marked ? "creation_opened" : null, body: marked ? "" : row.body };
    });
    return { conversation, messages, more: rows.length > page.limit };
  }

  // ---- abrir (ou obter) as conversas principais -------------------------------------------------------------

  /** O chat geral da pessoa: nasce na primeira necessidade. */
  async openGeneral(tx: TenantClient, principal: Principal): Promise<{ id: string }> {
    const me = principal.person.id;
    const found = await tx.conversation.findFirst({ where: { kind: "general", ownerPersonId: me }, select: { id: true } });
    if (found) return found;
    return this.createPrincipal(tx, principal, "general", null);
  }

  /** A conversa principal da pessoa neste ticket: nasce na primeira necessidade (projeto arquivado: só se já existe). */
  async openTicket(tx: TenantClient, principal: Principal, ticketId: string): Promise<{ id: string }> {
    const seen = await this.access.visible(tx, principal, ticketId);
    const found = await tx.conversation.findFirst({ where: { kind: "ticket", ticketId, ownerPersonId: principal.person.id }, select: { id: true } });
    if (found) return found;
    this.access.writable(seen);
    return this.createPrincipal(tx, principal, "ticket", seen);
  }

  private async createPrincipal(tx: TenantClient, principal: Principal, kind: "ticket" | "general", seen: Visible | null): Promise<{ id: string }> {
    const me = principal.person.id;
    const id = randomUUID();
    const created = await tx.conversation.createMany({
      data: [{ orgId: principal.organization.orgId, id, kind, ownerPersonId: me, projectId: seen?.project.id ?? null, ticketId: seen?.ticket.id ?? null, rootId: id, depth: 0 }],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      // Duas aberturas ao mesmo tempo acabam na mesma conversa.
      return tx.conversation.findFirstOrThrow({ where: kind === "general" ? { kind, ownerPersonId: me } : { kind, ownerPersonId: me, ticketId: seen?.ticket.id ?? null }, select: { id: true } });
    }
    await tx.conversationParticipant.create({ data: { orgId: principal.organization.orgId, conversationId: id, personId: me } });
    return { id };
  }

  // ---- mensagens --------------------------------------------------------------------------------------------

  /** Que tipo de conversa é, para a rota decidir o caminho (assistente ou entre pessoas). 404 antes de qualquer outra coisa. */
  async kindOf(tx: TenantClient, principal: Principal, id: string): Promise<{ kind: "ticket" | "general" | "thread"; purpose: "people" | "topic" | "creation" | null }> {
    const { conv } = await this.access.resolve(tx, principal, id);
    if (conv.purpose === "creation" && (await this.creationInfo(tx, principal, [conv])).get(conv.id)?.hidden) throw notFound();
    return { kind: conv.kind, purpose: conv.purpose };
  }

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

  /** Mensagem sem menção numa thread: conversa entre pessoas, sem assistente. */
  async postInThread(tx: TenantClient, principal: Principal, id: string, body: string) {
    const me = principal.person.id;
    const resolved = await this.access.resolve(tx, principal, id);
    if (resolved.seen) this.access.writable(resolved.seen);
    this.requireThreadQuota(principal);
    // Trava a árvore antes de gravar: o ponto de fechamento de quem fecha (`close`) nunca passa à frente de uma mensagem ainda não confirmada.
    await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.rootId}::uuid for update`;
    const created = await tx.conversationMessage.create({ data: { orgId: principal.organization.orgId, conversationId: id, authorPersonId: me, body }, select: MSG_SELECT });
    await tx.conversation.updateMany({ where: { id }, data: { lastActivityAt: created.createdAt } });
    await this.reopen(tx, me, [id]);
    const people = await this.people(tx, [me]);
    return parseOutput(sendResultSchema, { kind: "message", message: this.message(created, people, principal, ALL_READ) });
  }

  /**
   * Mensagem com pessoas marcadas (ADR 0059). A própria pessoa sai da lista, e a lista que chega a `resolveMentions` nunca a traz. Se todas as marcadas já participam da conversa, é uma
   * mensagem comum dela, com o texto como veio (`postInThread`, sem thread e sem assistente); se alguma não participa, abre a thread
   * com quem já estava e quem foi marcado. Sem ninguém além de si mesma, é recusada (422 `assistant_mention_self`) onde o assistente fala, porque nenhum
   * texto com elo de pessoa vai ao provedor, e é a mensagem comum onde ele não fala.
   */
  async sendMentioning(tx: TenantClient, principal: Principal, id: string, body: string, mentions: readonly string[], ticketId: string | undefined, speaks: boolean) {
    const me = principal.person.id;
    const others = [...new Set(mentions)].filter((m) => m !== me);
    if (others.length === 0) {
      // Onde o assistente fala, nenhum texto com elo de pessoa vai ao provedor: a mensagem que só marca a própria pessoa é recusada.
      if (speaks) throw new UnprocessableEntityException({ code: "assistant_mention_self", message: "Aqui a conversa é com o assistente: marcar a si mesma não faz sentido. Tire a marcação ou escreva sem ela." });
      return this.postInThread(tx, principal, id, body);
    }
    const { participantIds } = await this.access.resolve(tx, principal, id);
    if (!mentionsOpenThread(me, others, participantIds)) return this.postInThread(tx, principal, id, body);
    return this.openThread(tx, principal, id, body, others.filter((m) => !participantIds.has(m)), ticketId);
  }

  /**
   * Marcar alguém numa mensagem abre uma thread DENTRO desta conversa: a mensagem fica aqui e é a primeira da thread. Os
   * participantes são todos os desta conversa mais os marcados (a invariante); abrir e incluir mexem na árvore, então a árvore
   * inteira é travada antes de ler quem participa.
   */
  async openThread(tx: TenantClient, principal: Principal, id: string, body: string, mentions: readonly string[], ticketId: string | undefined) {
    const me = principal.person.id;
    const orgId = principal.organization.orgId;
    const resolved = await this.access.resolve(tx, principal, id);
    if (resolved.seen) this.access.writable(resolved.seen);
    const trail = await this.access.trail(tx, principal, id);
    if (!canOpenThreadBelow(trail.length, resolved.conv.depth)) {
      throw new UnprocessableEntityException({ code: "max_depth", message: "Esta conversa está no último nível: não dá para abrir uma thread dentro dela." });
    }
    let subject: Visible | null = resolved.seen;
    if (ticketId !== undefined) {
      if (resolved.conv.ticketId !== null && resolved.conv.ticketId !== ticketId) throw new UnprocessableEntityException({ code: "ticket_mismatch", message: "Esta conversa já trata de outro ticket." });
      if (resolved.conv.ticketId === null) {
        subject = await this.access.visible(tx, principal, ticketId);
        this.access.writable(subject);
      }
    }
    const mentioned = await this.resolveMentions(tx, subject?.project ?? null, mentions);
    this.requireThreadQuota(principal);
    await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.rootId}::uuid for update`;
    const parentMembers = (await tx.conversationParticipant.findMany({ where: { conversationId: id }, select: { personId: true } })).map((p) => p.personId);
    // Thread com ticket dentro de conversa sem ticket: quem já está na de cima entra por herança e TEM de enxergar o projeto. Senão,
    // a thread não abre: 422 `participant_cannot_view_ticket`, que diz que alguém da conversa não enxerga o projeto, sem dizer quem.
    if (subject && resolved.conv.ticketId === null) {
      // Inativos não autenticam: não travam a conversa.
      const active = (await tx.person.findMany({ where: { id: { in: parentMembers }, active: true }, select: { id: true } })).map((x) => x.id);
      const ok = await this.eligible(tx, active, [subject.project]);
      if (active.some((p) => !ok.has(p))) throw new UnprocessableEntityException({ code: "participant_cannot_view_ticket", message: "Alguém desta conversa não enxerga o projeto deste ticket." });
    }
    const members = newThreadParticipants(me, parentMembers, mentioned);
    if (members.length > CONVERSATION_MAX_PARTICIPANTS) {
      throw new UnprocessableEntityException({ code: "thread_full", message: `Uma conversa tem no máximo ${CONVERSATION_MAX_PARTICIPANTS} participantes.`, details: { max: CONVERSATION_MAX_PARTICIPANTS } });
    }
    const opening = await tx.conversationMessage.create({ data: { orgId, conversationId: id, authorPersonId: me, body }, select: MSG_SELECT });
    const threadId = randomUUID();
    await tx.conversation.create({
      data: {
        orgId,
        id: threadId,
        kind: "thread",
        purpose: "people",
        ownerPersonId: me,
        projectId: subject?.project.id ?? null,
        ticketId: subject?.ticket.id ?? null,
        parentId: id,
        rootId: resolved.conv.rootId,
        depth: resolved.conv.depth + 1,
        openingMessageId: opening.id,
        lastActivityAt: opening.createdAt,
      },
    });
    await tx.conversationParticipant.createMany({ data: members.map((personId) => ({ orgId, conversationId: threadId, personId, addedByPersonId: personId === me ? null : me })) });
    await tx.conversation.updateMany({ where: { id }, data: { lastActivityAt: opening.createdAt } });
    await this.reopen(tx, me, [id]);
    const card = (await this.cards(tx, principal, [threadId])).get(threadId) as ThreadCard;
    const people = await this.people(tx, [me]);
    return parseOutput(sendResultSchema, { kind: "thread", message: this.message(opening, people, principal, ALL_READ, card), thread: card });
  }

  /**
   * Quem pode ser marcado: gente que enxerga o ticket da conversa (marcar não concede acesso; sem ticket, qualquer pessoa ativa da
   * organização). Recusa a própria pessoa, mais gente que o teto e quem não puder, SEM dizer nada além dos ids que a pessoa mesma
   * mandou (inexistente, de outra organização, inativa e sem acesso dão a mesma resposta).
   */
  private async resolveMentions(tx: TenantClient, project: ProjectRow | null, raw: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(raw)];
    if (wanted.length === 0) return [];
    if (wanted.length > CHAT_MAX_MENTIONS) {
      throw new UnprocessableEntityException({ code: "too_many_mentions", message: `Mencione no máximo ${CHAT_MAX_MENTIONS} pessoas por mensagem.`, details: { max: CHAT_MAX_MENTIONS } });
    }
    const ok = await this.eligible(tx, wanted, project ? [project] : []);
    const refused = wanted.filter((id) => !ok.has(id));
    if (refused.length > 0) {
      throw new UnprocessableEntityException({ code: "mention_not_allowed", message: "Só se pode mencionar quem enxerga este ticket.", details: { personIds: refused } });
    }
    return wanted;
  }

  /** Das pessoas pedidas, as ativas que enxergam TODOS os projetos dados. */
  private async eligible(tx: TenantClient, personIds: readonly string[], projects: readonly ProjectRow[]): Promise<Set<string>> {
    const people = await tx.person.findMany({ where: { id: { in: [...personIds] }, active: true }, select: { id: true, clerkRole: true } });
    const ok = new Set<string>();
    for (const person of people) {
      const actor: Actor = await this.authorization.loadActor(tx, person.id, person.clerkRole);
      if (projects.every((project) => this.authorization.canView(actor, project))) ok.add(person.id);
    }
    return ok;
  }

  // ---- participantes ------------------------------------------------------------------------------------------

  /**
   * Só quem abriu a thread inclui pessoas nela (incluir expõe o histórico inteiro). A pessoa entra, na mesma transação, em todas as
   * threads de dentro; o teto de 25 vale em cada uma e, se alguma estourar, a operação inteira falha.
   */
  async addParticipants(tx: TenantClient, principal: Principal, id: string, personIds: readonly string[]) {
    const me = principal.person.id;
    const orgId = principal.organization.orgId;
    const resolved = await this.access.resolve(tx, principal, id);
    if (resolved.conv.kind !== "thread") throw new UnprocessableEntityException({ code: "principal_conversation", message: "A conversa principal é só da pessoa com o assistente: só uma thread aceita participantes." });
    if (resolved.conv.purpose !== "people") throw new UnprocessableEntityException({ code: "private_thread", message: "A thread de assunto é só de quem a abriu: ninguém entra nela." });
    if (resolved.conv.ownerPersonId !== me) throw new ForbiddenException({ code: "not_thread_owner", message: "Só quem abriu a thread inclui pessoas nela." });
    if (resolved.seen) this.access.writable(resolved.seen);
    const wanted = [...new Set(personIds)].filter((p) => p !== me);
    if (wanted.length > CHAT_MAX_MENTIONS) throw new UnprocessableEntityException({ code: "too_many_mentions", message: `Inclua no máximo ${CHAT_MAX_MENTIONS} pessoas por vez.`, details: { max: CHAT_MAX_MENTIONS } });
    await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.rootId}::uuid for update`;
    const targets = await this.access.subtree(tx, id);
    const projectIds = [...new Set(targets.flatMap((t) => (t.projectId ? [t.projectId] : [])))];
    const projects = await tx.project.findMany({ where: { id: { in: projectIds } } });
    const ok = await this.eligible(tx, wanted, projects as ProjectRow[]);
    const refused = wanted.filter((p) => !ok.has(p));
    if (refused.length > 0) throw new UnprocessableEntityException({ code: "mention_not_allowed", message: "Só se pode incluir quem enxerga este ticket.", details: { personIds: refused } });
    const members = await this.participantsOf(tx, targets.map((t) => t.id));
    for (const t of targets) {
      if (participantCountAfter(new Set(members.get(t.id) ?? []), wanted) > CONVERSATION_MAX_PARTICIPANTS) {
        throw new UnprocessableEntityException({ code: "thread_full", message: `Uma conversa tem no máximo ${CONVERSATION_MAX_PARTICIPANTS} participantes.`, details: { max: CONVERSATION_MAX_PARTICIPANTS } });
      }
    }
    for (const t of targets) await tx.conversationParticipant.createMany({ data: wanted.map((personId) => ({ orgId, conversationId: t.id, personId, addedByPersonId: me })), skipDuplicates: true });
    const now = (await this.participantsOf(tx, [id])).get(id) ?? [];
    const people = await this.people(tx, now);
    return parseOutput(participantsResultSchema, { participants: now.flatMap((p) => (people.get(p) ? [people.get(p) as PersonRef] : [])) });
  }

  // ---- fechar e reabrir (ADR 0059) -----------------------------------------------------------------------

  /** Quem escreve numa conversa a reabre para si (a marca de "fechada" é só da pessoa; as dos outros não mudam). */
  private async reopen(tx: TenantClient, me: string, ids: readonly string[]): Promise<void> {
    await tx.conversationParticipant.updateMany({ where: { personId: me, conversationId: { in: [...new Set(ids)] }, closedSeq: { not: null } }, data: { closedSeq: null } });
  }

  /**
   * Fecha a conversa para quem pede, e com ela todas as de dentro em que ela participa (a mesma transação). Não apaga nada nem muda
   * quem lê o quê: a marca é a posição da última mensagem de cada conversa agora; mensagem de outra pessoa depois dela traz a conversa de volta.
   * O chat geral não fecha.
   */
  async close(tx: TenantClient, principal: Principal, id: string) {
    const me = principal.person.id;
    const resolved = await this.access.resolve(tx, principal, id, { ignoreTicketAccess: true });
    if (resolved.conv.kind === "general") throw new UnprocessableEntityException({ code: "cannot_close_general", message: "O Meu chat não fecha." });
    if (resolved.conv.purpose === "creation" && (await this.creationInfo(tx, principal, [resolved.conv])).get(resolved.conv.id)?.hidden) throw notFound();
    // Trava a árvore: nenhuma mensagem em andamento fica atrás do ponto de fechamento (`postInThread` trava do mesmo jeito).
    await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.rootId}::uuid for update`;
    // Só fecha (e só devolve) o que a pessoa lê agora, pelo mesmo filtro da árvore: uma de dentro que ficou num projeto que ela deixou de enxergar não entra.
    const inside = (await this.access.subtree(tx, id)).map((t) => t.id);
    const { where } = await this.barFilter(tx, principal);
    const readable = new Set((await tx.conversation.findMany({ where: { id: { in: inside }, participants: { some: { personId: me } }, ...where }, select: { id: true } })).map((c) => c.id));
    const targets = inside.filter((t) => t === id || readable.has(t));
    const closed = await tx.$queryRaw<{ id: string }[]>`
      update conversation_participants cp
      set closed_seq = coalesce((select max(m.seq) from conversation_messages m where m.org_id = cp.org_id and m.conversation_id = cp.conversation_id), 0)
      where cp.person_id = ${me}::uuid and cp.conversation_id = any(${targets}::uuid[])
        and (cp.closed_seq is null or exists (select 1 from conversation_messages m
          where m.org_id = cp.org_id and m.conversation_id = cp.conversation_id and m.seq > cp.closed_seq and m.author_person_id is distinct from cp.person_id))
      returning cp.conversation_id as id`;
    const done = new Set(closed.map((c) => c.id));
    return parseOutput(closedResultSchema, { closed: true, closedIds: targets.filter((t) => done.has(t)) });
  }

  /**
   * Quem age no rascunho (rotas da conversa de novo ticket) reabre a thread de criação dele para si: a thread é só da pessoa,
   * e fechada ela não teria como voltar à barra. Sem thread (rotas antigas) ou sem marca de fechada, não faz nada.
   */
  async reopenCreationOf(tx: TenantClient, me: string, ticketConversationId: string): Promise<void> {
    const rows = await tx.conversation.findMany({ where: { purpose: "creation", ownerPersonId: me, ticketConversationId }, select: { id: true } });
    await this.reopen(tx, me, rows.map((r) => r.id));
  }

  /** O pedido de ticket novo esbarrou no rascunho aberto: as threads de criação abertas que a pessoa fechou voltam à barra. */
  async reopenOpenCreations(tx: TenantClient, principal: Principal): Promise<void> {
    const me = principal.person.id;
    await this.reopen(tx, me, await this.openCreationIds(tx, me, await this.visibleProjectIds(tx, principal)));
  }

  /** Reabre só esta conversa (as de dentro continuam como estão). */
  async reopenOne(tx: TenantClient, principal: Principal, id: string) {
    const resolved = await this.access.resolve(tx, principal, id, { ignoreTicketAccess: true });
    // O mesmo 404 de `close` para a thread de criação que a pessoa já não vê.
    if (resolved.conv.purpose === "creation" && (await this.creationInfo(tx, principal, [resolved.conv])).get(resolved.conv.id)?.hidden) throw notFound();
    await this.reopen(tx, principal.person.id, [resolved.conv.id]);
    return parseOutput(reopenedResultSchema, { closed: false });
  }

  // ---- leitura e limpeza ----------------------------------------------------------------------------------

  async markRead(tx: TenantClient, principal: Principal, id: string, upTo: string | undefined) {
    const me = principal.person.id;
    const resolved = await this.access.resolve(tx, principal, id);
    // Nunca além da mensagem mais nova que a pessoa pode ler aqui: um cursor à frente não marca como lida mensagem que ainda vai chegar.
    const newest = (
      await tx.conversationMessage.aggregate({ where: { OR: [{ conversationId: id }, ...(resolved.conv.openingMessageId ? [{ id: resolved.conv.openingMessageId }] : [])] }, _max: { seq: true } })
    )._max.seq ?? 0n;
    const asked = upTo === undefined ? newest : this.seqOf(principal, upTo);
    const target = asked < newest ? asked : newest;
    if (target > resolved.lastReadSeq) await tx.conversationParticipant.updateMany({ where: { conversationId: id, personId: me, lastReadSeq: { lt: target } }, data: { lastReadSeq: target } });
    const stat = (await this.stats(tx, me, [id])).get(id);
    const lastRead = stat?.lastReadSeq ?? 0n;
    return parseOutput(readResultSchema, { lastRead: lastRead > 0n ? this.cursor(principal.organization.orgId, lastRead) : null, unread: stat?.unread ?? 0 });
  }

  /** Apaga a conversa da pessoa com o assistente (só a principal dela). As threads abertas nela, e as mensagens que as abriram, ficam. */
  async clear(tx: TenantClient, principal: Principal, id: string): Promise<void> {
    // A pessoa sempre apaga a própria conversa, mesmo sem enxergar mais o ticket (não lê nada: só apaga o que é dela).
    const resolved = await this.access.resolve(tx, principal, id, { ignoreTicketAccess: true });
    if (resolved.conv.kind === "thread") throw new UnprocessableEntityException({ code: "not_principal", message: "Só a conversa com o assistente pode ser limpa." });
    await tx.conversationMessage.deleteMany({ where: { conversationId: id, opens: { none: {} } } });
  }

  // ---- mensagem ao assistente (conversa principal e thread de assunto) ----------------------------------

  /**
   * O que o assistente lê de uma conversa: as mensagens dela que não abriram thread (essas são entre pessoas) e, numa thread de
   * assunto, a mensagem de abertura (que mora na conversa de cima e é a primeira da thread). Nunca a conversa de cima, nunca outra thread.
   */
  private assistantScope(conv: { id: string; kind: string; openingMessageId: string | null }) {
    const own = { conversationId: conv.id, opens: { none: {} } };
    return conv.kind === "thread" && conv.openingMessageId ? { OR: [own, { id: conv.openingMessageId }] } : own;
  }

  /** Só a principal e a thread de assunto falam com o assistente; qualquer outra thread é recusada antes de ler o que for. */
  private requireAssistantConversation(conv: { kind: string; purpose: string | null }): void {
    if (!assistantSpeaksIn(conv as { kind: "ticket" | "general" | "thread"; purpose: "people" | "topic" | "creation" | null })) throw notPrincipalForAssistant();
  }

  /** O projeto que a pessoa enxerga e o contexto do ticket, para o que vai ao provedor. */
  private async providerContext(tx: TenantClient, principal: Principal, seen: Visible | null) {
    return { context: seen ? await this.context(tx, seen) : null, projects: await this.consultableProjects(tx, principal) };
  }

  /** Primeira transação: confere o acesso, lê o contexto do ticket e a conversa DA PRÓPRIA PESSOA, e monta o que vai ao provedor. */
  async prepareAssistantTurn(tx: TenantClient, principal: Principal, id: string, body: string, projectId?: string): Promise<AssistantPrep> {
    const resolved = await this.access.resolve(tx, principal, id);
    this.requireAssistantConversation(resolved.conv);
    if (resolved.seen) this.access.writable(resolved.seen);
    this.requireAssistantQuota(principal);
    // O projeto pedido só decide se a ferramenta é oferecida: um que não serve não derruba a mensagem.
    const draftTool = await this.draftToolFor(tx, principal, resolved, projectId);
    // Reserva a vez ANTES de chamar o provedor: uma por vez por conversa. A segunda requisição recebe o conflito sem gastar IA.
    const claimed = await tx.conversation.updateMany({
      where: { id, OR: [{ turnStartedAt: null }, { turnStartedAt: { lt: new Date(Date.now() - TURN_TTL_MS) } }] },
      data: { turnStartedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException({ code: "chat_busy", message: "O assistente ainda está respondendo à mensagem anterior. Espere a resposta." });
    // A resposta fixa de "abri o rascunho" fica fora do histórico (o pedido que a causou já saiu: virou abertura de thread).
    const scope = this.assistantScope(resolved.conv);
    const previous = await tx.conversationMessage.findMany({
      where: { AND: [scope, { NOT: { authorPersonId: null, body: { startsWith: CREATION_OPENED_PREFIX } } }] },
      orderBy: { seq: "desc" },
      take: HISTORY_FETCH,
      select: { seq: true, authorPersonId: true, body: true },
    });
    const history = trimChatHistory([
      ...previous.reverse().map((m) => ({ author: m.authorPersonId === null ? ("assistant" as const) : ("person" as const), body: withoutPersonLinksDeep(m.body) })),
      { author: "person" as const, body: withoutPersonLinksDeep(body) },
    ]);
    // A conferência de "a conversa mudou" olha TODAS as mensagens do escopo, inclusive as que o histórico não leva.
    const seenLastSeq = Number((await tx.conversationMessage.aggregate({ where: scope, _max: { seq: true } }))._max.seq ?? 0n);
    // O título é pedido enquanto a thread de assunto não tem um (um título inválido na abertura é pedido de novo na mensagem seguinte).
    const wantTitle = resolved.conv.kind === "thread" && resolved.conv.purpose === "topic" && resolved.conv.title === null;
    return { ...(await this.providerContext(tx, principal, resolved.seen)), history, seenLastSeq, wantTitle, draftTool };
  }

  /**
   * Primeira transação da abertura de uma thread de assunto: confere que a conversa de cima é principal e da pessoa, e monta o que
   * vai ao provedor, que é SÓ a mensagem de abertura (nada da conversa de cima). Nada é gravado ainda: a thread só existe depois de a
   * resposta chegar, então não há vez a reservar.
   */
  async prepareTopicOpening(tx: TenantClient, principal: Principal, id: string, body: string): Promise<AssistantPrep> {
    const me = principal.person.id;
    const resolved = await this.access.resolve(tx, principal, id);
    this.requireTopicParent(resolved.conv, me);
    if (resolved.seen) this.access.writable(resolved.seen);
    this.requireAssistantQuota(principal);
    return { ...(await this.providerContext(tx, principal, resolved.seen)), history: [{ author: "person", body: withoutPersonLinksDeep(body) }], seenLastSeq: 0, wantTitle: true, draftTool: null };
  }

  private requireTopicParent(conv: { kind: string; ownerPersonId: string }, me: string): void {
    // Principal da própria pessoa: o banco também recusa (conversations_purpose_parent), mas a recusa clara é esta.
    if (conv.ownerPersonId !== me) throw notFound();
    if (conv.kind === "thread") throw new UnprocessableEntityException({ code: "topic_in_thread", message: "Um assunto novo só abre na conversa principal, não dentro de uma thread." });
  }

  /** Solta a vez do assistente (provedor falhou ou a gravação não ocorreu). */
  async releaseTurn(tx: TenantClient, principal: Principal, id: string): Promise<void> {
    await tx.conversation.updateMany({ where: { id, ownerPersonId: principal.person.id }, data: { turnStartedAt: null } });
  }

  /** Os projetos que a pessoa enxerga agora (não arquivados): a lista que o modelo recebe e o alcance das ferramentas. */
  private async consultableProjects(tx: TenantClient, principal: Principal): Promise<{ id: string; key: string }[]> {
    const projects = await tx.project.findMany({ where: { archivedAt: null }, select: { id: true, key: true, visibility: true } });
    return projects.filter((p) => this.authorization.canView(principal.actor, p)).map((p) => ({ id: p.id, key: p.key })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** Segunda transação: confere tudo de novo e grava a mensagem da pessoa e a resposta, nesta ordem (e o título, se a thread ainda não tem). */
  async recordAssistantTurn(tx: TenantClient, principal: Principal, id: string, body: string, reply: { message: string; model: string; title?: string | null }, seenLastSeq: number) {
    const me = principal.person.id;
    const resolved = await this.access.resolve(tx, principal, id);
    this.requireAssistantConversation(resolved.conv);
    if (resolved.seen) this.access.writable(resolved.seen);
    await tx.$queryRaw`select 1 from conversations where id = ${id}::uuid for update`; // serializa turnos concorrentes da mesma pessoa
    const last = await tx.conversationMessage.aggregate({ where: this.assistantScope(resolved.conv), _max: { seq: true } });
    if (Number(last._max.seq ?? 0n) !== seenLastSeq) {
      throw new ConflictException({ code: "chat_changed", message: "A conversa mudou enquanto o assistente respondia. Recarregue e envie de novo." });
    }
    const base = { orgId: principal.organization.orgId, conversationId: id };
    const person = await tx.conversationMessage.create({ data: { ...base, authorPersonId: me, body }, select: MSG_SELECT });
    const assistant = await tx.conversationMessage.create({ data: { ...base, body: reply.message, model: reply.model }, select: MSG_SELECT });
    const title = resolved.conv.kind === "thread" && resolved.conv.title === null ? chatTitleOf(reply.title) : null;
    await tx.conversation.updateMany({ where: { id }, data: { lastActivityAt: assistant.createdAt, turnStartedAt: null, ...(title !== null ? { title } : {}) } });
    await this.reopen(tx, me, [id]);
    const people = await this.people(tx, [me]);
    return { message: this.message(person, people, principal, ALL_READ), reply: this.message(assistant, people, principal, ALL_READ) };
  }

  /**
   * Segunda transação da abertura: confere tudo de novo e grava a mensagem de abertura (na conversa de cima), a thread de assunto
   * (com a pessoa como único participante) e a resposta do assistente, DENTRO da thread.
   */
  async recordTopicOpening(tx: TenantClient, principal: Principal, id: string, body: string, reply: { message: string; model: string; title?: string | null }) {
    const me = principal.person.id;
    const orgId = principal.organization.orgId;
    const resolved = await this.access.resolve(tx, principal, id);
    this.requireTopicParent(resolved.conv, me);
    if (resolved.seen) this.access.writable(resolved.seen);
    // A árvore inteira é travada ANTES de gravar qualquer coisa (como openThread): duas aberturas ao mesmo tempo esperam uma pela outra.
    await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.rootId}::uuid for update`;
    const opening = await tx.conversationMessage.create({ data: { orgId, conversationId: id, authorPersonId: me, body }, select: MSG_SELECT });
    const threadId = randomUUID();
    await tx.conversation.create({
      data: {
        orgId,
        id: threadId,
        kind: "thread",
        purpose: "topic",
        title: chatTitleOf(reply.title),
        ownerPersonId: me,
        projectId: resolved.conv.projectId,
        ticketId: resolved.conv.ticketId,
        parentId: id,
        rootId: resolved.conv.rootId,
        depth: resolved.conv.depth + 1,
        openingMessageId: opening.id,
        lastActivityAt: opening.createdAt,
      },
    });
    await tx.conversationParticipant.create({ data: { orgId, conversationId: threadId, personId: me } });
    const assistant = await tx.conversationMessage.create({ data: { orgId, conversationId: threadId, body: reply.message, model: reply.model }, select: MSG_SELECT });
    await tx.conversation.updateMany({ where: { id: threadId }, data: { lastActivityAt: assistant.createdAt } });
    await tx.conversation.updateMany({ where: { id }, data: { lastActivityAt: opening.createdAt } });
    await this.reopen(tx, me, [id]);
    const card = (await this.cards(tx, principal, [threadId])).get(threadId) as ThreadCard;
    const people = await this.people(tx, [me]);
    return { message: this.message(opening, people, principal, ALL_READ, card), thread: card, reply: this.message(assistant, people, principal, ALL_READ) };
  }

  // ---- criação de ticket como subthread (ADR 0056, item 5) ----------------------------------------------------

  private unprocessable(code: string, message: string): UnprocessableEntityException {
    return new UnprocessableEntityException({ code, message });
  }

  /** O projeto aceita rascunho novo: visível, não arquivado e com permissão de criar ticket (o `Actor` da requisição, inclusive agindo como pessoa de teste). */
  private canCreateIn(principal: Principal, project: { id: string; visibility: string; archivedAt: Date | null }): boolean {
    if (project.archivedAt || !this.authorization.canView(principal.actor, project as ProjectRow)) return false;
    try {
      this.authorization.createTicket(principal.actor, project.id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Onde o rascunho nasce. No chat de um ticket, o projeto dele. No Meu chat, o projeto pedido (`projectId`: a pessoa precisa enxergá-lo e
   * poder criar ticket nele, senão 422 `project_unavailable`, igual para inexistente, invisível e sem permissão) ou, sem pedido, o único em
   * que ela pode criar; com vários, `required`; com nenhum, `none`. Só um pedido explícito que não serve é erro aqui.
   */
  private async creationProject(tx: TenantClient, principal: Principal, top: Resolved, requested: string | undefined, strict = true): Promise<{ project: ProjectRow } | { required: true } | { none: true }> {
    if (top.seen) {
      if (requested !== undefined && requested !== top.seen.project.id) {
        if (!strict) return { none: true };
        throw this.unprocessable("project_mismatch", "Este chat é de um ticket: o rascunho nasce no projeto dele.");
      }
      return this.canCreateIn(principal, top.seen.project) ? { project: top.seen.project } : { none: true };
    }
    const projects = (await tx.project.findMany()) as ProjectRow[];
    if (requested !== undefined) {
      const found = projects.find((p) => p.id === requested);
      if (!found || !this.canCreateIn(principal, found)) {
        if (!strict) return { none: true };
        throw this.unprocessable("project_unavailable", "Você não enxerga este projeto ou não pode criar ticket nele.");
      }
      return { project: found };
    }
    const able = projects.filter((p) => this.canCreateIn(principal, p));
    if (able.length === 0) return { none: true };
    return able.length === 1 ? { project: able[0] as ProjectRow } : { required: true };
  }

  /** A conversa onde a pessoa fala e a principal acima dela (a mesma, ou a mãe de uma thread de assunto). Só se cria rascunho onde o assistente fala. */
  private async creationHome(tx: TenantClient, principal: Principal, id: string): Promise<{ resolved: Resolved; top: Resolved }> {
    const resolved = await this.access.resolve(tx, principal, id);
    if (!assistantSpeaksIn(resolved.conv)) throw this.unprocessable("creation_in_thread", "Um ticket novo só nasce na conversa principal ou numa thread de assunto, não numa thread com pessoas.");
    const top = resolved.conv.kind === "thread" ? await this.access.resolve(tx, principal, resolved.conv.parentId as string) : resolved;
    return { resolved, top };
  }

  /** A pessoa já tem uma thread de criação aberta (rascunho em andamento). */
  private async hasOpenCreation(tx: TenantClient, principal: Principal): Promise<boolean> {
    // Só conta o rascunho que a pessoa ainda enxerga (o mesmo filtro da árvore): o de um projeto que ela deixou de ver não pode travar o limite.
    return (await this.openCreationIds(tx, principal.person.id, await this.visibleProjectIds(tx, principal))).length > 0;
  }

  /** As threads de criação ainda abertas da pessoa, em projetos que ela enxerga: as únicas que a árvore e a lista de threads mostram. */
  private async openCreationIds(tx: TenantClient, me: string, visibleProjects: readonly string[]): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string; project_id: string }[]>`
      select c.id, t.project_id from conversations c join ticket_conversations t on t.org_id = c.org_id and t.id = c.ticket_conversation_id
      where c.purpose = 'creation' and c.owner_person_id = ${me}::uuid and t.status = 'open'`;
    return rows.filter((r) => visibleProjects.includes(r.project_id)).map((r) => r.id);
  }

  /**
   * O estado e o título das threads de criação pedidas, lidos da conversa de novo ticket (nada é guardado na thread). `discarded`: o elo
   * sumiu (a conversa foi apagada). `created`: a conversa virou ticket. Aberta: `waiting` quando o assistente deu o rascunho por pronto
   * (`ready`) ou há pergunta sobre o lugar aberta para o rascunho de agora; senão `draft`. O título é o do rascunho quando existe.
   */
  /**
   * Quem abriu cada thread de criação: o assistente deixa, na conversa onde a pessoa falou, a resposta fixa `[creation_opened:<thread>]` com o
   * pedido que passou à ferramenta (sem coluna nova); a pessoa, no pedido direto, não deixa nada. Procura só nas conversas da mesma árvore.
   */
  private async openedByAssistant(tx: TenantClient, threadIds: readonly string[]): Promise<Set<string>> {
    if (threadIds.length === 0) return new Set();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      select distinct substring(m.body from '^[[]creation_opened:([0-9a-f-]{36})[]]') as id
      from conversations t join conversations c on c.org_id = t.org_id and c.root_id = t.root_id
        join conversation_messages m on m.org_id = c.org_id and m.conversation_id = c.id
      where t.id = any(${[...threadIds]}::uuid[]) and m.author_person_id is null and m.body like '[creation_opened:%'`;
    return new Set(rows.map((r) => r.id));
  }

  private async creationInfo(tx: TenantClient, principal: Principal, rows: readonly CreationLink[], onlyProjectId?: string): Promise<Map<string, CreationInfo>> {
    const out = new Map<string, CreationInfo>();
    if (rows.length === 0) return out;
    const seeing = await this.visibleProjectIds(tx, principal);
    const links = [...new Set(rows.flatMap((r) => (r.ticketConversationId ? [r.ticketConversationId] : [])))];
    const convs = links.length === 0 ? [] : await tx.ticketConversation.findMany({ where: { id: { in: links } } });
    const byId = new Map(convs.map((c) => [c.id, c]));
    const keys = new Map((await tx.project.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.projectId))] } }, select: { id: true, key: true } })).map((p) => [p.id, p.key]));
    const byAssistant = await this.openedByAssistant(tx, rows.map((r) => r.id));
    const refs = await this.ticketRefs(tx, convs.flatMap((c) => (c.status === "ticket_created" && c.createdTicketId ? [c.createdTicketId] : [])));
    for (const row of rows) {
      const openedBy = byAssistant.has(row.id) ? ("assistant" as const) : ("person" as const);
      const tc = row.ticketConversationId ? byId.get(row.ticketConversationId) : undefined;
      if (!tc || (tc.status !== "open" && tc.status !== "ticket_created")) {
        out.set(row.id, { title: row.title, block: { ticketConversationId: null, projectId: null, projectKey: null, state: "discarded", openedBy, ticket: null } });
        continue;
      }
      // Quem não enxerga o projeto AGORA não lê chave, título nem projeto: só o estado (a thread em si responde 404).
      // `onlyProjectId` (o MCP): rascunho de outro projeto que o do token conta como escondido.
      const hidden = !seeing.includes(tc.projectId) || (onlyProjectId !== undefined && tc.projectId !== onlyProjectId);
      let state: CreationBlock["state"] = "created";
      let ticket: CreationBlock["ticket"] = null;
      if (tc.status === "ticket_created") {
        const ref = tc.createdTicketId ? refs.get(tc.createdTicketId) : undefined;
        ticket = ref ? { id: ref.id, key: ref.key, title: ref.title } : null;
      } else {
        const decision = tc.ready ? null : await readDecisionSafely(tx, tc.id);
        state = tc.ready || (decision?.doubt?.confirmed === false && decision.doubt.draftMark === draftMarkOf(tc)) ? "waiting" : "draft";
      }
      out.set(
        row.id,
        hidden
          ? { title: null, hidden: true, block: { ticketConversationId: null, projectId: null, projectKey: null, state, openedBy, ticket: null } }
          : { title: creationTitleOf(tc.draftTitle) ?? row.title, block: { ticketConversationId: tc.id, projectId: tc.projectId, projectKey: keys.get(tc.projectId) ?? null, state, openedBy, ticket } },
      );
    }
    return out;
  }

  /** A ferramenta que abre o rascunho, do ponto de vista desta vez: `null` onde a pessoa não cria ticket em projeto nenhum. */
  private async draftToolFor(tx: TenantClient, principal: Principal, resolved: Resolved, projectId: string | undefined): Promise<DraftToolState | null> {
    if (!assistantSpeaksIn(resolved.conv)) return null;
    const top = resolved.conv.kind === "thread" ? await this.access.resolve(tx, principal, resolved.conv.parentId as string) : resolved;
    // Mensagem comum ao assistente: um `projectId` que não serve só tira a ferramenta (os 422 ficam para `creation: true`).
    const found = await this.creationProject(tx, principal, top, projectId, false);
    if ("none" in found) return null;
    if ("required" in found) return { kind: "blocked", reason: "project_required" };
    if (!(await this.hasOpenCreation(tx, principal))) return { kind: "ready" };
    // Só prepara a ferramenta bloqueada: o rascunho fechado reabre quando o modelo de fato a chama (`ChatToolExecutor`), não a cada mensagem.
    return { kind: "blocked", reason: "draft_open" };
  }

  /**
   * Primeira transação do pedido direto (`creation: true`): confere onde a pessoa está, a cota do assistente e o projeto (422
   * `project_required` quando há mais de um possível e nenhum foi dito), e lê o que a conversa de novo ticket envia ao provedor.
   */
  async prepareCreation(tx: TenantClient, principal: Principal, id: string, projectId: string | undefined, options: { quota: boolean }): Promise<{ project: ProjectRow; groups: string[] }> {
    const { top } = await this.creationHome(tx, principal, id);
    if (top.seen) this.access.writable(top.seen);
    if (options.quota) this.requireAssistantQuota(principal);
    const found = await this.creationProject(tx, principal, top, projectId);
    if ("required" in found) throw this.unprocessable("project_required", "Em que projeto criar o ticket? Você pode criar em mais de um: diga qual (o que está aberto no mapa).");
    if ("none" in found) throw this.unprocessable("project_unavailable", "Você não pode criar ticket em nenhum projeto que enxerga.");
    return { project: found.project, groups: await this.drafts.scopeGroupTitles(tx, found.project.id, undefined) };
  }

  /**
   * Segunda transação: confere tudo de novo e grava, numa só vez, a mensagem de abertura (na conversa principal), a conversa de novo ticket
   * com a primeira troca, a thread `creation` ligada a ela e, quando foi o assistente quem abriu, a resposta fixa dele onde a pessoa falou.
   * `assistant` é nulo no pedido direto.
   */
  async recordCreation(
    tx: TenantClient,
    principal: Principal,
    input: { id: string; text: string; request: string; projectId: string; requestedProjectId: string | undefined; turn: ConversationTurn; assistant: { model: string; seenLastSeq: number } | null },
  ) {
    const me = principal.person.id;
    const orgId = principal.organization.orgId;
    const { resolved, top } = await this.creationHome(tx, principal, input.id);
    if (top.seen) this.access.writable(top.seen);
    const found = await this.creationProject(tx, principal, top, input.requestedProjectId);
    if (!("project" in found) || found.project.id !== input.projectId) throw new ConflictException({ code: "creation_changed", message: "O projeto do rascunho mudou enquanto o assistente respondia. Tente de novo." });
    // O limite de um rascunho aberto vale entre árvores: trava por pessoa ANTES de reconferir (sempre nesta ordem, antes das travas de árvore).
    if (input.assistant) await tx.$queryRaw`select 1 as locked from (select pg_advisory_xact_lock(hashtextextended(${`creation-open:${me}`}::text, 0))) l`;
    // A árvore inteira é travada antes de gravar (como `openThread`); a vez do assistente, na conversa em que a pessoa falou.
    await tx.$queryRaw`select 1 from conversations where id = ${top.conv.rootId}::uuid for update`;
    if (input.assistant) {
      if (resolved.conv.id !== top.conv.rootId) await tx.$queryRaw`select 1 from conversations where id = ${resolved.conv.id}::uuid for update`;
      const last = await tx.conversationMessage.aggregate({ where: this.assistantScope(resolved.conv), _max: { seq: true } });
      if (Number(last._max.seq ?? 0n) !== input.assistant.seenLastSeq) throw new ConflictException({ code: "chat_changed", message: "A conversa mudou enquanto o assistente respondia. Recarregue e envie de novo." });
      // No máximo um rascunho aberto por vez quando é o assistente quem abre.
      if (await this.hasOpenCreation(tx, principal)) throw new ConflictException({ code: "creation_open", message: "Já existe um rascunho de ticket aberto: crie ou descarte antes de abrir outro." });
    }
    const opening = await tx.conversationMessage.create({ data: { orgId, conversationId: top.conv.id, authorPersonId: me, body: input.text }, select: MSG_SELECT });
    const draft = await this.drafts.create(tx, principal, found.project, input.text, input.turn);
    const threadId = randomUUID();
    await tx.conversation.create({
      data: {
        orgId,
        id: threadId,
        kind: "thread",
        purpose: "creation",
        title: creationTitleOf(input.turn.draft?.title) ?? creationTitleOf(input.text) ?? "Novo ticket",
        ownerPersonId: me,
        projectId: top.conv.projectId,
        ticketId: top.conv.ticketId,
        parentId: top.conv.id,
        rootId: top.conv.rootId,
        depth: top.conv.depth + 1,
        openingMessageId: opening.id,
        ticketConversationId: draft.id,
        lastActivityAt: opening.createdAt,
      },
    });
    await tx.conversationParticipant.create({ data: { orgId, conversationId: threadId, personId: me } });
    let reply: MessageRow | null = null;
    if (input.assistant) {
      const base = { orgId, conversationId: resolved.conv.id };
      // Numa thread de assunto a mensagem da pessoa também fica nela (a abertura mora na principal, que é onde a thread de criação nasce).
      if (resolved.conv.id !== top.conv.id) await tx.conversationMessage.create({ data: { ...base, authorPersonId: me, body: input.text } });
      reply = await tx.conversationMessage.create({ data: { ...base, body: creationOpenedBody(threadId, input.request), model: input.assistant.model }, select: MSG_SELECT });
      await tx.conversation.updateMany({ where: { id: resolved.conv.id }, data: { lastActivityAt: reply.createdAt, turnStartedAt: null } });
    }
    await tx.conversation.updateMany({ where: { id: top.conv.id }, data: { lastActivityAt: (reply ?? opening).createdAt } });
    await this.reopen(tx, me, [top.conv.id, resolved.conv.id]);
    const card = (await this.cards(tx, principal, [threadId])).get(threadId) as ThreadCard;
    const people = await this.people(tx, [me]);
    return {
      message: this.message(opening, people, principal, ALL_READ, card),
      thread: card,
      reply: reply ? this.message(reply, people, principal, ALL_READ) : null,
      ticketConversationId: draft.id,
    };
  }

  /** O ticket de onde veio a conversa de novo ticket, para a procura do lugar começar por ele; `null` quando nasceu no Meu chat ou sem thread. */
  async creationOrigin(tx: TenantClient, ticketConversationId: string): Promise<string | null> {
    return (await tx.conversation.findFirst({ where: { ticketConversationId, purpose: "creation" }, select: { ticketId: true } }))?.ticketId ?? null;
  }

  /** Os elos (conversa de novo ticket) das threads de criação da pessoa. */
  async creationLinkedIds(tx: TenantClient, me: string): Promise<string[]> {
    const rows = await tx.conversation.findMany({ where: { purpose: "creation", ownerPersonId: me, ticketConversationId: { not: null } }, select: { ticketConversationId: true } });
    return rows.flatMap((r) => (r.ticketConversationId ? [r.ticketConversationId] : []));
  }

  /** A conversa de novo ticket tem thread e já virou ticket: não há o que descartar. */
  async creationThreadExists(tx: TenantClient, ticketConversationId: string): Promise<boolean> {
    return (await tx.conversation.count({ where: { ticketConversationId, purpose: "creation" } })) > 0;
  }

  /**
   * Ao criar o ticket: a conversa principal de quem criou, no ticket novo, é aberta (ou obtida) e recebe uma cópia das mensagens da criação,
   * na ordem e com as datas originais, para a conversa que explica o ticket ficar com ele. Só quando há thread (a conversa de novo ticket
   * sozinha, das rotas antigas, não copia nada). A criação é idempotente e este método só roda na primeira vez.
   */
  async copyCreationToTicket(tx: TenantClient, principal: Principal, input: { ticketConversationId: string; ticketId: string }): Promise<void> {
    if (!(await this.creationThreadExists(tx, input.ticketConversationId))) return;
    const me = principal.person.id;
    const target = await this.openTicket(tx, principal, input.ticketId);
    const rows = await tx.ticketConversationMessage.findMany({ where: { conversationId: input.ticketConversationId }, orderBy: { position: "asc" }, select: { author: true, body: true, model: true, createdAt: true } });
    // O corpo da conversa de novo ticket aceita até 20.000 caracteres; o da conversa comum, 4.000 (pessoa) e 8.000 (assistente).
    const fit = (text: string, max: number): string => {
      // O limite é em unidades UTF-16 (como `chatBodyOf`), mas o corte nunca parte um par substituto (emoji) ao meio.
      const clean = Array.from(text).filter((ch) => !hasForbiddenChatChars(ch)).join("").trim();
      let cut = clean.slice(0, max);
      const tail = cut.charCodeAt(cut.length - 1);
      if (cut.length < clean.length && tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1);
      return cut.trim() || "…";
    };
    await tx.conversationMessage.createMany({
      data: rows.map((r) =>
        r.author === "person"
          ? { orgId: principal.organization.orgId, conversationId: target.id, authorPersonId: me, body: fit(r.body, 4000), createdAt: r.createdAt }
          : { orgId: principal.organization.orgId, conversationId: target.id, body: fit(r.body, 8000), model: r.model ?? "assistente", createdAt: r.createdAt },
      ),
    });
    const last = rows.at(-1);
    if (last) await tx.conversation.updateMany({ where: { id: target.id }, data: { lastActivityAt: last.createdAt } });
    // O que foi copiado já é da pessoa que criou: não conta como não lido para ela.
    const newest = (await tx.conversationMessage.aggregate({ where: { conversationId: target.id }, _max: { seq: true } }))._max.seq;
    if (newest !== null) await tx.conversationParticipant.updateMany({ where: { conversationId: target.id, personId: me, lastReadSeq: { lt: newest } }, data: { lastReadSeq: newest } });
  }

  // ---- o que vai ao provedor ----------------------------------------------------------------------------

  /**
   * O contexto do ticket para o assistente (ADR 0049), lido agora, com `select` explícito: título, descrição, situação, prioridade que
   * vale, caminho até a raiz, filhos, dependências e "relacionado a" (ADR 0061; chave, título e situação, nunca a origem no Linear). Nunca comentários, histórico, áreas, nota do marcador
   * de trabalho nem qualquer dado de pessoa; nenhum id sai daqui.
   */
  private async context(tx: TenantClient, { project, ticket }: Visible): Promise<ChatTicketContext> {
    const key = (number: number) => `${project.key}-${number}`;
    const ref = (t: { number: number; title: string; status: string }): ChatTicketRef => ({ key: key(t.number), title: t.title, status: t.status });
    const scope = scopeOf(project);
    const [priorities, ancestors, children, dependsOn, blocks, relatedFrom, relatedTo] = await Promise.all([
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
      // `related` é uma linha por par, com o menor id em `from`: o ticket pode estar de qualquer lado.
      tx.ticketRelation.findMany({ where: { kind: "related", fromTicketId: ticket.id }, orderBy: { to: { number: "asc" } }, take: CHAT_CONTEXT_MAX_RELATED, select: { to: { select: { number: true, title: true, status: true } } } }),
      tx.ticketRelation.findMany({ where: { kind: "related", toTicketId: ticket.id }, orderBy: { from: { number: "asc" } }, take: CHAT_CONTEXT_MAX_RELATED, select: { from: { select: { number: true, title: true, status: true } } } }),
    ]);
    const related = [...relatedFrom.map((r) => r.to), ...relatedTo.map((r) => r.from)].sort((a, b) => a.number - b.number).slice(0, CHAT_CONTEXT_MAX_RELATED);
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
      related: related.map(ref),
    };
  }
}
