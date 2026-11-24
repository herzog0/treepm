import { z } from "zod";

/**
 * O contrato das conversas em níveis (ADR 0055): espelha `apps/api/src/assistant/conversation.schema.ts` campo a campo. A posição de uma
 * mensagem é o `cursor` opaco (só se compara por igualdade). Nenhum campo daqui diz o que há acima da conversa que a pessoa lê.
 */
export const chatPersonSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });

const messageBase = z.object({
  id: z.string(),
  cursor: z.string(),
  unread: z.boolean(),
  authorKind: z.enum(["person", "assistant"]),
  author: chatPersonSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  model: z.string().nullable(),
});

/** Para que a thread existe (ADR 0056): entre pessoas, assunto com o assistente (só de quem a abriu) ou conversa de novo ticket. */
export const purposeSchema = z.enum(["people", "topic", "creation"]);

export const threadCardSchema = z.object({
  id: z.string(),
  opening: messageBase,
  participants: z.array(chatPersonSchema),
  participantCount: z.number(),
  replyCount: z.number(),
  lastActivityAt: z.string(),
  unread: z.number(),
  startedByMe: z.boolean(),
  purpose: purposeSchema.nullish().transform((value) => value ?? "people"),
  /** O título curto da thread de assunto; `null` até o assistente dar um (a tela usa o começo da abertura). Ausente vale nulo. */
  title: z.string().nullish().transform((value) => value ?? null),
});

export const chatMessageSchema = messageBase.extend({ thread: threadCardSchema.nullable() });

export const conversationTicketSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  projectId: z.string(),
  archived: z.boolean(),
  status: z.string(),
  blocked: z.boolean(),
});

export const conversationKind = z.enum(["ticket", "general", "thread"]);

export const trailItemSchema = z.object({ id: z.string(), kind: conversationKind, label: z.string().nullable(), title: z.string().nullish().transform((value) => value ?? null) });

export const conversationInfoSchema = z.object({
  id: z.string(),
  kind: conversationKind,
  /** Só nas threads; `null` nas principais. */
  purpose: purposeSchema.nullish().transform((value) => value ?? null),
  title: z.string().nullish().transform((value) => value ?? null),
  ownedByMe: z.boolean(),
  participants: z.array(chatPersonSchema),
  canAddParticipants: z.boolean(),
  canOpenThread: z.boolean(),
  openingMessageId: z.string().nullable(),
  opening: messageBase.nullable(),
  replyCount: z.number(),
  lastActivityAt: z.string(),
  trail: z.array(trailItemSchema),
});

const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextBefore: z.string().nullable() });

export const conversationViewSchema = z.object({
  /** `null` na leitura do ticket enquanto a pessoa não tem conversa principal nele. */
  conversation: conversationInfoSchema.nullable(),
  ticket: conversationTicketSchema.nullable(),
  assignedToMe: z.boolean(),
  lastRead: z.string().nullable(),
  unread: z.number(),
  messages: pageOf(chatMessageSchema),
  threads: z.array(threadCardSchema),
});

export const sendResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant"), message: chatMessageSchema, reply: chatMessageSchema }),
  z.object({ kind: z.literal("message"), message: chatMessageSchema }),
  z.object({ kind: z.literal("thread"), message: chatMessageSchema, thread: threadCardSchema }),
  /** `topic: true`: a mensagem de abertura (na conversa de cima), a thread de assunto que nasceu e a resposta do assistente (dentro dela). */
  z.object({ kind: z.literal("topic"), message: chatMessageSchema, thread: threadCardSchema, reply: chatMessageSchema }),
]);

export const readResultSchema = z.object({ lastRead: z.string().nullable(), unread: z.number() });
export const participantsResultSchema = z.object({ participants: z.array(chatPersonSchema) });
export const openedSchema = z.object({ id: z.string() });

export interface ConversationNode {
  /** `null`: o ticket (ou o chat geral) aparece na barra, mas a pessoa ainda não tem conversa nele. */
  id: string | null;
  kind: z.output<typeof conversationKind>;
  ticket: z.output<typeof conversationTicketSchema> | null;
  ownedByMe: boolean;
  assignedToMe: boolean;
  participants: z.output<typeof chatPersonSchema>[];
  participantCount: number;
  lastActivityAt: string | null;
  unread: number;
  preview: string | null;
  /** Só nas threads: o começo da mensagem que a abriu; `null` nos outros nós. O servidor antigo não manda. */
  label?: string | null | undefined;
  /** Só nas threads: para que ela existe; `null` nos outros nós. */
  purpose: z.output<typeof purposeSchema> | null;
  /** O título curto da thread de assunto; `null` até o assistente dar um. */
  title: string | null;
  children: ConversationNode[];
}
const conversationNodeSchema: z.ZodType<ConversationNode> = z.lazy(() =>
  z.object({
    id: z.string().nullable(),
    kind: conversationKind,
    ticket: conversationTicketSchema.nullable(),
    ownedByMe: z.boolean(),
    assignedToMe: z.boolean(),
    participants: z.array(chatPersonSchema),
    participantCount: z.number(),
    lastActivityAt: z.string().nullable(),
    unread: z.number(),
    preview: z.string().nullable(),
    label: z.string().nullish(),
    purpose: purposeSchema.nullish().transform((value) => value ?? null),
    title: z.string().nullish().transform((value) => value ?? null),
    children: z.array(conversationNodeSchema),
  }),
);
export const conversationTreeSchema = z.object({ items: z.array(conversationNodeSchema) });

export type ChatPerson = z.output<typeof chatPersonSchema>;
export type ChatMessage = z.output<typeof chatMessageSchema>;
export type ThreadCard = z.output<typeof threadCardSchema>;
export type ConversationTicket = z.output<typeof conversationTicketSchema>;
export type ConversationInfo = z.output<typeof conversationInfoSchema>;
export type ConversationView = z.output<typeof conversationViewSchema>;
export type ConversationTree = z.output<typeof conversationTreeSchema>;
export type TrailItem = z.output<typeof trailItemSchema>;
export type SendResult = z.output<typeof sendResultSchema>;
export type ChatRead = z.output<typeof readResultSchema>;
export interface ChatWriteBody {
  body: string;
  /** Ids das pessoas escolhidas no seletor; a API nunca procura pessoa dentro do texto. */
  mentions?: string[];
  /** Só ao abrir thread numa conversa sem ticket (o chat geral): o ticket de que a thread trata. */
  ticketId?: string;
  /** O texto livre vira uma thread de assunto com o assistente, só da pessoa (só numa conversa principal, sem `mentions` nem `ticketId`). */
  topic?: boolean;
}
export type ConversationPurpose = z.output<typeof purposeSchema>;
