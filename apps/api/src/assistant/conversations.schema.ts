import { z } from "zod";
import { idSchema } from "../common/schemas.js";
import { ticketDetailSchema } from "../tickets/tickets.schema.js";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import { MAX_DRAFT_CHILDREN } from "./ports.js";

export const MAX_PERSON_MESSAGE = 4000;

/**
 * A mensagem da pessoa e, opcionalmente, o agrupador do lugar da procura (ADR 0033): vale só para aquele turno e não é
 * guardado na conversa. `null` ou ausente: a raiz do projeto.
 */
export const conversationMessageBodySchema = z
  .object({ message: z.string().trim().min(1).max(MAX_PERSON_MESSAGE), scopeId: idSchema.nullable().optional() })
  .strict();

/** Um filho do rascunho (ADR 0044): título e descrição, e nada mais — só um nível. */
export const draftChildSchema = z.object({ title: ticketTitleSchema, description: ticketDescriptionSchema.default("") }).strict();

/**
 * O rascunho editado à mão. Título e descrição do pai sempre vêm; `children` é a lista inteira de filhos, na ordem
 * (tirar e reordenar é mandar a lista nova): ausente mantém os filhos como estão, `[]` tira todos.
 */
export const draftBodySchema = z
  .object({
    title: ticketTitleSchema,
    description: ticketDescriptionSchema.default(""),
    children: z.array(draftChildSchema).max(MAX_DRAFT_CHILDREN).optional(),
    /** Registrar o rascunho como ideia ao criar (ADR 0044, adendo): ausente mantém a opção como está. */
    idea: z.boolean().optional(),
  })
  .strict();

/** O agrupador novo a criar em `parentId`, com os tickets soltos que vão para ele (ADR 0031). */
export const newGroupSchema = z
  .object({
    title: ticketTitleSchema,
    description: ticketDescriptionSchema.default(""),
    ticketIds: z
      .array(idSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "Ticket repetido."),
  })
  .strict();

/**
 * O pai escolhido (ou `null`: ticket de raiz). Título e descrição do ticket vêm sempre do rascunho da conversa.
 * Com `group`, o ticket nasce dentro de um agrupador novo criado em `parentId`.
 */
export const createTicketBodySchema = z.object({ parentId: idSchema.nullable(), group: newGroupSchema.optional() }).strict();

/** Corpo opcional da procura: o agrupador de escopo (ou `null`: o projeto inteiro). */
export const placementBodySchema = z.object({ scopeId: idSchema.nullable().optional() }).strict();

const draftSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    /** Os filhos do rascunho, na ordem; vazio quando o rascunho é um ticket só. */
    children: z.array(z.object({ title: z.string(), description: z.string() })),
    /** O rascunho será registrado como ideia ao criar (ADR 0044, adendo). */
    idea: z.boolean(),
  })
  .nullable();
const statusSchema = z.enum(["open", "ticket_created", "discarded"]);

export const conversationSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: statusSchema,
  draft: draftSchema,
  ready: z.boolean(),
  createdTicketId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(
    z.object({
      id: z.string(),
      author: z.enum(["person", "assistant"]),
      body: z.string(),
      model: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

export type ConversationSummary = z.output<typeof conversationSummarySchema>;
export type ConversationDetail = z.output<typeof conversationDetailSchema>;

const targetSchema = z.object({
  parentId: z.string().nullable(),
  path: z.array(z.object({ id: z.string(), title: z.string() })),
});

export const placementOutcomeSchema = z.object({
  destination: targetSchema,
  alternatives: z.array(targetSchema).max(2),
  discarded: z.array(z.object({ level: z.number(), parentId: z.string().nullable(), ticketId: z.string(), title: z.string() })),
  uncertain: z.boolean(),
  stoppedEarly: z
    .object({ reason: z.enum(["candidates_too_large", "max_levels"]), level: z.number(), parentId: z.string().nullable() })
    .nullable(),
  /** `null` sem escopo. A probabilidade da conferência não sai daqui. */
  scope: z.object({ id: z.string(), title: z.string(), outOfScope: z.boolean() }).nullable(),
  /** Agrupador novo que a IA propõe no destino (ADR 0031), ou `null`. As probabilidades que o motivaram não saem daqui. */
  groupProposal: z
    .object({
      title: z.string(),
      description: z.string(),
      tickets: z.array(z.object({ id: z.string(), number: z.number(), title: z.string() })).min(1),
    })
    .nullable(),
  /** `null` quando há proposta ou quando ninguém passou do limiar; senão, por que a proposta não houve. */
  groupProposalSkipped: z
    .enum(["not_settled", "no_loose_tickets", "too_large", "same_as_destination", "invalid_name", "unavailable"])
    .nullable(),
});

/** O que será gravado, como a pessoa o vê antes de confirmar (ADR 0044). `description` já traz a citação do pedido. */
export const previewSchema = z.object({
  title: z.string(),
  description: z.string(),
  /** Só a citação (linha fixa e mensagens da pessoa), a parte do começo de `description`; vazia se não houver mensagens. */
  quote: z.string(),
  children: z.array(z.object({ title: z.string(), description: z.string() })),
  /** O que será criado é uma ideia (a opção do rascunho; o lugar escolhido pode torná-la parte de outra ideia). */
  idea: z.boolean(),
  /** Chaves de ticket da parte escrita pela IA que não existem no projeto: a criação seria recusada. */
  unknownKeys: z.array(z.string()),
  /** `description` passa do máximo: a criação seria recusada. */
  descriptionTooLong: z.boolean(),
});

/** `children` são os filhos criados junto com `ticket` (o pai), na ordem do rascunho; vazio para um ticket só. */
export const createdTicketSchema = z.object({
  conversation: conversationDetailSchema,
  ticket: ticketDetailSchema,
  children: z.array(ticketDetailSchema),
});
