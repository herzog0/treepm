import { CHAT_BODY_MAX, CHAT_MAX_MENTIONS, hasForbiddenChatChars } from "@treepm/domain";
import { z } from "zod";
import { idSchema } from "../common/schemas.js";

/** Tamanho de uma mensagem do chat (ADR 0049): 1 a 4.000 caracteres, depois de aparada. */
export const chatBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_BODY_MAX)
  .refine((body) => !hasForbiddenChatChars(body), "caractere inválido");

/** Cursor opaco (ver `chat-cursor.ts`); quem o confere é o serviço (`400 invalid_cursor`). */
const cursorSchema = z.string().min(1).max(64);

/**
 * Mandar uma mensagem. Com `mentions` (ids de pessoas, escolhidos na tela), a mensagem NÃO vai ao assistente: vira a raiz de uma
 * thread. O texto fica como a pessoa o escreveu; quem é mencionado é só o que está em `mentions`, nunca lido do texto. A lista
 * pode vir maior que o limite (a API a recusa com erro claro, não com 400 genérico).
 */
export const sendMessageBodySchema = z
  .object({ body: chatBodySchema, mentions: z.array(idSchema).max(200).optional() })
  .strict();

export const replyBodySchema = sendMessageBodySchema;

/** Marcar como lido: até onde a tela mostrou (`cursor` da mensagem mais nova que ela exibiu); ausente = tudo o que a pessoa pode ler. */
export const markReadBodySchema = z.object({ upTo: cursorSchema.optional() }).strict();

/** Página: as mais recentes primeiro; `before` é o `nextBefore` da página anterior. */
export const pageQuerySchema = z
  .object({
    before: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export const personRefSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });

export const chatMessageSchema = z.object({
  id: z.string(),
  /** Posição opaca da mensagem: serve de `before` (página) e de `upTo` (leitura). Não revela ordem nem volume; compare só por igualdade. */
  cursor: z.string(),
  /** De outra pessoa (ou do assistente) e depois do ponto de leitura de quem pede. */
  unread: z.boolean(),
  authorKind: z.enum(["person", "assistant"]),
  /** Quem escreveu; `null` quando é o assistente. */
  author: personRefSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  /** O modelo que respondeu; só nas mensagens do assistente. */
  model: z.string().nullable(),
  /** A thread a que pertence (o id da mensagem-raiz); `null` na conversa com o assistente. */
  threadId: z.string().nullable(),
});

export const chatTicketSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  projectId: z.string(),
  /** Projeto arquivado: lê-se, não se escreve. */
  archived: z.boolean(),
});

export const threadSummarySchema = z.object({
  /** O id da mensagem-raiz. */
  id: z.string(),
  ticketId: z.string(),
  root: chatMessageSchema,
  replyCount: z.number(),
  lastMessageAt: z.string(),
  /** Mensagens de outras pessoas, nesta thread, depois do ponto de leitura de quem pede. */
  unread: z.number(),
  startedByMe: z.boolean(),
  participants: z.array(personRefSchema),
});

const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextBefore: z.string().nullable() });

export const chatViewSchema = z.object({
  ticket: chatTicketSchema,
  /** `null` enquanto a pessoa nunca escreveu nem foi mencionada neste ticket (o chat nasce na primeira mensagem). */
  chatId: z.string().nullable(),
  assignedToMe: z.boolean(),
  /** Cursor do ponto de leitura; `null` = nada lido ainda. */
  lastRead: z.string().nullable(),
  unread: z.number(),
  messages: pageOf(chatMessageSchema),
  threads: z.array(threadSummarySchema),
});

export const threadViewSchema = z.object({
  ticket: chatTicketSchema,
  thread: threadSummarySchema,
  replies: pageOf(chatMessageSchema),
});

export const sendResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant"), message: chatMessageSchema, reply: chatMessageSchema }),
  z.object({ kind: z.literal("thread"), thread: threadSummarySchema }),
]);

export const replyResultSchema = z.object({ message: chatMessageSchema, thread: threadSummarySchema });
export const readResultSchema = z.object({ lastRead: z.string().nullable(), unread: z.number() });

export const chatListItemSchema = z.object({
  ticketId: z.string(),
  ticketKey: z.string(),
  title: z.string(),
  projectId: z.string(),
  /** `null` quando a pessoa é responsável pelo ticket mas ainda não abriu o chat. */
  chatId: z.string().nullable(),
  assignedToMe: z.boolean(),
  /** A última mensagem do chat; sem chat, quando a pessoa passou a ser responsável. */
  lastActivityAt: z.string(),
  unread: z.number(),
});
export const chatListSchema = z.object({ items: z.array(chatListItemSchema) });

export type SendMessageBody = z.output<typeof sendMessageBodySchema>;
export type PageQuery = z.output<typeof pageQuerySchema>;
export type ChatMessage = z.output<typeof chatMessageSchema>;
export type ThreadSummary = z.output<typeof threadSummarySchema>;
export type ChatView = z.output<typeof chatViewSchema>;
export type ThreadView = z.output<typeof threadViewSchema>;
export type SendResult = z.output<typeof sendResultSchema>;
export type ChatList = z.output<typeof chatListSchema>;
export { CHAT_MAX_MENTIONS };
