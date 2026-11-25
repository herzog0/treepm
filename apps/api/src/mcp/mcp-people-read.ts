import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import type { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import type { ConversationService, McpConversation } from "../assistant/conversation.service.js";
import { commentArea, commentSelect } from "../tickets/ticket-comments.service.js";
import type { ActivityEntry } from "../tickets/ticket-activity.schema.js";
import { parseActivityCursor } from "../tickets/ticket-activity.service.js";
import type { TicketActivityService } from "../tickets/ticket-activity.service.js";
import { MAX_RESULT_CHARS, ToolInputError } from "./mcp-tools.js";
import type { RunInTenant, ToolContext } from "./mcp-tools.js";
import { cleanMentions, countFitting, fitPage, shrinkItem } from "./mcp-text.js";
import type { CleanText } from "./mcp-text.js";
import { PERSON_NAME_SELECT, mcpLinearAuthorRef, mcpPersonRef } from "./person-name.js";

/**
 * Comentários, histórico e conversas pelo MCP (ADR 0062, seção 4, fatia 3). Só leitura e só com o alcance "pessoas e conversas" efetivo.
 * Cada ferramenta lê pelo MESMO serviço ou pela MESMA consulta que a tela usa para a mesma coisa, com o `Principal` da dona do token: ela
 * nunca vê pelo MCP o que não vê na tela. Todo nome de pessoa sai por `person-name.ts`; e-mail e id do Clerk nunca saem. Nenhum texto de
 * comentário, evento ou mensagem vai para log.
 */

const KEY = z.string().trim().max(32, "Ticket key is too long.").regex(/^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$/, "Ticket key must look like PROJ-123.");
const AFTER = z.string().max(600, "Invalid cursor.").describe("The `next` value of the previous page; omit for the first page.");
const LIMIT = (def: number) => z.number().int().min(1).max(50).optional().describe(`Page size (default ${def}, at most 50). A page can be shorter when the answer gets too large; \`next\` always continues from the last item returned.`);

export const listCommentsInput = z.strictObject({ key: KEY.describe("Ticket key of this project, for example PROJ-47."), limit: LIMIT(25), after: AFTER.optional() });
export const getTicketHistoryInput = z.strictObject({ key: KEY.describe("Ticket key of this project, for example PROJ-47."), limit: LIMIT(30), after: AFTER.optional() });
export const listConversationsInput = z.strictObject({ limit: LIMIT(20), after: AFTER.optional() });
export const getConversationInput = z.strictObject({ id: z.string().trim().max(64).describe("Conversation id, from list_conversations."), limit: LIMIT(30), after: AFTER.optional() });

const personRef = z.strictObject({ id: z.string().describe("Person id."), name: z.string() });
const next = z.string().nullable().describe("Pass as `after` to get the next page; null when there is no more.");
const truncated = z.literal(true).optional().describe("Present when this item alone was larger than one answer can carry: its longest text was cut (it ends with …) or its longest list was shortened.");
/** O autor de um comentário trazido do Linear que não é pessoa do TreePM: sem id, com "(Linear)" no nome. */
const linearAuthorRef = z.strictObject({ id: z.null().describe("No TreePM person: the author wrote it in Linear."), name: z.string() });
const commentSchema = z.strictObject({
  id: z.string(),
  author: z.union([personRef, linearAuthorRef]).nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  body: z.string().describe("The comment text. A mention of a person is written as @Name; a mention of a ticket stays as its key."),
  via: z.enum(["mcp", "linear"]).optional().describe("mcp: written through MCP; linear: brought from Linear by a sync."),
  area: z.string().optional().describe("Present on a comment written in an area's conversation: the area name."),
  truncated,
});
const conversationSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["ticket", "general", "thread"]).describe("ticket: a person's chat on a ticket; general: the project chat; thread: a thread inside another conversation."),
  purpose: z.enum(["people", "topic", "creation"]).optional().describe("Only on threads: people (between people), topic (a subject with the assistant) or creation (a draft of a new ticket)."),
  ticket: z.string().optional().describe("Key of the ticket the conversation is about."),
  title: z.string().nullable().describe("The subject as the TreePM sidebar shows it: the title, or the start of the message that opened the thread."),
  participants: z.array(personRef),
  lastMessageAt: z.string(),
  closed: z.boolean().describe("True when the owner of the token closed the conversation (it is still readable)."),
  parentId: z.string().optional().describe("The conversation this thread hangs from, only when the owner of the token can read it too."),
  creation: z.strictObject({ state: z.string(), ticket: z.string().optional() }).optional().describe("Only on creation threads: the state of the draft and, once created, the ticket key. The draft itself is not returned."),
  truncated,
});
const messageSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["message", "creation_opened"]).describe("creation_opened marks the point where the assistant opened a ticket draft; it has no text."),
  author: z.union([personRef, z.literal("assistant")]).nullable(),
  at: z.string(),
  body: z.string().optional().describe("The message text. A mention of a person is written as @Name."),
  truncated,
});

export const listCommentsOutput = z.strictObject({ comments: z.array(commentSchema), next });
export const getTicketHistoryOutput = z.strictObject({ events: z.array(z.looseObject({ at: z.string(), kind: z.string(), truncated })), next });
export const listConversationsOutput = z.strictObject({ conversations: z.array(conversationSchema), next });
export const getConversationOutput = z.strictObject({ conversation: conversationSchema, messages: z.array(messageSchema), next });

const SCOPE_NOTE = ' Names and texts of other people leave TreePM through this tool because the organization turned on the "People and conversations" scope and this token has it.';

/** Só existem com o alcance de pessoas efetivo (ADR 0062). */
export const PEOPLE_COMMENT_TOOL_DEFINITIONS = {
  list_comments: {
    title: "List the comments of a ticket",
    description: `The comments of one ticket, from the oldest to the newest, as the ticket page shows them: author (id and name), date, edit date, text, and the area for comments written in an area's conversation. Removed comments are not returned. Pages of up to 50 comments (default 25); the answer is also cut when it gets too large (about 80,000 characters), and \`next\` continues from the last comment returned; a single comment larger than that comes cut, with \`truncated: true\`.${SCOPE_NOTE}`,
    inputSchema: listCommentsInput,
    outputSchema: listCommentsOutput,
  },
  get_ticket_history: {
    title: "Get the history of a ticket",
    description: `The timeline of one ticket, from the newest to the oldest, as the ticket page shows it: what changed (title, status, priority, parent, assignees, dependencies, areas, idea stages, agent work marks), who did it and when. Comments appear only as \`comment\` entries without text; use list_comments for the text. Only a fixed list of fields per kind of event is returned. Pages of up to 50 entries (default 30), shorter when the answer gets too large (about 80,000 characters), continued with \`next\`; a single entry larger than that comes cut, with \`truncated: true\`.${SCOPE_NOTE}`,
    inputSchema: getTicketHistoryInput,
    outputSchema: getTicketHistoryOutput,
  },
  list_conversations: {
    title: "List the conversations of the project",
    description: `The conversations of this project that the owner of the token takes part in, the same ones the TreePM sidebar lists for that person (ticket chats, threads she is in, and the ones she closed, with closed: true), most recent first. Conversations of other people, of other projects and the personal "My chat" (and its threads) are never returned. Pages of up to 50 (default 20), shorter when the answer gets too large (about 80,000 characters), continued with \`next\`. Read the messages with get_conversation.${SCOPE_NOTE}`,
    inputSchema: listConversationsInput,
    outputSchema: listConversationsOutput,
  },
  get_conversation: {
    title: "Read a conversation",
    description: `The messages of one conversation of this project that the owner of the token takes part in, from the oldest to the newest, with the author of each (a person, or "assistant" for the TreePM assistant). A conversation that does not exist, belongs to someone else or to another project all answer the same short error. Pages of up to 50 messages (default 30); the answer, header included, is also cut when it gets too large (about 80,000 characters), and \`next\` continues from the last message returned; a single message (or header) larger than that comes cut, with \`truncated: true\`.${SCOPE_NOTE}`,
    inputSchema: getConversationInput,
    outputSchema: getConversationOutput,
  },
} as const;

export const PEOPLE_READ_TOOL_NAMES = ["list_comments", "get_ticket_history", "list_conversations", "get_conversation"] as const;

/** O que as quatro ferramentas precisam, o mesmo que a tela usa. */
export type PeopleReadServices = { activity: TicketActivityService; conversations: ConversationService; authorization: AuthorizationService };

// ---- nomes e texto ------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Ref = { id: string; name: string };

/** `{ id, name }` das pessoas pedidas (as que a organização enxerga), SEMPRE por `mcpPersonRef`. */
async function personRefs(tx: TenantClient, ids: Iterable<string | null | undefined>): Promise<Map<string, Ref>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.person.findMany({ where: { id: { in: wanted } }, select: PERSON_NAME_SELECT });
  return new Map(rows.map((row) => [row.id, mcpPersonRef(row)]));
}

/**
 * O limpador de texto das quatro ferramentas: resolve de uma vez os nomes das pessoas citadas (pela mesma função de todo nome do MCP; o
 * nome guardado no elo pode ser o e-mail) e devolve `cleanMentions` com eles (`mcp-text.ts`, tempo linear). TODO texto livre que sai passa
 * por aqui e sai como `CleanText`; o resto é de formato fechado (enum, data, chave, id).
 */
async function textCleaner(tx: TenantClient, texts: readonly string[]): Promise<(text: string) => CleanText> {
  const ids = texts.flatMap((text) => Array.from(text.matchAll(/person:\s*([A-Za-z0-9_-]+)/gi), (match) => (match[1] as string).toLowerCase()));
  const names = await personRefs(tx, ids);
  return (text) => cleanMentions(text, (id) => names.get(id)?.name);
}

// ---- cursores -----------------------------------------------------------------------------------------------------

const invalidCursor = (): ToolInputError => new ToolInputError("Invalid cursor.");
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decode<T extends z.ZodType>(raw: string, schema: T): z.output<T> {
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw invalidCursor();
  }
}
const uuidField = z.string().regex(UUID);
/** Um instante que o PostgreSQL aceita (anos 1 a 9999), em milissegundos: fora disso o cursor é inválido, não uma falha do banco. */
const instant = z.number().int().min(-62_135_596_800_000).max(253_402_300_799_999);
const commentCursor = z.strictObject({ k: z.literal("c"), t: uuidField, a: instant, i: uuidField });
/** O cursor da tela vai dentro, e é conferido inteiro pelo mesmo esquema estrito que a tela usa. */
const historyCursor = z.strictObject({ k: z.literal("h"), t: uuidField, b: z.string().min(1).max(500).refine((b) => parseActivityCursor(b) !== null) });
const listCursor = z.strictObject({ k: z.literal("l"), a: instant, i: uuidField });
const messageCursor = z.strictObject({ k: z.literal("m"), c: uuidField, s: z.string().regex(/^[0-9]{1,18}$/) });

/** O teto de `MAX_RESULT_CHARS` por resposta: a lista de itens (e o cabeçalho, quando há) cabe em `BUDGET`; a folga é do envelope e do `next`. */
const ENVELOPE_ROOM = 1_000;
const BUDGET = MAX_RESULT_CHARS - ENVELOPE_ROOM;
/** O cabeçalho de `get_conversation` usa no máximo metade do teto: sempre sobra lugar para mensagens. */
const HEADER_BUDGET = Math.floor(BUDGET / 2);

// ---- o histórico: o que PODE sair, por tipo de evento -----------------------------------------------------------

type Entry<K extends ActivityEntry["type"]> = Extract<ActivityEntry, { type: K }>;
/** Chave de ticket conferida pelo formato; data ISO conferida pelo formato. */
type TicketKey = string & { readonly __ticketKey: unique symbol };
type IsoDate = string & { readonly __isoDate: unique symbol };
/** Os valores de formato fechado (enums) que as entradas trazem. */
type Closed = Entry<"status_changed">["from"] | Entry<"contribution_status_changed">["from"] | Entry<"idea_stage_changed">["from"] | Entry<"summary_updated">["source"] | Entry<"agent_work_ended">["reason"] | "mcp";
/**
 * O que um campo do histórico pode ser: texto que passou pelo limpador, chave ou data conferidas, enum, pessoa por `person-name.ts`,
 * número, booleano ou nulo. Texto cru (`string`) não cabe aqui: um campo novo de texto livre não compila sem passar pelo limpador.
 */
export type HistoryValue = CleanText | TicketKey | IsoDate | Closed | ActivityEntry["type"] | Ref | boolean | number | null | undefined;
/** Uma entrada do histórico como sai: instante, tipo e só campos de `HistoryValue`. */
type HistoryEvent = { at: IsoDate; kind: ActivityEntry["type"] } & Record<string, HistoryValue>;
type HistoryContext = {
  person: (person: { id: string } | null) => Ref | null;
  /** A chave, só quando tem o formato de chave de ticket; `undefined` (o campo é omitido) fora disso. */
  ticket: (ticket: { key: string | null } | null) => TicketKey | null | undefined;
  text: (text: string) => CleanText;
  /** A data, só quando tem o formato ISO; `undefined` (o campo é omitido) fora disso. */
  date: (value: string) => IsoDate | undefined;
};
type FieldsOf = { [K in ActivityEntry["type"]]: (entry: Entry<K>, context: HistoryContext) => Record<string, HistoryValue> };
const area = (entry: { area: { name: string } | null }, c: HistoryContext) => ({ area: entry.area ? c.text(entry.area.name) : null });
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * A lista, por tipo de entrada da atividade do ticket, dos campos que PODEM sair (ADR 0062: o histórico é filtrado por lista do que
 * sai, não por lista do que se tira). Um tipo desconhecido sai só com `kind` e `at`. Nada aqui lê login do GitHub, identificador de token,
 * o administrador de um "entrar como", id de ticket ou de área: a entrada da atividade da tela já não os traz, e esta lista só repete o
 * que é seguro. Um teste estrutural falha quando um tipo novo de entrada não tem linha aqui.
 */
export const HISTORY_FIELDS: FieldsOf = {
  created: () => ({}),
  title_changed: (entry, c) => ({ from: c.text(entry.from), to: c.text(entry.to) }),
  description_changed: () => ({}),
  // Só a contagem: nada do Linear (nome, corpo, id) vai junto.
  comments_imported: (entry) => ({ count: entry.count }),
  status_changed: (entry, c) => ({ from: entry.from, to: entry.to, automatic: entry.automatic, causedBy: c.ticket(entry.causedBy) }),
  priority_changed: (entry) => ({ from: entry.from, to: entry.to }),
  parent_changed: (entry, c) => ({ from: c.ticket(entry.from), to: c.ticket(entry.to) }),
  assignee_added: (entry, c) => ({ person: c.person(entry.person) }),
  assignee_removed: (entry, c) => ({ person: c.person(entry.person) }),
  dependency_added: (entry, c) => ({ ticket: c.ticket(entry.ticket) }),
  dependency_removed: (entry, c) => ({ ticket: c.ticket(entry.ticket) }),
  summary_updated: (entry) => ({ source: entry.source }),
  contribution_added: area,
  contribution_removed: area,
  contribution_text_changed: area,
  contribution_status_changed: (entry, c) => ({ ...area(entry, c), from: entry.from, to: entry.to }),
  contribution_person_added: (entry, c) => ({ ...area(entry, c), person: c.person(entry.person) }),
  contribution_person_removed: (entry, c) => ({ ...area(entry, c), person: c.person(entry.person) }),
  agent_work_started: (entry, c) => ({ until: c.date(entry.until) }),
  agent_work_ended: (entry) => ({ reason: entry.reason }),
  idea_registered: () => ({}),
  idea_stage_changed: (entry) => ({ from: entry.from, to: entry.to }),
  idea_accepted: () => ({}),
  idea_discarded: () => ({}),
  idea_reopened: () => ({}),
  comment: (entry, c) => ({ ...area(entry, c), removed: entry.removed }),
};

/**
 * O que sai de cada item. Todo texto livre é `CleanText` (só o limpador o produz): um campo novo de texto livre não compila sem passar por
 * ele. O resto é de formato fechado: id, data ISO, enum, chave de ticket lida do banco, pessoa por `person-name.ts`.
 */
export type CommentOut = { id: string; author: Ref | { id: null; name: string } | null; createdAt: string; editedAt: string | null; body: CleanText; via?: "mcp" | "linear"; area?: CleanText; truncated?: true };
export type MessageOut = { id: string; kind: "message" | "creation_opened"; author: Ref | "assistant" | null; at: string; body?: CleanText; truncated?: true };
export type ConversationOut = {
  id: string;
  kind: McpConversation["kind"];
  purpose?: NonNullable<McpConversation["purpose"]>;
  ticket?: string;
  title: CleanText | null;
  participants: Ref[];
  lastMessageAt: string;
  closed: boolean;
  parentId?: string;
  creation?: { state: string; ticket?: string };
  truncated?: true;
};

/**
 * Executa as quatro ferramentas. Recebe a identidade e o projeto já resolvidos, como `ProjectTools`; cada chamada abre a sua transação.
 */
export class PeopleReadTools {
  constructor(
    private readonly run: RunInTenant,
    private readonly services: PeopleReadServices,
    private readonly context: ToolContext,
    private readonly ticketNumber: (key: string) => number,
  ) {}

  private get principal(): Principal {
    return this.context.principal;
  }

  /** O ticket e o projeto, só se a pessoa enxerga o projeto (como a tela): o resto é "não existe". */
  private async ticketOf(tx: TenantClient, number: number): Promise<{ project: NonNullable<Awaited<ReturnType<TenantClient["project"]["findFirst"]>>>; ticket: { id: string; createdByPersonId: string; createdAt: Date } }> {
    const missing = new ToolInputError(`Ticket ${this.context.project.key}-${number} does not exist in this project.`);
    const project = await tx.project.findFirst({ where: { id: this.context.project.id } });
    if (!project || !this.services.authorization.canView(this.principal.actor, project)) throw missing;
    const ticket = await tx.ticket.findFirst({ where: { projectId: project.id, number }, select: { id: true, createdByPersonId: true, createdAt: true } });
    if (!ticket) throw missing;
    return { project, ticket };
  }

  async listComments(input: z.infer<typeof listCommentsInput>): Promise<z.infer<typeof listCommentsOutput>> {
    const number = this.ticketNumber(input.key);
    const limit = input.limit ?? 25;
    return this.run(this.principal, async (tx) => {
      const { ticket } = await this.ticketOf(tx, number);
      const after = input.after === undefined ? null : decode(input.after, commentCursor);
      if (after !== null && after.t !== ticket.id) throw invalidCursor();
      const keyset = after ? [{ OR: [{ createdAt: { gt: new Date(after.a) } }, { createdAt: new Date(after.a), id: { gt: after.i } }] }] : [];
      // Os mesmos comentários que a atividade da tela mostra (os removidos não entram), na mesma ordem total, do mais antigo ao mais novo.
      const rows = await tx.ticketComment.findMany({ where: { AND: [{ ticketId: ticket.id, removedAt: null }, ...keyset] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit + 1, select: commentSelect });
      // Corta pelo texto cru e só então limpa: só os comentários que vão sair passam pelo limpador.
      const page = await fitPage(rows.slice(0, limit), BUDGET, (row) => ({ id: row.id, author: row.authorPersonId, body: row.body, area: commentArea(row)?.name ?? null }), async (some) => {
        const [refs, clean] = await Promise.all([personRefs(tx, some.flatMap((row) => (row.authorPersonId === null ? [] : [row.authorPersonId]))), textCleaner(tx, some.flatMap((row) => [row.body, commentArea(row)?.name ?? ""]))]);
        return some.map((row): CommentOut => {
          const name = commentArea(row)?.name;
          return {
            id: row.id,
            author: row.authorPersonId === null ? (row.via === "linear" ? mcpLinearAuthorRef(row.externalAuthorName) : null) : (refs.get(row.authorPersonId) ?? null),
            createdAt: row.createdAt.toISOString(),
            editedAt: row.editedAt ? row.editedAt.toISOString() : null,
            body: clean(row.body),
            ...(row.via === "mcp" || row.via === "linear" ? { via: row.via } : {}),
            ...(name === undefined ? {} : { area: clean(name) }),
          };
        });
      });
      const more = rows.length > limit || page.cut;
      const last = page.kept.at(-1)?.row;
      return { comments: page.kept.map((item) => item.out), next: more && last ? encode({ k: "c", t: ticket.id, a: last.createdAt.getTime(), i: last.id }) : null };
    });
  }

  async getTicketHistory(input: z.infer<typeof getTicketHistoryInput>): Promise<z.infer<typeof getTicketHistoryOutput>> {
    const number = this.ticketNumber(input.key);
    return this.run(this.principal, async (tx) => {
      const { project, ticket } = await this.ticketOf(tx, number);
      const cursor = input.after === undefined ? null : decode(input.after, historyCursor);
      if (cursor !== null && cursor.t !== ticket.id) throw invalidCursor();
      const viewer = { personId: this.principal.person.id, actor: this.principal.actor };
      // A leitura da página do ticket, inteira: a tela e o MCP têm a mesma sequência de entradas. O cursor da tela é a posição da última
      // entrada devolvida, então a página não se corta no meio: lê de novo com o limite que cabe (as primeiras entradas são as mesmas).
      const read = (limit: number) =>
        this.services.activity.read(tx, project, ticket, { limit, ...(cursor ? { before: cursor.b } : {}) }, viewer).catch((error: unknown) => {
          if (error instanceof BadRequestException) throw invalidCursor();
          throw error;
        });
      let limit = input.limit ?? 30;
      let page = await read(limit);
      // Primeiro pelo tamanho cru (sem limpar nada), depois pelo limpo.
      const rawFit = countFitting(page.entries, BUDGET);
      if (rawFit < page.entries.length) {
        limit = rawFit;
        page = await read(limit);
      }
      for (;;) {
        const events = await this.historyEvents(tx, page.entries);
        const fit = countFitting(events, BUDGET);
        const answer = (list: typeof events) => ({ events: list, next: page.before === null ? null : encode({ k: "h", t: ticket.id, b: page.before }) });
        if (fit >= events.length) {
          const only = events[0];
          // Uma entrada sozinha maior que o teto sai cortada, com a marca.
          return answer(events.length === 1 && only && JSON.stringify(events).length > BUDGET ? [shrinkItem(only, BUDGET - 2)] : events);
        }
        limit = Math.max(1, fit);
        page = await read(limit);
      }
    });
  }

  private async historyEvents(tx: TenantClient, entries: readonly ActivityEntry[]): Promise<HistoryEvent[]> {
    const personIds = entries.flatMap((entry) => [entry.actor?.id, "person" in entry ? entry.person?.id : undefined]);
    const texts = entries.flatMap((entry) => [...(entry.type === "title_changed" ? [entry.from, entry.to] : []), ...("area" in entry && entry.area ? [entry.area.name] : [])]);
    const [refs, clean] = await Promise.all([personRefs(tx, personIds), textCleaner(tx, texts)]);
    const context: HistoryContext = {
      person: (person) => (person ? (refs.get(person.id) ?? null) : null),
      ticket: (ticket) => (ticket === null || ticket.key === null ? null : TICKET_KEY.test(ticket.key) ? (ticket.key as TicketKey) : undefined),
      text: clean,
      date: (value) => (ISO_DATE.test(value) ? (value as IsoDate) : undefined),
    };
    const fields = HISTORY_FIELDS as Record<string, ((entry: ActivityEntry, context: HistoryContext) => Record<string, HistoryValue>) | undefined>;
    return entries.map((entry) => {
      const pick = Object.hasOwn(fields, entry.type) ? fields[entry.type] : undefined;
      // Tipo que esta lista não conhece: só o tipo e o instante.
      // `occurredAt` é a data ISO que a própria leitura da tela monta.
      const at = entry.occurredAt as IsoDate;
      if (!pick) return { at, kind: entry.type } as HistoryEvent;
      const picked = Object.fromEntries(Object.entries(pick(entry, context)).filter(([, value]) => value !== undefined));
      return {
        at,
        kind: entry.type,
        actor: context.person(entry.actor),
        ...(entry.via === "mcp" ? { via: "mcp" as const } : {}),
        ...(entry.automatic === true ? { automatic: true } : {}),
        ...picked,
      };
    });
  }

  async listConversations(input: z.infer<typeof listConversationsInput>): Promise<z.infer<typeof listConversationsOutput>> {
    const limit = input.limit ?? 20;
    return this.run(this.principal, async (tx) => {
      const after = input.after === undefined ? null : decode(input.after, listCursor);
      const found = await this.services.conversations.mcpList(tx, this.principal, this.context.project.id, { after: after ? { at: new Date(after.a), id: after.i } : null, limit });
      const page = await fitPage(found.items, BUDGET, (conv) => conv, (some) => this.conversationItems(tx, some));
      const more = found.more || page.cut;
      const last = page.kept.at(-1)?.row;
      return { conversations: page.kept.map((item) => item.out), next: more && last ? encode({ k: "l", a: last.lastActivityAt.getTime(), i: last.id }) : null };
    });
  }

  async getConversation(input: z.infer<typeof getConversationInput>): Promise<z.infer<typeof getConversationOutput>> {
    const limit = input.limit ?? 30;
    // Inexistente, de outra pessoa, de outro projeto, do Meu chat ou id que nem é um id: a MESMA resposta curta.
    const missing = new ToolInputError("Conversation not found.");
    if (!UUID.test(input.id)) throw missing;
    const id = input.id.toLowerCase();
    return this.run(this.principal, async (tx) => {
      const after = input.after === undefined ? null : decode(input.after, messageCursor);
      if (after !== null && after.c !== id) throw invalidCursor();
      const found = await this.services.conversations.mcpMessages(tx, this.principal, this.context.project.id, id, { afterSeq: after ? BigInt(after.s) : null, limit }).catch((error: unknown) => {
        if (error instanceof NotFoundException) throw missing;
        throw error;
      });
      // O cabeçalho (participantes, título) entra na conta do teto, e nunca passa da metade dele.
      const [built] = await this.conversationItems(tx, [found.conversation]);
      if (!built) throw missing;
      const header = JSON.stringify(built).length > HEADER_BUDGET ? shrinkItem(built, HEADER_BUDGET) : built;
      const page = await fitPage(found.messages, BUDGET - JSON.stringify(header).length, (message) => ({ id: message.id, author: message.authorPersonId, body: message.body }), async (some) => {
        const [refs, clean] = await Promise.all([personRefs(tx, some.map((message) => message.authorPersonId)), textCleaner(tx, some.map((message) => message.body))]);
        return some.map(
          (message): MessageOut => ({
            id: message.id,
            kind: message.marker ?? "message",
            author: message.authorPersonId === null ? "assistant" : (refs.get(message.authorPersonId) ?? null),
            at: message.createdAt.toISOString(),
            ...(message.marker === null ? { body: clean(message.body) } : {}),
          }),
        );
      });
      const more = found.more || page.cut;
      const last = page.kept.at(-1)?.row;
      return { conversation: header, messages: page.kept.map((item) => item.out), next: more && last ? encode({ k: "m", c: id, s: last.seq.toString() }) : null };
    });
  }

  /** O cabeçalho de cada conversa: participantes pelo nome, título limpo de menção, estado. */
  private async conversationItems(tx: TenantClient, convs: readonly McpConversation[]): Promise<ConversationOut[]> {
    const [refs, clean] = await Promise.all([
      personRefs(tx, convs.flatMap((conv) => conv.participantIds)),
      textCleaner(tx, convs.flatMap((conv) => [conv.title, conv.openingBody].filter((text): text is string => text !== null))),
    ]);
    return convs.map((conv): ConversationOut => {
      const title = conv.title !== null ? clean(conv.title) : conv.openingBody !== null ? (clean(conv.openingBody).slice(0, 80) as CleanText) : null;
      return {
        id: conv.id,
        kind: conv.kind,
        ...(conv.kind === "thread" && conv.purpose !== null ? { purpose: conv.purpose } : {}),
        ...(conv.ticketKey === null ? {} : { ticket: conv.ticketKey }),
        title,
        participants: conv.participantIds.flatMap((personId) => (refs.get(personId) ? [refs.get(personId) as Ref] : [])),
        lastMessageAt: conv.lastActivityAt.toISOString(),
        closed: conv.closed,
        ...(conv.parentId === null ? {} : { parentId: conv.parentId }),
        ...(conv.creation === null ? {} : { creation: { state: conv.creation.state, ...(conv.creation.ticketKey === null ? {} : { ticket: conv.creation.ticketKey }) } }),
      };
    });
  }
}
