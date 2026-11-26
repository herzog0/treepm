import { z } from "zod";
import { contributionStatusSchema, ideaStageSchema, ticketStatusSchema } from "./tickets.schema.js";

export const ACTIVITY_DEFAULT_LIMIT = 30;
export const ACTIVITY_MAX_LIMIT = 100;

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
  before: z.string().min(1).max(500).optional(),
  /** Só os comentários desta contribuição (ADR 0041), sem as mudanças. */
  contribution: z.uuid().optional(),
});

const personSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });
/** Ticket citado numa entrada: dados de hoje quando existe; `id` e `title` nulos quando não existe mais. */
const ticketRefSchema = z.object({ id: z.string().nullable(), key: z.string().nullable(), title: z.string().nullable() });

/** Etiqueta numa entrada `labels_changed`: id e nome da época. */
const labelItemSchema = z.object({ id: z.string(), name: z.string() });

/** Área de uma entrada de contribuição: o nome de hoje; o guardado no evento de remoção quando a área não existe mais; `null` sem nenhum dos dois. */
const areaRefSchema = z.object({ id: z.string(), name: z.string() }).nullable();

/**
 * Área de um comentário (ADR 0041): `id` é o da contribuição e `name` o nome da área hoje; `id` nulo quando a contribuição
 * foi removida e o nome ficou guardado no comentário. `null` no comentário do ticket.
 */
const commentAreaSchema = z.object({ id: z.string().nullable(), name: z.string() }).nullable();

/** `via: "mcp"` quando a entrada veio de uma chamada MCP (ADR 0043); ausente quando foi feita à mão. */
const viaSchema = z.literal("mcp").optional();
/** `automatic: true` quando a mudança veio de um processo (reabertura de pai, reimportação do Linear), não de uma pessoa; ausente quando foi feita à mão. */
const automaticSchema = z.boolean().optional();
const base = { id: z.string(), occurredAt: z.string(), actor: personSchema.nullable(), via: viaSchema, automatic: automaticSchema };

/** Autor do Linear que não é pessoa do TreePM (ADR 0061, fatia 4): o nome lá; `null` = apagado ou desconhecido. */
const externalActorSchema = z.object({ name: z.string().nullable() });
/** A coluna do Linear (nome e tipo), não a situação do TreePM. `type` nulo: tipo fora dos seis que o Linear documenta. */
const linearStatusSideSchema = z.object({ name: z.string(), type: z.string().nullable() });
/** Um lado do responsável: pessoa do TreePM (`null` = não existe mais) ou só o nome no Linear (`null` = desconhecido). */
const linearAssigneeSideSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), person: personSchema.nullable() }),
  z.object({ kind: z.literal("linear"), name: z.string().nullable() }),
]);
/** Uma mudança de uma entrada do histórico do Linear. Pai e projeto: `id` e `key` nulos = fora daqui ou desconhecido ("mudou de pai"). */
export const linearChangeSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("status"), from: linearStatusSideSchema.nullable(), to: linearStatusSideSchema.nullable() }),
  z.object({ field: z.literal("assignee"), from: linearAssigneeSideSchema.nullable(), to: linearAssigneeSideSchema.nullable() }),
  z.object({ field: z.literal("priority"), from: z.number().int(), to: z.number().int() }),
  z.object({ field: z.literal("title"), from: z.string(), to: z.string() }),
  z.object({ field: z.literal("parent"), from: ticketRefSchema.nullable(), to: ticketRefSchema.nullable() }),
  z.object({ field: z.literal("project"), from: ticketRefSchema.nullable(), to: ticketRefSchema.nullable() }),
  z.object({ field: z.literal("description") }),
]);

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
  z.object({ ...base, type: z.literal("priority_changed"), from: z.number().int(), to: z.number().int() }),
  /** Prazo (ADR 0064): `from` nulo = definiu; `to` nulo = tirou; os dois = mudou. Datas `AAAA-MM-DD`. */
  z.object({ ...base, type: z.literal("due_date_changed"), from: z.string().nullable(), to: z.string().nullable() }),
  z.object({ ...base, type: z.literal("parent_changed"), from: ticketRefSchema.nullable(), to: ticketRefSchema.nullable() }),
  z.object({ ...base, type: z.literal("assignee_added"), person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("assignee_removed"), person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("dependency_added"), ticket: ticketRefSchema }),
  z.object({ ...base, type: z.literal("dependency_removed"), ticket: ticketRefSchema }),
  /** "Relacionado a" tirado (ADR 0061, fatia 3): o outro ticket. */
  z.object({ ...base, type: z.literal("related_removed"), ticket: ticketRefSchema }),
  /**
   * Etiquetas postas e tiradas num pedido (ADR 0065): UMA entrada com as duas listas, com o nome DA ÉPOCA (guardado no evento; a etiqueta
   * renomeada ou apagada depois não muda a entrada). `automatic` quando veio da sincronização com o Linear.
   */
  z.object({ ...base, type: z.literal("labels_changed"), added: z.array(labelItemSchema), removed: z.array(labelItemSchema) }),
  z.object({ ...base, type: z.literal("summary_updated"), source: z.enum(["person", "assistant"]) }),
  z.object({ ...base, type: z.literal("contribution_added"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_removed"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_text_changed"), area: areaRefSchema }),
  z.object({ ...base, type: z.literal("contribution_status_changed"), area: areaRefSchema, from: contributionStatusSchema, to: contributionStatusSchema }),
  z.object({ ...base, type: z.literal("contribution_person_added"), area: areaRefSchema, person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("contribution_person_removed"), area: areaRefSchema, person: personSchema.nullable() }),
  z.object({ ...base, type: z.literal("agent_work_started"), until: z.string() }),
  z.object({ ...base, type: z.literal("agent_work_ended"), reason: z.enum(["agent", "person", "finished", "idea", "archived"]) }),
  z.object({ ...base, type: z.literal("idea_registered") }),
  z.object({ ...base, type: z.literal("idea_stage_changed"), from: ideaStageSchema, to: ideaStageSchema }),
  z.object({ ...base, type: z.literal("idea_accepted") }),
  z.object({ ...base, type: z.literal("idea_discarded") }),
  z.object({ ...base, type: z.literal("idea_reopened") }),
  /** Comentários trazidos do Linear numa rodada (ADR 0061, fatia 2): um por ticket e rodada, automático, só a contagem. */
  z.object({ ...base, type: z.literal("comments_imported"), count: z.number().int().min(1) }),
  /** Relações trazidas do Linear numa rodada (ADR 0061, fatia 3): um por ticket e rodada, automático, só a contagem. */
  z.object({ ...base, type: z.literal("relations_imported"), count: z.number().int().min(1) }),
  /** Registros do histórico trazidos do Linear numa rodada (ADR 0061, fatia 4): um por ticket e rodada, automático, só a contagem. */
  z.object({ ...base, type: z.literal("history_imported"), count: z.number().int().min(1) }),
  /**
   * Uma entrada do histórico da issue no Linear (ADR 0061, fatia 4), na data original. `actor` é a pessoa do TreePM casada; quando nulo,
   * `externalActor` traz o nome no Linear (robô: o nome do robô; `null` = apagado ou desconhecido).
   */
  z.object({ ...base, type: z.literal("linear_history"), externalActor: externalActorSchema.optional(), changes: z.array(linearChangeSchema) }),
  /** A criação da issue no Linear, sintetizada na leitura a partir da origem (data e criador lá); sem linha no banco. */
  z.object({ ...base, type: z.literal("linear_created"), externalActor: externalActorSchema.optional() }),
  z.object({
    ...base,
    type: z.literal("comment"),
    /** `linear`: trazido do Linear (ADR 0061); `mcp` como nas demais entradas. */
    via: z.enum(["mcp", "linear"]).optional(),
    /** Autor do Linear que não é pessoa do TreePM: o nome de lá (`null` = autor apagado no Linear); `actor` é nulo. */
    externalAuthor: z.object({ name: z.string().nullable() }).optional(),
    body: z.string().nullable(),
    area: commentAreaSchema,
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
export type LinearChange = z.output<typeof linearChangeSchema>;
