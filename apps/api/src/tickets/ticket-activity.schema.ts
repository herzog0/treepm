import { z } from "zod";
import { contributionStatusSchema, ticketStatusSchema } from "./tickets.schema.js";

export const ACTIVITY_DEFAULT_LIMIT = 30;
export const ACTIVITY_MAX_LIMIT = 100;

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
  before: z.string().min(1).max(500).optional(),
});

const personSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });
/** Ticket citado numa entrada: dados de hoje quando existe; `id` e `title` nulos quando não existe mais. */
const ticketRefSchema = z.object({ id: z.string().nullable(), key: z.string().nullable(), title: z.string().nullable() });

/** Área de uma entrada de contribuição: o nome de hoje; o guardado no evento de remoção quando a área não existe mais; `null` sem nenhum dos dois. */
const areaRefSchema = z.object({ id: z.string(), name: z.string() }).nullable();

const base = { id: z.string(), occurredAt: z.string(), actor: personSchema.nullable() };

/**
 * Entradas da atividade do ticket. Os dados do tipo ficam no mesmo nível de `id`, `occurredAt` e `actor`.
 * Um tipo novo entra como mais um membro da união. `comment` (ADR 0040, fatia 2): `id` é o do comentário, `occurredAt`
 * a criação e `actor` o autor; `body` é nulo quando removido; `canEdit` e `canRemove` valem para quem está lendo.
 */
export const activityEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("created") }),
  z.object({ ...base, type: z.literal("title_changed"), from: z.string(), to: z.string() }),
  z.object({ ...base, type: z.literal("description_changed") }),
  z.object({
    ...base,
    type: z.literal("status_changed"),
    from: ticketStatusSchema,
    to: ticketStatusSchema,
    automatic: z.boolean(),
    causedBy: ticketRefSchema.nullable(),
  }),
  z.object({ ...base, type: z.literal("parent_changed"), from: ticketRefSchema.nullable(), to: ticketRefSchema.nullable() }),
  z.object({ ...base, type: z.literal("assignee_added"), person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("assignee_removed"), person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("dependency_added"), ticket: ticketRefSchema }),
  z.object({ ...base, type: z.literal("dependency_removed"), ticket: ticketRefSchema }),
  z.object({ ...base, type: z.literal("summary_updated"), source: z.enum(["person", "assistant"]) }),
  z.object({ ...base, type: z.literal("contribution_added"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_removed"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_text_changed"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_status_changed"), area: areaRefSchema, from: contributionStatusSchema, to: contributionStatusSchema }),
  z.object({ ...base, type: z.literal("contribution_person_added"), area: areaRefSchema, person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("contribution_person_removed"), area: areaRefSchema, person: personSchema.nullable() }),
  z.object({
    ...base,
    type: z.literal("comment"),
    body: z.string().nullable(),
    editedAt: z.string().nullable(),
    removed: z.boolean(),
    canEdit: z.boolean(),
    canRemove: z.boolean(),
  }),
]);

export const activityPageSchema = z.object({ entries: z.array(activityEntrySchema), before: z.string().nullable(), canComment: z.boolean() });

export type ActivityEntry = z.output<typeof activityEntrySchema>;
export type ActivityPage = z.output<typeof activityPageSchema>;
export type ActivityQuery = z.output<typeof activityQuerySchema>;
export type CommentEntry = Extract<ActivityEntry, { type: "comment" }>;
