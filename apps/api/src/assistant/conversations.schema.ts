import { z } from "zod";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";

export const MAX_PERSON_MESSAGE = 4000;

export const conversationMessageBodySchema = z
  .object({ message: z.string().trim().min(1).max(MAX_PERSON_MESSAGE) })
  .strict();

export const draftBodySchema = z
  .object({ title: ticketTitleSchema, description: ticketDescriptionSchema.default("") })
  .strict();

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
