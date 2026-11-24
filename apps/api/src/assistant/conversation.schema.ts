import { CHAT_BODY_MAX, CHAT_MAX_MENTIONS, hasForbiddenChatChars } from "@treepm/domain";
import { z } from "zod";
import { idSchema } from "../common/schemas.js";

/** Tamanho de uma mensagem (ADR 0049): 1 a 4.000 caracteres, depois de aparada. */
export const chatBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_BODY_MAX)
  .refine((body) => !hasForbiddenChatChars(body), "caractere inválido");

/** Cursor opaco (ver `chat-cursor.ts`); quem o confere é o serviço (`400 invalid_cursor`). */
const cursorSchema = z.string().min(1).max(64);

/**
 * Mandar uma mensagem (ADR 0055). Sem `mentions`: mensagem normal (na conversa principal o assistente responde; na thread é só entre
 * pessoas). Com `mentions` (ids de pessoas, escolhidos na tela): a mensagem abre uma thread dentro desta conversa. O texto fica como a
 * pessoa o escreveu; quem é marcado é só o que está em `mentions`, nunca lido do texto. A lista pode vir maior que o limite (a API a
 * recusa com erro claro, não com 400 genérico). `ticketId` só vale ao abrir thread numa conversa que não trata de ticket (o chat
 * geral): o ticket de que a thread trata. `topic: true` (ADR 0056): o texto livre vira uma thread de assunto com o assistente, só da pessoa,
 * dentro da conversa principal dela; não combina com `mentions`, `ticketId` nem com uma thread como destino (422).
 */
export const sendMessageBodySchema = z
  .object({ body: chatBodySchema, mentions: z.array(idSchema).max(200).optional(), ticketId: idSchema.optional(), topic: z.boolean().optional() })
  .strict();

/** Incluir pessoas numa thread (só quem a abriu). */
export const addParticipantsBodySchema = z.object({ personIds: z.array(idSchema).min(1).max(200) }).strict();

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

/** Uma mensagem como a pessoa a lê. Nenhum id de conversa sai aqui: a mensagem de abertura de uma thread, lida na thread, não diz onde mora. */
const messageBase = z.object({
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
});

/** Para que a thread existe (ADR 0056): entre pessoas, assunto com o assistente (só de quem a abriu) ou conversa de novo ticket. */
export const purposeSchema = z.enum(["people", "topic", "creation"]);

/** O cartão de uma thread, para quem participa dela. */
export const threadCardSchema = z.object({
  /** O id da conversa da thread. */
  id: z.string(),
  /** A mensagem que a abriu (a primeira da thread). */
  opening: messageBase,
  /** Quem participa (as pessoas, sem o assistente). */
  participants: z.array(personRefSchema),
  participantCount: z.number(),
  replyCount: z.number(),
  lastActivityAt: z.string(),
  /** Mensagens de outras pessoas, nesta thread (a de abertura inclusive), depois do ponto de leitura de quem pede. */
  unread: z.number(),
  startedByMe: z.boolean(),
  purpose: purposeSchema,
  /** O título curto da thread de assunto; `null` até o assistente dar um (a tela usa o começo da abertura). */
  title: z.string().nullable(),
});

export const chatMessageSchema = messageBase.extend({
  /** A thread que esta mensagem abriu, quando a pessoa participa dela (com a invariante, todas as que abriram, para quem lê a conversa). */
  thread: threadCardSchema.nullable(),
});

/** O ticket de que uma conversa trata, com o que a barra precisa para a cor: situação e bloqueio. */
export const conversationTicketSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  projectId: z.string(),
  /** Projeto arquivado: lê-se, não se escreve. */
  archived: z.boolean(),
  status: z.string(),
  /** Depende de algum ticket ainda aberto. */
  blocked: z.boolean(),
});

const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextBefore: z.string().nullable() });

/** Um elo da trilha: só as conversas acima que a PESSOA lê, do ponto em que ela entra até a de cima. Nunca revela nada além disso. */
export const trailItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["ticket", "general", "thread"]),
  /** A primeira mensagem da thread, resumida; `null` nas principais. */
  label: z.string().nullable(),
  /** O título, nas threads de assunto. */
  title: z.string().nullable(),
});

export const conversationInfoSchema = z.object({
  id: z.string(),
  kind: z.enum(["ticket", "general", "thread"]),
  /** Só nas threads; `null` nas principais. */
  purpose: purposeSchema.nullable(),
  title: z.string().nullable(),
  /** Foi a pessoa quem abriu. */
  ownedByMe: z.boolean(),
  participants: z.array(personRefSchema),
  /** Só quem abriu a thread inclui pessoas nela. */
  canAddParticipants: z.boolean(),
  /** Marcar alguém aqui abre uma thread: falso no último nível. */
  canOpenThread: z.boolean(),
  /** A mensagem de abertura (primeira da thread); `null` nas principais. */
  openingMessageId: z.string().nullable(),
  /** A mensagem de abertura, para a thread poder ser mostrada sem ler a conversa de cima; `null` nas principais. */
  opening: messageBase.nullable(),
  /** Mensagens da própria conversa (a de abertura da thread não conta). */
  replyCount: z.number(),
  lastActivityAt: z.string(),
  trail: z.array(trailItemSchema),
});

export const conversationViewSchema = z.object({
  /** `null` na leitura do ticket enquanto a pessoa não tem conversa principal nele (só threads em que entrou, ou nenhuma). */
  conversation: conversationInfoSchema.nullable(),
  ticket: conversationTicketSchema.nullable(),
  assignedToMe: z.boolean(),
  /** Cursor do ponto de leitura; `null` = nada lido ainda. */
  lastRead: z.string().nullable(),
  unread: z.number(),
  messages: pageOf(chatMessageSchema),
  /** As threads de que a pessoa participa e que ficam logo abaixo desta conversa (na leitura do ticket, também as que a pessoa entrou sem ver a de cima). */
  threads: z.array(threadCardSchema),
});

export const sendResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant"), message: chatMessageSchema, reply: chatMessageSchema }),
  z.object({ kind: z.literal("message"), message: chatMessageSchema }),
  z.object({ kind: z.literal("thread"), message: chatMessageSchema, thread: threadCardSchema }),
  /** O texto livre virou thread de assunto: a abertura (na conversa de cima), a thread e a resposta do assistente, dentro dela. */
  z.object({ kind: z.literal("topic"), message: chatMessageSchema, thread: threadCardSchema, reply: chatMessageSchema }),
]);

export const readResultSchema = z.object({ lastRead: z.string().nullable(), unread: z.number() });
export const participantsResultSchema = z.object({ participants: z.array(personRefSchema) });
export const openedSchema = z.object({ id: z.string() });

export interface ConversationNodeShape {
  /** `null`: o ticket (ou o chat geral) aparece na barra, mas a pessoa ainda não tem conversa nele. */
  id: string | null;
  kind: "ticket" | "general" | "thread";
  ticket: z.output<typeof conversationTicketSchema> | null;
  ownedByMe: boolean;
  /** A pessoa é responsável pelo ticket. */
  assignedToMe: boolean;
  /** Até cinco, para os avatares. */
  participants: z.output<typeof personRefSchema>[];
  participantCount: number;
  lastActivityAt: string | null;
  unread: number;
  /** O fim da última mensagem que a pessoa pode ler nesta conversa. */
  preview: string | null;
  /** Só nos nós de thread: o começo da mensagem que a abriu, o mesmo texto de `trail[].label`; `null` nos demais. */
  label: string | null;
  /** Só nas threads (ADR 0056); `null` nas principais. */
  purpose: z.output<typeof purposeSchema> | null;
  /** O título da thread de assunto; `null` nas demais e até o assistente dar um. */
  title: string | null;
  children: ConversationNodeShape[];
}
export const conversationNodeSchema: z.ZodType<ConversationNodeShape> = z.lazy(() =>
  z.object({
    id: z.string().nullable(),
    kind: z.enum(["ticket", "general", "thread"]),
    ticket: conversationTicketSchema.nullable(),
    ownedByMe: z.boolean(),
    assignedToMe: z.boolean(),
    participants: z.array(personRefSchema),
    participantCount: z.number(),
    lastActivityAt: z.string().nullable(),
    unread: z.number(),
    preview: z.string().nullable(),
    label: z.string().nullable(),
    purpose: purposeSchema.nullable(),
    title: z.string().nullable(),
    children: z.array(conversationNodeSchema),
  }),
);
export const conversationTreeSchema = z.object({ items: z.array(conversationNodeSchema) });

export type SendMessageBody = z.output<typeof sendMessageBodySchema>;
export type PageQuery = z.output<typeof pageQuerySchema>;
export type ChatMessage = z.output<typeof chatMessageSchema>;
export type ThreadCard = z.output<typeof threadCardSchema>;
export type ConversationView = z.output<typeof conversationViewSchema>;
export type ConversationTree = z.output<typeof conversationTreeSchema>;
export { CHAT_MAX_MENTIONS };
