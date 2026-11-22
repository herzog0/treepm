import { CONTRIBUTION_STATUSES, CONTRIBUTION_TEXT_MAX, IDEA_STAGES } from "@treepm/domain";
import { z } from "zod";
import { idSchema } from "../common/schemas.js";

export const MAX_IMPORT_ITEMS = 500;
export const MAX_IMPORT_DEPTH = 20;

export const ticketStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
/** Estágio de ideia (ADR 0042). */
export const ideaStageSchema = z.enum(IDEA_STAGES);
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
    /** Cria a ideia no estágio `new` (ADR 0042); a situação de uma ideia é sempre `todo`. */
    idea: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.idea || value.status === undefined || value.status === "todo", "Uma ideia nasce na situação todo.");

/** Mudar o estágio de uma ideia: só os três estágios abertos; descartar tem rota própria. */
export const ideaStageBodySchema = z.object({ stage: z.enum(["new", "refining", "ready"]) }).strict();

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

const progressSchema = z.object({ done: z.number(), total: z.number(), excluded: z.number(), ideas: z.number() });

/** `null`: ticket comum; raiz de ideia com o estágio; ou ticket dentro de uma ideia, com a raiz (ADR 0042). */
export const ticketIdeaSchema = z
  .union([
    z.object({ root: z.literal(true), stage: ideaStageSchema }),
    z.object({ root: z.literal(false), rootId: z.string(), rootKey: z.string() }),
  ])
  .nullable();

/** Marcador de trabalho pela IA (ADR 0043): `null` quando não vale (nunca existiu, foi encerrado ou venceu). */
export const agentWorkSchema = z.object({ since: z.string(), until: z.string(), note: z.string() }).nullable();
/** No detalhe, o marcador diz também quem o ligou (a pessoa do token). */
export const agentWorkDetailSchema = z
  .object({ since: z.string(), until: z.string(), note: z.string(), by: z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() }) })
  .nullable();
export type AgentWork = NonNullable<z.output<typeof agentWorkSchema>>;

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
  idea: ticketIdeaSchema,
  agentWork: agentWorkSchema,
});

/** Uma ideia da lista de ideias do projeto (ADR 0042): a raiz, o caminho (títulos dos ancestrais, do topo para baixo) e a criação. */
export const ideaListItemSchema = z.object({
  id: z.string(),
  number: z.number(),
  key: z.string(),
  title: z.string(),
  stage: ideaStageSchema,
  path: z.array(z.string()),
  createdAt: z.string(),
});
export type IdeaListItem = z.output<typeof ideaListItemSchema>;
export type TicketIdea = z.output<typeof ticketIdeaSchema>;

/** Ticket que menciona outro na descrição (ADR 0037), para a seção "Mencionado em". */
export const mentionedBySchema = z.object({ id: z.string(), key: z.string(), title: z.string(), status: ticketStatusSchema });

/** Ticket do outro lado de uma ligação "depende de" (ADR 0037); mesmo formato de `mentionedBy`. */
export const dependencyLinkSchema = mentionedBySchema;

export const addDependencySchema = z.object({ ticketId: idSchema });

export const ticketDetailSchema = ticketSummarySchema.extend({
  agentWork: agentWorkDetailSchema,
  description: z.string(),
  mentionedBy: z.array(mentionedBySchema),
  /** Tickets de que este depende, em ordem de número. */
  dependsOn: z.array(dependencyLinkSchema),
  /** Tickets que dependem deste, em ordem de número. */
  blocks: z.array(dependencyLinkSchema),
  createdByPersonId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TicketSummary = z.output<typeof ticketSummarySchema>;
export type TicketDetail = z.output<typeof ticketDetailSchema>;

export const contributionStatusSchema = z.enum(CONTRIBUTION_STATUSES);

const contributionPersonSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });

/** Contribuição de uma área no ticket (ADR 0041), como a API a devolve. */
export const contributionSchema = z.object({
  id: z.string(),
  area: z.object({ id: z.string(), name: z.string() }),
  text: z.string(),
  status: contributionStatusSchema,
  people: z.array(contributionPersonSchema),
  /** Comentários vivos desta contribuição (ADR 0041, fatia 2). */
  commentCount: z.number().int().nonnegative(),
});

export const createContributionSchema = z.object({ areaId: idSchema }).strict();

/** Muda o que veio; o texto vai como está (de 0 a 20.000 caracteres), sem aparar. */
export const updateContributionSchema = z
  .object({ text: z.string().max(CONTRIBUTION_TEXT_MAX), status: contributionStatusSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");

/** O ticket como a página o lê (`GET tickets/:id` e as alterações dele): o detalhe mais as contribuições (ADR 0041). */
export const ticketPageSchema = ticketDetailSchema.extend({
  contributions: z.array(contributionSchema),
  /** Para quem lê: pode mexer nas contribuições (falso em projeto arquivado). */
  canEditContributions: z.boolean(),
  /** Para quem lê: pode aceitar e descartar esta ideia (gestor, em raiz de ideia, projeto não arquivado; ADR 0042). */
  canTriageIdea: z.boolean(),
  /** Para quem lê: pode encerrar o marcador de trabalho pela IA (pode editar o ticket, projeto não arquivado, marcador vale; ADR 0043). */
  canEndAgentWork: z.boolean(),
});

export type Contribution = z.output<typeof contributionSchema>;
export type TicketPage = z.output<typeof ticketPageSchema>;
