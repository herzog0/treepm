import { z } from "zod";
import { ticketStatusSchema } from "../tickets/tickets.schema.js";

/**
 * Saídas da camada de consulta do projeto (ADR 0037). Nenhum esquema tem responsável, autor, nome, e-mail ou data:
 * a camada não devolve dado de pessoa, e `strictObject` faz um campo a mais falhar em vez de passar.
 */

export const querySummarySchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  number: z.number().int(),
  title: z.string(),
  descriptionExcerpt: z.string(),
  status: ticketStatusSchema,
  parentId: z.string().nullable(),
});
export type QueryTicketSummary = z.infer<typeof querySummarySchema>;

export const queryProgressSchema = z.strictObject({ done: z.number().int(), total: z.number().int(), excluded: z.number().int() });

/** Lista com teto: `truncated` diz que havia mais do que coube. */
export const queryListSchema = z.strictObject({ tickets: z.array(querySummarySchema), truncated: z.boolean() });
export type QueryTicketList = z.infer<typeof queryListSchema>;

const directionsSchema = z.strictObject({ outgoing: queryListSchema, incoming: queryListSchema });

export const queryTicketSchema = querySummarySchema.extend({
  description: z.string(),
  /** O pai direto, igual ao último item de `path`; `null` no topo. */
  parent: querySummarySchema.nullable(),
  /** Do topo até o pai, sem o próprio ticket. Vazio no topo. */
  path: z.array(querySummarySchema),
  children: queryListSchema,
  relations: z.strictObject({
    /** `outgoing`: este ticket menciona; `incoming`: é mencionado por. */
    mentions: directionsSchema,
    /** `outgoing`: este ticket depende de; `incoming`: dependem deste. */
    dependsOn: directionsSchema,
  }),
});
export type QueryTicket = z.infer<typeof queryTicketSchema>;

export const queryTicketPageSchema = queryListSchema.extend({
  /** Número do último ticket da página, para pedir a seguinte (`after`); `null` quando não há mais. */
  after: z.number().int().nullable(),
});
export type QueryTicketPage = z.infer<typeof queryTicketPageSchema>;

export const queryOverviewSchema = z.strictObject({
  projectKey: z.string(),
  total: z.number().int(),
  byStatus: z.strictObject({
    todo: z.number().int(),
    in_progress: z.number().int(),
    in_review: z.number().int(),
    done: z.number().int(),
    cancelled: z.number().int(),
  }),
  top: z.strictObject({
    tickets: z.array(querySummarySchema.extend({ progress: queryProgressSchema.nullable() })),
    truncated: z.boolean(),
  }),
});
export type QueryOverview = z.infer<typeof queryOverviewSchema>;
