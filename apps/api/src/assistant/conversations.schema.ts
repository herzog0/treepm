import { z } from "zod";
import { idSchema } from "../common/schemas.js";
import { ticketDetailSchema } from "../tickets/tickets.schema.js";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import { MAX_REASON_CHARS, MAX_SUGGESTED_DESCRIPTION_CHARS } from "./elaboration.js";
import { MAX_DRAFT_CHILDREN } from "./ports.js";
import { PLACED_BY } from "./placement-decision.js";
import { ELABORATION_MAX_LINKS, ELABORATION_MAX_SUGGESTED } from "./prompts.js";

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

export const MAX_SUGGESTED_TASKS = ELABORATION_MAX_SUGGESTED;
export const MAX_LINKS = ELABORATION_MAX_LINKS;
const suggestedTaskSchema = z
  .object({
    title: ticketTitleSchema,
    description: z.string().max(MAX_SUGGESTED_DESCRIPTION_CHARS).default(""),
    /** Uma linha só (ADR 0052, revisão 1): quebra de linha é recusada. */
    motivo: z.string().trim().min(1).max(MAX_REASON_CHARS).refine((text) => !/[\r\n]/.test(text), "O motivo é uma linha só."),
  })
  .strict();
const linkSchema = z
  .object({
    de: z.union([z.literal("pai"), z.number().int().min(0).max(MAX_DRAFT_CHILDREN - 1)]),
    /** O título da parte de origem quando `de` é um índice: a API só liga se o título ainda casa com o do rascunho (ADR 0052, revisão 1). */
    deTitle: z.string().max(200).optional(),
    dependeDe: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,10}$/),
  })
  .strict()
  .refine((link) => link.de === "pai" || (link.deTitle !== undefined && link.deTitle.trim() !== ""), { message: "Ligação de parte leva o título da parte.", path: ["deTitle"] });

/**
 * O pai escolhido (ou `null`: ticket de raiz). Título e descrição do ticket vêm sempre do rascunho da conversa.
 * Com `group`, o ticket nasce dentro de um agrupador novo criado em `parentId`.
 */
export const createTicketBodySchema = z
  .object({
    parentId: idSchema.nullable(),
    group: newGroupSchema.optional(),
    /** As tarefas sugeridas pelo assistente que a pessoa deixou (ADR 0052, item 4); a API as valida de novo, venham de onde vierem. */
    suggested: z.array(suggestedTaskSchema).max(MAX_SUGGESTED_TASKS).default([]),
    /** As ligações "depende de" que a pessoa deixou marcadas: do pai (`"pai"`) ou de uma parte dela, para uma chave de ticket do projeto. */
    links: z.array(linkSchema).max(MAX_LINKS).default([]),
    /**
     * De que tipo foi a escolha do lugar (ADR 0054, adendo), obrigatório. `search`: o destino confirmado da última procura para
     * este rascunho (a API confere); os outros: a pessoa escolheu (opção da pergunta, "fica aqui", lugar recente, mapa).
     */
    placedBy: z.enum(PLACED_BY),
  })
  .strict();

/**
 * Corpo opcional da procura: o agrupador de escopo (ou `null`: o projeto inteiro) e, depois de uma pergunta, o ramo que a pessoa
 * confirmou por último (ADR 0054, adendo). A procura parte de `startId` sem julgá-lo de novo; o servidor não guarda estado de
 * pergunta entre requisições.
 */
export const placementBodySchema = z.object({ scopeId: idSchema.nullable().optional(), startId: idSchema.optional() }).strict();

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

const relatedSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  /** Os ancestrais, da raiz ao pai (sem o próprio ticket). */
  path: z.array(z.object({ id: z.string(), title: z.string() })),
});

const questionPathSchema = z.array(z.object({ id: z.string(), title: z.string() }));
/** A pergunta do lugar (ADR 0054), montada em código; as opções vêm do mais provável ao menos, sem as probabilidades. "Fica aqui" e "nenhum destes" são da tela. */
export const placementQuestionSchema = z.object({
  level: z.number().int(),
  kind: z.enum(["fit", "which", "root", "related", "interrupted"]),
  at: z.object({ id: z.string().nullable(), title: z.string(), path: questionPathSchema }),
  options: z.array(z.object({ id: z.string(), title: z.string(), path: questionPathSchema })).max(3),
});

export const placementOutcomeSchema = z.object({
  /** Há pergunta aberta (ADR 0054); `destination` continua sendo o melhor palpite. `null` quando a procura não teve dúvida. */
  question: placementQuestionSchema.nullable(),
  /** `false` com pergunta aberta; `true` quando a procura não teve dúvida. Só o destino confirmado vale como `placedBy: "search"`. */
  destinationConfirmed: z.boolean(),
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
  /** Tickets relacionados ao pedido (ADR 0052), do mais provável ao menos; sem as probabilidades. Vazio sem relacionado. */
  related: z.array(relatedSchema),
  /** O relacionado que parece ser este mesmo pedido, ou `null` (ADR 0052, item 3). */
  duplicate: z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string() }).nullable(),
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
  /** Ligações pedidas que a API descartou na validação (a criação seguiu): o que, e por quê. */
  warnings: z.array(
    z.discriminatedUnion("code", [
      z.object({ code: z.literal("link_discarded"), de: z.union([z.literal("pai"), z.number().int()]), dependeDe: z.string(), reason: z.enum(["unknown_ticket", "inactive_ticket", "invalid_part", "cycle", "self", "ancestor"]) }),
      z.object({ code: z.literal("suggested_discarded"), title: z.string(), reason: z.enum(["unknown_keys", "forbidden_text"]) }),
    ]),
  ),
});

/**
 * O que a elaboração devolve (ADR 0052, item 4): ligações com tickets que existem (`de` é `"pai"` ou o índice da parte) e tarefas que
 * o pedido implica. `unavailable` diz por que as listas vieram vazias quando o modelo não pôde responder; `null` quando respondeu.
 */
export const elaborationOutcomeSchema = z.object({
  links: z.array(z.object({ de: z.union([z.literal("pai"), z.number().int()]), deTitle: z.string().optional(), dependeDe: z.string(), dependeDeTitle: z.string(), motivo: z.string() })),
  suggested: z.array(z.object({ title: z.string(), description: z.string(), motivo: z.string() })),
  unavailable: z.enum(["not_configured", "consent_required", "unavailable"]).nullable(),
  /** Só números e códigos (nenhum texto de ticket, de rascunho ou do modelo): por que as listas vieram como vieram. Campo aditivo; a web ignora. */
  diagnostics: z
    .object({
      model: z.object({ links: z.number().int(), suggested: z.number().int() }),
      dropped: z.object({
        links: z.object({ outsideList: z.number().int(), duplicateTarget: z.number().int(), invalidPart: z.number().int(), badReason: z.number().int(), repeated: z.number().int(), limit: z.number().int(), ancestor: z.number().int() }),
        suggested: z.object({ forbiddenText: z.number().int(), keyInText: z.number().int(), size: z.number().int(), repeatedTitle: z.number().int(), limit: z.number().int() }),
      }),
      lookups: z.array(
        z.object({
          outcome: z.enum(["converted", "kept", "dropped_duplicate", "dropped_repeated_link", "dropped_limit", "lookup_failed", "skipped_no_time"]),
          candidates: z.number().int(),
          chosen: z.boolean(),
          /** De onde vieram os candidatos (ADR 0053): só com o passo de vetor ligado. */
          origins: z.object({ words: z.number().int(), vector: z.number().int(), both: z.number().int() }).optional(),
        }),
      ),
      timingsMs: z.object({ claude: z.number().int(), lookup: z.number().int(), secondCall: z.number().int() }),
      /** O passo de vetor da elaboração: só números e um código curto. */
      semantic: z
        .object({ synced: z.number().int(), embedded: z.number().int(), pending: z.number().int(), syncMs: z.number().int(), queryMs: z.number().int(), failure: z.string().optional() })
        .optional(),
    })
    .optional(),
});
