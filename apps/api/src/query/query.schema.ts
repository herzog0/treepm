import { z } from "zod";
import { labelColorSchema } from "../tickets/labels.schema.js";
import { ideaStageSchema, ticketStatusSchema } from "../tickets/tickets.schema.js";

/**
 * Saídas da camada de consulta do projeto (ADR 0037). Nenhum esquema tem responsável, autor, nome, e-mail ou data:
 * a camada não devolve dado de pessoa, e `strictObject` faz um campo a mais falhar em vez de passar.
 */

/** `null`: ticket comum; `root`: raiz de uma ideia, com o estágio; `inside`: parte de uma ideia, com o número da raiz (ADR 0042, 0043). */
export const queryIdeaSchema = z
  .union([z.strictObject({ kind: z.literal("root"), stage: ideaStageSchema }), z.strictObject({ kind: z.literal("inside"), rootNumber: z.number().int() })])
  .nullable();
export type QueryIdea = z.infer<typeof queryIdeaSchema>;
/**
 * Marcador de trabalho pela IA que vale agora (ADR 0043): só o fim. Sem a nota (texto livre escrito pelo agente de outra pessoa:
 * canal de injeção para quem lê), sem o início e sem a pessoa. A nota fica na tela e na resposta de quem a escreveu.
 */
export const queryAgentWorkSchema = z.strictObject({ until: z.string() }).nullable();

export const querySummarySchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  number: z.number().int(),
  title: z.string(),
  descriptionExcerpt: z.string(),
  status: ticketStatusSchema,
  parentId: z.string().nullable(),
  idea: queryIdeaSchema,
  agentWork: queryAgentWorkSchema,
  /** Prioridade própria (ADR 0047) e a que vale, com a herança do ancestral mais próximo diferente de 0. */
  priority: z.number().int(),
  effectivePriority: z.number().int(),
  /** Prazo (ADR 0064), `AAAA-MM-DD` ou nulo. NÃO vai ao provedor de IA: o assistente só repassa os campos de `brief` (ask-executor). */
  dueDate: z.string().nullable(),
  /**
   * Etiquetas (ADR 0065), em ordem de nome (chave) e id; `[]` sem etiqueta. O nome é texto livre (pode ter vindo do Linear): NÃO vai ao
   * provedor de IA (o assistente só repassa os campos de `brief`) e o MCP escolhe campo a campo (nada de espalhar este resumo).
   */
  labels: z.array(z.strictObject({ id: z.string(), name: z.string(), color: labelColorSchema })),
});
export type QueryTicketSummary = z.infer<typeof querySummarySchema>;

export const queryProgressSchema = z.strictObject({ done: z.number().int(), total: z.number().int(), excluded: z.number().int(), ideas: z.number().int() });

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
    /** "Relacionado a" (ADR 0061): simétrica, só vem do Linear; os dois sentidos numa lista só. */
    related: queryListSchema,
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
  /** Só o que é trabalho: as ideias (raízes e o que está dentro) ficam fora (ADR 0043). */
  total: z.number().int(),
  byStatus: z.strictObject({
    todo: z.number().int(),
    in_progress: z.number().int(),
    in_review: z.number().int(),
    done: z.number().int(),
    cancelled: z.number().int(),
  }),
  /** Quantas raízes de ideia há em cada estágio. */
  ideas: z.strictObject({ new: z.number().int(), refining: z.number().int(), ready: z.number().int(), discarded: z.number().int() }),
  top: z.strictObject({
    tickets: z.array(querySummarySchema.extend({ progress: queryProgressSchema.nullable() })),
    truncated: z.boolean(),
  }),
});
export type QueryOverview = z.infer<typeof queryOverviewSchema>;
