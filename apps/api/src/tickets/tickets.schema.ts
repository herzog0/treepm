import { z } from "zod";
import { idSchema } from "../common/schemas.js";

export const MAX_IMPORT_ITEMS = 500;
export const MAX_IMPORT_DEPTH = 20;

export const ticketStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
export const ticketTitleSchema = z.string().trim().min(1).max(200);
export const ticketDescriptionSchema = z.string().max(20_000);
const titleSchema = ticketTitleSchema;
const descriptionSchema = ticketDescriptionSchema;

export const createTicketSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.optional(),
    parentId: idSchema.nullable().optional(),
    status: ticketStatusSchema.optional(),
    assigneeIds: z.array(idSchema).max(100).optional(),
  })
  .strict();

export const updateTicketSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    status: ticketStatusSchema,
    parentId: idSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");

export type ImportItem = {
  title: string;
  description?: string | undefined;
  status?: z.output<typeof ticketStatusSchema> | undefined;
  children?: ImportItem[] | undefined;
};

/** A profundidade máxima é estrutural: o nível 20 não aceita `children`, o que evita recursão sem limite. */
function itemSchema(depthLeft: number): z.ZodType<ImportItem> {
  const base = {
    title: titleSchema,
    description: descriptionSchema.optional(),
    status: ticketStatusSchema.optional(),
  };
  if (depthLeft <= 1) return z.object(base).strict();
  return z
    .object({ ...base, children: z.array(z.lazy(() => itemSchema(depthLeft - 1))).optional() })
    .strict();
}

function countItems(items: readonly ImportItem[]): number {
  let total = 0;
  const stack = [...items];
  for (let item = stack.pop(); item; item = stack.pop()) {
    total += 1;
    if (item.children) stack.push(...item.children);
  }
  return total;
}

export const importTicketsSchema = z
  .object({
    parentId: idSchema.nullable().optional(),
    items: z.array(itemSchema(MAX_IMPORT_DEPTH)).min(1),
  })
  .strict()
  .refine((value) => countItems(value.items) <= MAX_IMPORT_ITEMS, "Máximo de 500 itens.");

const progressSchema = z.object({ done: z.number(), total: z.number(), excluded: z.number() });

export const ticketSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  key: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  descriptionExcerpt: z.string(),
  status: ticketStatusSchema,
  progress: progressSchema.nullable(),
  assigneeIds: z.array(z.string()),
});

export const ticketDetailSchema = ticketSummarySchema.extend({
  description: z.string(),
  createdByPersonId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TicketSummary = z.output<typeof ticketSummarySchema>;
export type TicketDetail = z.output<typeof ticketDetailSchema>;
