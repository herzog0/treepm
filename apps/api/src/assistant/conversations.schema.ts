import { z } from "zod";
import { idSchema } from "../common/schemas.js";
import { ticketDetailSchema } from "../tickets/tickets.schema.js";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";

export const MAX_PERSON_MESSAGE = 4000;

export const conversationMessageBodySchema = z
  .object({ message: z.string().trim().min(1).max(MAX_PERSON_MESSAGE) })
  .strict();

export const draftBodySchema = z
  .object({ title: ticketTitleSchema, description: ticketDescriptionSchema.default("") })
  .strict();

/** O pai escolhido (ou `null`: ticket de raiz). Título e descrição vêm sempre do rascunho da conversa. */
export const createTicketBodySchema = z.object({ parentId: idSchema.nullable() }).strict();

/** Corpo opcional da procura: o agrupador de escopo (ou `null`: o projeto inteiro). */
export const placementBodySchema = z.object({ scopeId: idSchema.nullable().optional() }).strict();

const draftSchema = z.object({ title: z.string(), description: z.string() }).nullable();
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
});

export const createdTicketSchema = z.object({ conversation: conversationDetailSchema, ticket: ticketDetailSchema });
