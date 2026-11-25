import { z } from "zod";
import { ACT_AS_HEADER, notifyActAsRejected } from "./actAs.js";
import { closedResultSchema, conversationTreeSchema, conversationViewSchema, openedSchema, participantsResultSchema, readResultSchema, reopenedResultSchema, sendResultSchema } from "./conversations.js";
import type { ChatWriteBody } from "./conversations.js";

const teamRole = z.enum(["admin", "member"]);
const projectRole = z.enum(["manager", "contributor", "reader"]);
const visibility = z.enum(["organization", "private"]);

const meSchema = z.object({
  person: z.object({
    id: z.string(),
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  organization: z.object({ orgId: z.string(), name: z.string(), slug: z.string() }),
  roles: z.object({
    clerk: z.enum(["admin", "member"]),
    teams: z.array(z.object({ teamId: z.string(), role: teamRole })),
    projects: z.array(z.object({ projectId: z.string(), role: projectRole })),
  }),
  /**
   * Ausente em uma API antiga: a IA conta como desligada (ADR 0029). `configured`: o servidor tem as chaves dos provedores;
   * `consent`: a organização aceitou (ADR 0039); `enabled` só vale com os dois e é o que mostra ou esconde as funções de IA.
   * Uma API anterior ao aceite manda só `enabled`.
   */
  assistant: z.object({ enabled: z.boolean(), configured: z.boolean().optional(), consent: z.boolean().optional() }).optional(),
  /** Ausente em uma API antiga: o GitHub conta como desligado (ADR 0032). */
  github: z.object({ enabled: z.boolean() }).optional(),
  /** Preenchido enquanto um administrador vê a aplicação como uma pessoa de teste (ADR 0057); nulo ou ausente: é a própria pessoa. */
  actingAs: z.object({ realDisplayName: z.string() }).nullable().optional(),
  /** A chave "Permitir acesso por MCP" da organização (ADR 0038). Ausente em uma API antiga: a seção não aparece. */
  mcp: z.object({ enabled: z.boolean(), /** A chave "Permitir escrita por MCP" (ADR 0043); ausente em uma API antiga: desligada. */ writeEnabled: z.boolean().optional(), /** A chave "Pessoas e conversas" (ADR 0062); ausente em uma API antiga: desligada. */ peopleEnabled: z.boolean().optional() }).optional(),
});
const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  clerkRole: z.enum(["admin", "member"]),
  active: z.boolean(),
  /** Pessoa de teste (ADR 0057). Ausente em uma API antiga: conta como pessoa de verdade. */
  isTest: z.boolean().optional(),
});
const teamMemberSchema = z.object({ personId: z.string(), role: teamRole });
const teamSchema = z.object({ id: z.string(), name: z.string(), members: z.array(teamMemberSchema) });
const areaSchema = z.object({ id: z.string(), name: z.string() });
const projectMemberSchema = z.object({ personId: z.string(), role: projectRole });
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  visibility,
  archivedAt: z.string().nullable(),
  members: z.array(projectMemberSchema),
  teamIds: z.array(z.string()),
});
const projectTeamSchema = z.object({ projectId: z.string(), teamId: z.string() });
const ticketStatus = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
/** Estágios de ideia (ADR 0042): fora do processo, separados da situação. */
const ideaStage = z.enum(["new", "refining", "ready", "discarded"]);
/**
 * Lugar do ticket numa ideia (ADR 0042): `null` (ou ausente, numa API que ainda não manda o campo) para o ticket comum;
 * a raiz de uma ideia traz o estágio; um ticket dentro dela traz a raiz.
 */
const ideaSchema = z
  .union([z.object({ root: z.literal(true), stage: ideaStage }), z.object({ root: z.literal(false), rootId: z.string(), rootKey: z.string() })])
  .nullable()
  .optional();
/** O marcador de trabalho pela IA (ADR 0043): vale enquanto `until` é futuro. Ausente ou nulo = sem marcador. */
const agentWorkSchema = z
  .object({
    since: z.string(),
    until: z.string(),
    note: z.string().nullable(),
    /** A pessoa do token; só o detalhe do ticket a traz. */
    by: z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() }).nullable().optional(),
  })
  .nullable()
  .optional();
const ticketSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  key: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  /** Situação própria, sempre presente (ADR 0034): todo ticket pode ter filhos e continua sendo trabalho. */
  status: ticketStatus,
  /** Sobre todos os descendentes; `null` quando o ticket não tem filhos. */
  progress: z.object({ done: z.number(), total: z.number(), excluded: z.number(), /** Raízes de ideia abaixo do ticket, fora de `done`, `total` e `excluded` (ADR 0042); ausente = zero. */ ideas: z.number().optional() }).nullable(),
  idea: ideaSchema,
  assigneeIds: z.array(z.string()),
  /** Primeiros caracteres da descrição, para o card em "detalhe" do mapa (ADR 0027). */
  descriptionExcerpt: z.string(),
  agentWork: agentWorkSchema,
  /**
   * Prioridade PRÓPRIA (ADR 0047): inteiro de -999 a 999; maior primeiro. A API sempre manda; é opcional aqui só para os ~30 dados
   * de teste literais compilarem sem mudança (ausente = 0). Quem monta a interface pode apertar para obrigatório.
   */
  priority: z.number().int().optional(),
  /** Depende de ticket ainda aberto (ADR 0037); a fila "próximos para trabalhar" deixa o ticket de fora. A API sempre manda; ausente = não. */
  blocked: z.boolean().optional(),
});
const ticketLinkSchema = z.object({ id: z.string(), key: z.string(), title: z.string(), status: ticketStatus });
const contributionStatus = z.enum(["todo", "in_progress", "done"]);
const contributionSchema = z.object({
  id: z.string(),
  area: z.object({ id: z.string(), name: z.string() }),
  text: z.string(),
  status: contributionStatus,
  people: z.array(z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() })),
  /** Comentários vivos da área (ADR 0041, fatia 2). */
  commentCount: z.number(),
});
const ticketDetailSchema = ticketSummarySchema.extend({
  /** A prioridade que vale (ADR 0047): a própria, ou a do ancestral mais próximo diferente de 0; `from` é o ticket de onde veio (nulo quando tudo é 0). */
  effectivePriority: z.object({ value: z.number().int(), from: z.object({ id: z.string(), key: z.string() }).nullable() }).optional(),
  /** As contribuições por área, na ordem de criação (ADR 0041). Ausente (ticket devolvido pela conversa com a IA): nenhuma. */
  contributions: z.array(contributionSchema).optional(),
  /** Quem lê pode mexer nelas (falso em projeto arquivado). */
  canEditContributions: z.boolean().optional(),
  /** Quem lê pode encerrar o marcador (quem pode editar o ticket); ausente = não. */
  canEndAgentWork: z.boolean().optional(),
  description: z.string(),
  /** De onde o ticket veio (ADR 0060): o Linear, com a chave da issue (`null` num projeto do Linear) e o endereço. Ausente: sem origem externa. */
  externalSource: z.object({ provider: z.literal("linear"), key: z.string().nullable(), url: z.string().nullable(), missingSince: z.string().nullable().optional() }).nullable().optional(),
  /** Quem lê pode aceitar e descartar a ideia (gestor do projeto, ADR 0042); ausente = não. */
  canTriageIdea: z.boolean().optional(),
  /** Os tickets do projeto que mencionam este na descrição, em ordem de número (ADR 0037). */
  mentionedBy: z.array(ticketLinkSchema),
  /** Os tickets de que este depende e os que dependem deste, em ordem de número (ADR 0037). */
  dependsOn: z.array(ticketLinkSchema),
  blocks: z.array(ticketLinkSchema),
  createdByPersonId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const draftChildSchema = z.object({ title: z.string(), description: z.string() });
/** Rascunho da conversa (ADR 0044): `children` vazio é um ticket só; a API sempre o manda (e um servidor antigo vale como vazio). `idea`: registrar como ideia ao criar (falso num servidor antigo). */
const draftSchema = z.object({ title: z.string(), description: z.string(), children: z.array(draftChildSchema).default([]), idea: z.boolean().default(false) }).nullable();
/** O que a criação vai gravar, como a API monta (`GET …/preview`, ADR 0044): o pai com a citação, os filhos e o que ela recusaria. */
const draftPreviewSchema = z.object({
  title: z.string(),
  description: z.string(),
  quote: z.string(),
  children: z.array(draftChildSchema),
  /** O rascunho será registrado como ideia ao criar (um servidor antigo vale como falso). */
  idea: z.boolean().default(false),
  unknownKeys: z.array(z.string()),
  descriptionTooLong: z.boolean(),
});
const conversationSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(["open", "ticket_created", "discarded"]),
  draft: draftSchema,
  /** Opinião da IA no último turno; a pessoa pode procurar o lugar a qualquer momento. */
  ready: z.boolean(),
  createdTicketId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(
    z.object({ id: z.string(), author: z.enum(["person", "assistant"]), body: z.string(), model: z.string().nullable(), createdAt: z.string() }),
  ),
});
const placementTargetSchema = z.object({ parentId: z.string().nullable(), path: z.array(z.object({ id: z.string(), title: z.string() })) });
const questionPathSchema = z.array(z.object({ id: z.string(), title: z.string() }));
/**
 * A decisão que o servidor guarda da última procura da conversa (só ids e números): a tela a usa para remontar a pergunta aberta ou o
 * destino confirmado quando a thread reabre. Só os campos que a tela lê.
 */
const placementDecisionSchema = z.object({
  decision: z
    .object({
      chosenPath: z.array(z.string()),
      related: z.array(z.object({ ticketId: z.string() }).passthrough()).default([]),
      duplicateTicketId: z.string().nullable().default(null),
      doubt: z
        .object({
          confirmed: z.boolean(),
          question: z.object({ level: z.number(), kind: z.enum(["fit", "which", "root", "related", "interrupted"]), parentId: z.string().nullable(), options: z.array(z.object({ ticketId: z.string() }).passthrough()) }).passthrough().nullable(),
        })
        .passthrough()
        .nullable()
        .default(null),
    })
    .passthrough()
    .nullable(),
});
const placementOutcomeSchema = z.object({
  /** Há dúvida sobre o lugar (ADR 0054): a pergunta montada pelo servidor; `null` sem dúvida. */
  question: z
    .object({
      level: z.number(),
      kind: z.enum(["fit", "which", "root", "related", "interrupted"]),
      at: z.object({ id: z.string().nullable(), title: z.string(), path: questionPathSchema }),
      options: z.array(z.object({ id: z.string(), title: z.string(), path: questionPathSchema })),
    })
    .nullable(),
  /** `false` com pergunta aberta ou sem a decisão guardada: `destination` é só o palpite. Só o destino confirmado vale como `placedBy: "search"`. */
  destinationConfirmed: z.boolean(),
  destination: placementTargetSchema,
  alternatives: z.array(placementTargetSchema).max(2),
  discarded: z.array(z.object({ level: z.number(), parentId: z.string().nullable(), ticketId: z.string(), title: z.string() })),
  uncertain: z.boolean(),
  stoppedEarly: z
    .object({ reason: z.enum(["candidates_too_large", "max_levels"]), level: z.number(), parentId: z.string().nullable() })
    .nullable(),
  /** `null` sem escopo (e numa API que ainda não manda o campo). */
  scope: z.object({ id: z.string(), title: z.string(), outOfScope: z.boolean() }).nullable().default(null),
  /** Ticket pai novo que a IA propõe no destino (ADR 0031, ADR 0034); `null` sem proposta (e numa API que ainda não manda o campo). */
  groupProposal: z
    .object({
      title: z.string(),
      description: z.string(),
      tickets: z.array(z.object({ id: z.string(), number: z.number(), title: z.string() })).min(1),
    })
    .nullable()
    .default(null),
  /** Tickets relacionados ao pedido (ADR 0052), do mais provável ao menos; vazio sem relacionado (e numa API que ainda não manda o campo). */
  related: z
    .array(z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string(), path: z.array(z.object({ id: z.string(), title: z.string() })) }))
    .default([]),
  /** O relacionado que parece ser este mesmo pedido; `null` sem duplicado (e numa API que ainda não manda o campo). */
  duplicate: z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string().default("todo") }).nullable().default(null),
  /** Por que não houve proposta, quando há um motivo; `null` quando há proposta ou ninguém passou do limiar. */
  groupProposalSkipped: z
    .enum(["not_settled", "no_loose_tickets", "too_large", "same_as_destination", "invalid_name", "unavailable"])
    .nullable()
    .default(null),
});
const createdFromConversationSchema = z.object({
  conversation: conversationDetailSchema,
  ticket: ticketDetailSchema,
  children: z.array(ticketDetailSchema).default([]),
  /** Ligações pedidas que a API descartou na validação (a criação seguiu). */
  warnings: z
    .array(
      z.discriminatedUnion("code", [
        z.object({ code: z.literal("link_discarded"), de: z.union([z.literal("pai"), z.number().int()]), dependeDe: z.string(), reason: z.string() }),
        z.object({ code: z.literal("suggested_discarded"), title: z.string(), reason: z.string() }),
      ]),
    )
    .default([]),
});
/** A elaboração (ADR 0052, item 4): ligações com tickets que existem e tarefas que o pedido implica; `unavailable` diz por que vieram vazias. */
const elaborationOutcomeSchema = z.object({
  links: z.array(z.object({ de: z.union([z.literal("pai"), z.number().int()]), deTitle: z.string().optional(), dependeDe: z.string(), dependeDeTitle: z.string(), motivo: z.string() })),
  suggested: z.array(z.object({ title: z.string(), description: z.string(), motivo: z.string() })),
  unavailable: z.enum(["not_configured", "consent_required", "unavailable"]).nullable().default(null),
});
const githubInstallationSchema = z.object({
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.enum(["all", "selected"]),
  connectedAt: z.string(),
});
const githubRepositorySchema = z.object({
  repoId: z.number(),
  fullName: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
});
/** A chave pessoal do Linear (ADR 0060): nunca volta ao navegador; só o workspace, os 4 últimos caracteres e a data. */
const linearConnectionSchema = z.object({
  configured: z.boolean(),
  /** Só agindo como outra pessoa: o servidor responde 200 sem conexão (a chave é pessoal) e a tela mostra a frase própria. */
  actingAs: z.boolean().optional(),
  connection: z.object({ workspace: z.object({ id: z.string(), name: z.string() }), hint: z.string(), connectedAt: z.string() }).nullable(),
});
const linearTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  /** Ligado a um projeto que a pessoa enxerga. */
  linkedProject: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Ligado a um projeto que ela não enxerga (sem nome). */
  linkedElsewhere: z.boolean(),
  /** Quando o time teve a última importação concluída; ausente ou nulo: nunca. */
  lastImportedAt: z.string().nullable().optional(),
});
const projectLinearSchema = z.object({
  source: z
    .object({
      workspace: z.object({ id: z.string(), name: z.string() }),
      team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
      linkedAt: z.string(),
      linkedBy: z.object({ id: z.string() }),
    })
    .nullable(),
  canLink: z.boolean(),
  /** `null`: sem chave, sem origem, ou o Linear não respondeu. */
  keyMatches: z.boolean().nullable(),
});
/** A rodada de importação do Linear como a API a devolve (ADR 0060, seção 3): só contagens, nada do texto do Linear. */
const linearRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  mode: z.enum(["first", "reimport"]),
  phase: z.enum(["projects", "issues", "hierarchy", "statuses", "mentions", "categorize", "missing", "done", "failed"]),
  done: z.boolean(),
  categorize: z.boolean(),
  categorizeAvailable: z.boolean(),
  counts: z.record(z.string(), z.union([z.number(), z.boolean()])),
  errorStreak: z.number(),
  pageSize: z.number(),
  totalExpected: z.number().nullable(),
  waitUntil: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  destinationTicketId: z.string().nullable(),
  startedBy: z.object({ id: z.string() }),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
/** `lastFinished`: a última rodada concluída (a reimportação mostra as contagens dela); ausente num servidor antigo. */
const currentLinearRunSchema = z.object({ run: linearRunSchema.nullable(), lastFinished: linearRunSchema.nullable().optional() });
/** Quantas issues a importação traria; `null` quando o Linear não disse (nunca bloqueia o botão). */
const linearPreviewSchema = z.object({ issueCount: z.number().nullable() });
/** A procura do lugar dos itens importados (ADR 0060, seção 6): a rodada como a API a devolve; só contagens, nada do texto dos tickets. */
const categorizeViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceRunId: z.string().nullable(),
  phase: z.enum(["categorize", "done", "failed"]),
  finished: z.boolean(),
  total: z.number(),
  done: z.number(),
  placed: z.number(),
  toCheck: z.number(),
  kept: z.number(),
  skipped: z.number(),
  failed: z.number(),
  waitUntil: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  errorStreak: z.number(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
const categorizeOverviewSchema = z.object({
  available: z.boolean(),
  reason: z.enum(["assistant_not_configured", "assistant_consent_required"]).nullable(),
  candidates: z.number(),
  /** O teto de itens por rodada; a procura seguinte cuida do resto. */
  batchLimit: z.number(),
  sourceRunId: z.string().nullable(),
  /** A rodada aberta, ou a última; `finished` diz qual. */
  run: categorizeViewSchema.nullable(),
  toCheck: z.number(),
});
const toCheckSchema = z.object({
  items: z.array(z.object({ ticketId: z.string(), key: z.string(), title: z.string(), suggestedPath: z.array(z.object({ id: z.string(), title: z.string() })) })),
});
const projectRepositorySchema = githubRepositorySchema.extend({ id: z.string(), linkedAt: z.string() });
const codeRefreshSchema = z.object({
  refreshed: z.boolean(),
  syncedAt: z.string().nullable(),
  repositories: z.array(z.object({ id: z.string(), fullName: z.string(), status: z.enum(["ok", "truncated", "unavailable"]) })),
});
const codeLinkSchema = z.object({
  id: z.string(),
  kind: z.enum(["branch", "pull_request"]),
  ticket: z.object({ id: z.string(), key: z.string(), title: z.string() }),
  repository: z.object({ fullName: z.string(), htmlUrl: z.string() }),
  ref: z.string(),
  number: z.number().nullable(),
  title: z.string().nullable(),
  state: z.enum(["active", "open", "merged", "closed"]),
  url: z.string(),
  updatedAt: z.string().nullable(),
});
const ticketCodeSchema = z.object({ repositories: z.number(), syncedAt: z.string().nullable(), links: z.array(codeLinkSchema) });
const descriptionDraftSchema = z.object({ text: z.string(), model: z.string() });
const ticketSummaryTextSchema = z.object({
  summary: z.object({ text: z.string(), source: z.enum(["assistant", "person", "built"]), updatedAt: z.string().optional(), built: z.boolean().optional() }).nullable(),
});
const activityPersonSchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });
/** Ticket citado numa entrada: `id` e `title` nulos quando ele não existe mais (a chave pode faltar também). */
const activityTicketSchema = z.object({ id: z.string().nullable(), key: z.string().nullable(), title: z.string().nullable() });
/** A área de uma entrada de contribuição: `null` quando já não existe nem o nome ficou guardado. */
const contributionAreaRef = z.object({ id: z.string(), name: z.string() }).nullable();
/** A área de um comentário: `id` é o da contribuição, nulo quando ela foi removida (o nome ficou guardado); `null` no comentário do ticket. */
const commentAreaRef = z.object({ id: z.string().nullable(), name: z.string() }).nullable();
/** `via: "mcp"`: a entrada foi gravada por uma chamada MCP (ADR 0043); ausente = feita à mão. */
const activityBase = { id: z.string(), occurredAt: z.string(), actor: activityPersonSchema.nullable(), via: z.enum(["mcp"]).nullish(), /** A reimportação do Linear gravou a mudança (ADR 0060); em `status_changed` é obrigatório. */ automatic: z.literal(true).optional() };
const activityEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...activityBase, type: z.literal("created") }),
  z.object({ ...activityBase, type: z.literal("title_changed"), from: z.string(), to: z.string() }),
  z.object({ ...activityBase, type: z.literal("description_changed") }),
  z.object({ ...activityBase, type: z.literal("status_changed"), from: ticketStatus, to: ticketStatus, automatic: z.boolean(), causedBy: activityTicketSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("parent_changed"), from: activityTicketSchema.nullable(), to: activityTicketSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("agent_work_started"), until: z.string() }),
  z.object({ ...activityBase, type: z.literal("agent_work_ended"), reason: z.enum(["agent", "person", "finished", "idea", "archived"]) }),
  z.object({ ...activityBase, type: z.literal("priority_changed"), from: z.number().int(), to: z.number().int() }),
  z.object({ ...activityBase, type: z.literal("idea_registered") }),
  z.object({ ...activityBase, type: z.literal("idea_stage_changed"), from: ideaStage, to: ideaStage }),
  z.object({ ...activityBase, type: z.literal("idea_accepted") }),
  z.object({ ...activityBase, type: z.literal("idea_discarded") }),
  z.object({ ...activityBase, type: z.literal("idea_reopened") }),
  z.object({ ...activityBase, type: z.literal("assignee_added"), person: activityPersonSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("assignee_removed"), person: activityPersonSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("dependency_added"), ticket: activityTicketSchema }),
  z.object({ ...activityBase, type: z.literal("dependency_removed"), ticket: activityTicketSchema }),
  z.object({ ...activityBase, type: z.literal("summary_updated"), source: z.enum(["person", "assistant"]) }),
  z.object({ ...activityBase, type: z.literal("contribution_added"), area: contributionAreaRef }),
  z.object({ ...activityBase, type: z.literal("contribution_removed"), area: contributionAreaRef }),
  z.object({ ...activityBase, type: z.literal("contribution_text_changed"), area: contributionAreaRef }),
  z.object({ ...activityBase, type: z.literal("contribution_status_changed"), area: contributionAreaRef, from: contributionStatus, to: contributionStatus }),
  z.object({ ...activityBase, type: z.literal("contribution_person_added"), area: contributionAreaRef, person: activityPersonSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("contribution_person_removed"), area: contributionAreaRef, person: activityPersonSchema.nullable() }),
  z.object({ ...activityBase, type: z.literal("comment"), body: z.string().nullable(), area: commentAreaRef, editedAt: z.string().nullable(), removed: z.boolean(), canEdit: z.boolean(), canRemove: z.boolean() }),
]);
const commentEntrySchema = activityEntrySchema.refine((entry) => entry.type === "comment").transform((entry) => entry as Extract<z.output<typeof activityEntrySchema>, { type: "comment" }>);
/** Entrada de um tipo que esta versão da tela não conhece (a API pode ganhar tipos antes da tela) é descartada, sem erro. */
const activityPageSchema = z.object({
  entries: z.array(z.unknown()).transform((items) => items.flatMap((item) => {
    const parsed = activityEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
  before: z.string().nullable(),
  /** Quem lê pode escrever comentário agora (falso para leitor e projeto arquivado). */
  canComment: z.boolean(),
});
const accessTokenSchema = z.object({
  id: z.string(),
  /** O alcance do token (ADR 0043); ausente em uma API antiga: leitura. */
  scope: z.enum(["read", "write"]).optional(),
  /** O alcance "pessoas e conversas" (ADR 0062), independente de `scope`; ausente em uma API antiga: sem ele. */
  people: z.boolean().optional(),
  name: z.string(),
  project: z.object({ id: z.string(), key: z.string() }),
  tokenPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
/** O token inteiro só existe nesta resposta (ADR 0038). */
const createdAccessTokenSchema = accessTokenSchema.extend({ token: z.string() });
const organizationAccessTokenSchema = accessTokenSchema.extend({ person: z.object({ id: z.string(), displayName: z.string() }) });
const consentSchema = z.object({
  inForce: z.boolean(),
  version: z.string().nullable(),
  acceptedBy: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  /** Há aceite aberto, mas de uma versão antiga dos documentos: precisa aceitar de novo. */
  outdated: z.boolean(),
});
/** O aceite da organização para a IA (ADR 0039): o estado inteiro, devolvido também por aceitar e retirar. */
const aiConsentSchema = z.object({
  currentVersion: z.string(),
  assistant: consentSchema,
  codeReading: consentSchema.extend({ githubConnected: z.boolean(), offerable: z.boolean() }),
});
const mcpStateSchema = z.object({ mcp: z.object({ enabled: z.boolean(), writeEnabled: z.boolean().optional(), peopleEnabled: z.boolean().optional() }) });
const errorBodySchema = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }) });

export type Me = z.output<typeof meSchema>;
export type { ChatMessage, ChatPerson, ChatRead, ChatWriteBody, ConversationInfo, ConversationPurpose, ConversationNode, ConversationTicket, ConversationTree, ConversationView, SendResult, ThreadCard, TrailItem } from "./conversations.js";
export type AiConsent = z.output<typeof aiConsentSchema>;
export type AiConsentKind = "assistant" | "code_reading";
export type Person = z.output<typeof personSchema>;
export type TeamRole = z.output<typeof teamRole>;
export type TeamMember = z.output<typeof teamMemberSchema>;
export type Team = z.output<typeof teamSchema>;
export type Area = z.output<typeof areaSchema>;
export type ProjectRole = z.output<typeof projectRole>;
export type ProjectVisibility = z.output<typeof visibility>;
export type ProjectMember = z.output<typeof projectMemberSchema>;
export type Project = z.output<typeof projectSchema>;
export type ProjectTeam = z.output<typeof projectTeamSchema>;
export type TicketStatus = z.output<typeof ticketStatus>;
/** Uma ideia da lista do projeto (ADR 0042): `path` são os títulos dos ancestrais, da raiz para baixo. */
const ideaListItemSchema = z.object({ id: z.string(), number: z.number(), key: z.string(), title: z.string(), stage: ideaStage, path: z.array(z.string()), createdAt: z.string() });
export type IdeaStage = z.output<typeof ideaStage>;
export type IdeaListItem = z.output<typeof ideaListItemSchema>;
export type TicketIdea = NonNullable<z.output<typeof ideaSchema>>;
export type TicketSummary = z.output<typeof ticketSummarySchema>;

/**
 * A lista de tickets de um projeto, pedida com a versão que já se tem (ADR 0046): `changed: false` é o `304` ("nada mudou", sem
 * lista); `changed: true` traz a lista inteira e a versão (o `ETag`) a guardar, ou `null` se o servidor não mandou.
 */
export type TicketListUpdate = { changed: false } | { changed: true; tickets: TicketSummary[]; version: string | null };
export type TicketDetail = z.output<typeof ticketDetailSchema>;
export type Contribution = z.output<typeof contributionSchema>;
export type ContributionStatus = z.output<typeof contributionStatus>;
export type ActivityEntry = z.output<typeof activityEntrySchema>;
export type ActivityPage = z.output<typeof activityPageSchema>;
export type CommentArea = z.output<typeof commentAreaRef>;
export type ActivityComment = Extract<ActivityEntry, { type: "comment" }>;
export type ActivityTicketRef = z.output<typeof activityTicketSchema>;
export type ConversationDraft = NonNullable<z.output<typeof draftSchema>>;
export type ConversationDraftChild = z.output<typeof draftChildSchema>;
export type DraftPreview = z.output<typeof draftPreviewSchema>;
/** Corpo de `PATCH …/draft`: `children` ausente mantém os filhos; a lista enviada (mesmo vazia) substitui a anterior. */
export interface ConversationDraftBody {
  title: string;
  description: string;
  children?: ConversationDraftChild[];
  /** Registrar como ideia ao criar (ADR 0044, adendo); ausente mantém a opção como está. */
  idea?: boolean;
}
export type ConversationSummary = z.output<typeof conversationSummarySchema>;
export type ConversationDetail = z.output<typeof conversationDetailSchema>;
export type PlacementTarget = z.output<typeof placementTargetSchema>;
export type PlacementOutcome = z.output<typeof placementOutcomeSchema>;
export type PlacementDecision = NonNullable<z.output<typeof placementDecisionSchema>["decision"]>;
export type ElaborationOutcome = z.output<typeof elaborationOutcomeSchema>;
export type CreatedFromConversation = z.output<typeof createdFromConversationSchema>;
export type SuggestedTask = ElaborationOutcome["suggested"][number];
export type ProposedLink = ElaborationOutcome["links"][number];
/** O que a criação leva da elaboração: as tarefas que ficaram e as ligações marcadas. */
/** De que tipo foi a escolha do lugar na criação (ADR 0054, adendo): o destino confirmado da procura, uma opção, "fica aqui", um lugar recente ou o mapa. */
export type PlacedBy = "search" | "option" | "stay" | "recent" | "map";
export interface ElaborationChoice {
  suggested?: SuggestedTask[];
  links?: { de: "pai" | number; deTitle?: string; dependeDe: string }[];
}
export type GroupProposal = NonNullable<PlacementOutcome["groupProposal"]>;
/** O ticket pai novo que a pessoa confirmou: criado no destino escolhido, com estes tickets movidos para ele. */
export interface NewGroup {
  title: string;
  description: string;
  ticketIds: string[];
}
export type GithubInstallation = z.output<typeof githubInstallationSchema>;
export type GithubRepository = z.output<typeof githubRepositorySchema>;
export type ProjectRepository = z.output<typeof projectRepositorySchema>;
export type LinearConnection = z.output<typeof linearConnectionSchema>;
export type LinearTeam = z.output<typeof linearTeamSchema>;
export type ProjectLinear = z.output<typeof projectLinearSchema>;
export type LinearRun = z.output<typeof linearRunSchema>;
export type LinearPreview = z.output<typeof linearPreviewSchema>;
export type CategorizeView = z.output<typeof categorizeViewSchema>;
export type CategorizeOverview = z.output<typeof categorizeOverviewSchema>;
export type ToCheckList = z.output<typeof toCheckSchema>;
export type ToCheckItem = ToCheckList["items"][number];
export type CurrentLinearRun = z.output<typeof currentLinearRunSchema>;
export interface OpenLinearRunBody {
  /** O ticket onde as issues novas entram; nulo: a raiz do projeto; ausente: herda o destino da primeira importação. */
  destinationTicketId?: string | null;
}
export interface LinkProjectToLinearBody {
  teamId: string;
  /** A chave do time (`ENG`), digitada na confirmação dupla. */
  confirmTeamKey: string;
}
export type CodeRefresh = z.output<typeof codeRefreshSchema>;
export type CodeLink = z.output<typeof codeLinkSchema>;
export type TicketCode = z.output<typeof ticketCodeSchema>;
/** "O que entra aqui" de um ticket com filhos (ADR 0033, ADR 0034): o texto guardado, quem o escreveu por último e quando. */
export type GroupSummary = z.output<typeof ticketSummaryTextSchema>;
/** Corpo do retorno do GitHub: `code` e `state` da URL e, quando veio um inteiro positivo, o `installation_id`. */
export interface CompleteGithubBody {
  code: string;
  state: string;
  installationId?: number;
}
export type AccessToken = z.output<typeof accessTokenSchema>;
export type CreatedAccessToken = z.output<typeof createdAccessTokenSchema>;
export type OrganizationAccessToken = z.output<typeof organizationAccessTokenSchema>;
export interface CreateAccessTokenBody {
  projectId: string;
  name: string;
  expiresInDays: 30 | 90 | 365;
  /** Padrão da API: leitura (ADR 0043). */
  scope?: "read" | "write";
  /** O alcance "pessoas e conversas" (ADR 0062); padrão da API: desligado. */
  people?: boolean;
}

export interface ImportItem {
  title: string;
  description?: string;
  status?: TicketStatus;
  children?: ImportItem[];
}
export interface ImportTicketsBody {
  parentId?: string | null;
  items: ImportItem[];
}
export interface CreateTicketBody {
  title: string;
  description?: string;
  parentId?: string | null;
  status?: TicketStatus;
  assigneeIds?: string[];
  /** Registra o ticket como raiz de uma ideia, no estágio "Nova" (ADR 0042). */
  idea?: boolean;
}
export interface UpdateTicketBody {
  title?: string;
  description?: string;
  status?: TicketStatus;
  parentId?: string | null;
  /** Prioridade própria (ADR 0047): inteiro de -999 a 999. */
  priority?: number;
}

export type ApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "server_error"
  | "unavailable";
export interface ApiError {
  kind: ApiErrorKind;
  /** Código do corpo `{ error: { code, message } }` da API, quando presente. */
  code?: string;
  /** Chaves citadas que não existem, no erro `unknown_ticket_keys` (`details.keys`); nos outros erros, ausente. */
  keys?: string[];
  /** `details` dos erros do chat que a tela usa (`retryAfterSeconds`, `personIds`, `max`); nos outros erros, ausente. */
  details?: Record<string, unknown>;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface CreateProjectBody {
  name: string;
  key: string;
  visibility?: ProjectVisibility;
}
export interface UpdateProjectBody {
  name?: string;
  visibility?: ProjectVisibility;
  archived?: boolean;
}

export interface ApiClientOptions {
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Quem se está vendo como (ADR 0057): fixado na criação do cliente, que manda sempre o mesmo cabeçalho. Nulo: a própria pessoa. */
  actAsId?: string | null;
}

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  500: "server_error",
};

/** Cabeçalhos de todo pedido: a sessão e, no "entrar como" (ADR 0057), a pessoa de teste escolhida nesta aba. */
function authHeaders(token: string, actAsId: string | null): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(actAsId !== null ? { [ACT_AS_HEADER]: actAsId } : {}) };
}

const fail = (kind: ApiErrorKind, code?: string, keys?: string[], details?: Record<string, unknown>): { ok: false; error: ApiError } => ({
  ok: false,
  error: { kind, ...(code === undefined ? {} : { code }), ...(keys === undefined ? {} : { keys }), ...(details === undefined ? {} : { details }) },
});

/** Erros do chat cujos `details` a tela usa: os outros códigos nunca os levam. */
const CHAT_DETAIL_CODES = new Set(["chat_rate_limited", "chat_thread_rate_limited", "mention_not_allowed", "too_many_mentions", "linear_rate_limited"]);
function chatDetailsOf(code: string, details: unknown): Record<string, unknown> | undefined {
  return CHAT_DETAIL_CODES.has(code) && typeof details === "object" && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined;
}

/** `details.keys` do erro `unknown_ticket_keys`: só a lista de textos conta, o resto é ignorado. */
function unknownKeysOf(code: string, details: unknown): string[] | undefined {
  if (code !== "unknown_ticket_keys" || typeof details !== "object" || details === null) return undefined;
  const keys = (details as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.every((key) => typeof key === "string") ? (keys as string[]) : undefined;
}

export function createApiClient({ getToken, fetch: fetchImpl, actAsId = null }: ApiClientOptions) {
  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | null,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ApiResult<T>> {
    try {
      const token = await getToken();
      if (!token) return fail("unauthenticated");

      const headers = authHeaders(token, actAsId);
      const init: RequestInit = { headers };
      if (signal) init.signal = signal;
      if (method !== "GET") init.method = method;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      const response = await (fetchImpl ?? globalThis.fetch)(path, init);
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
        if (parsed.success && parsed.data.error.code === "act_as_not_allowed" && actAsId !== null) notifyActAsRejected(actAsId);
        return fail(
          KIND_BY_STATUS[response.status] ?? "unavailable",
          parsed.success ? parsed.data.error.code : undefined,
          parsed.success ? unknownKeysOf(parsed.data.error.code, parsed.data.error.details) : undefined,
          parsed.success ? chatDetailsOf(parsed.data.error.code, parsed.data.error.details) : undefined,
        );
      }
      if (schema === null) return { ok: true, data: undefined as T };

      const parsed = schema.safeParse(await response.json());
      return parsed.success ? { ok: true, data: parsed.data } : fail("unavailable");
    } catch {
      return fail("unavailable");
    }
  }

  /** `GET` da lista de tickets com `If-None-Match` (ADR 0046). O `304` não tem corpo e não é erro. */
  async function listTicketsIfChanged(projectId: string, version: string | null, signal?: AbortSignal): Promise<ApiResult<TicketListUpdate>> {
    try {
      const token = await getToken();
      if (!token) return fail("unauthenticated");
      const headers = authHeaders(token, actAsId);
      if (version !== null) headers["If-None-Match"] = version;
      const init: RequestInit = { headers };
      if (signal) init.signal = signal;
      const response = await (fetchImpl ?? globalThis.fetch)(`/api/projects/${projectId}/tickets`, init);
      if (response.status === 304) return { ok: true, data: { changed: false } };
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
        if (parsed.success && parsed.data.error.code === "act_as_not_allowed" && actAsId !== null) notifyActAsRejected(actAsId);
        return fail(KIND_BY_STATUS[response.status] ?? "unavailable", parsed.success ? parsed.data.error.code : undefined);
      }
      const parsed = z.array(ticketSummarySchema).safeParse(await response.json());
      return parsed.success ? { ok: true, data: { changed: true, tickets: parsed.data, version: response.headers.get("ETag") } } : fail("unavailable");
    } catch {
      return fail("unavailable");
    }
  }

  const team = (id: string) => `/api/teams/${id}`;
  const project = (id: string) => `/api/projects/${id}`;
  const ticket = (id: string) => `/api/tickets/${id}`;
  const conversation = (id: string) => `/api/ticket-conversations/${id}`;
  const chatQuery = (query: { limit?: number; before?: string }) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.before !== undefined) params.set("before", query.before);
    const text = params.toString();
    return text === "" ? "" : `?${text}`;
  };

  return {
    getMe: () => request("GET", "/api/me", meSchema),
    listPeople: () => request("GET", "/api/people", z.array(personSchema)),
    /** Pessoas de teste (ADR 0057): só administrador, e nunca agindo como outra pessoa. */
    createTestPerson: (displayName: string) => request("POST", "/api/people/test", personSchema, { displayName }),
    deactivateTestPerson: (id: string) => request("POST", `/api/people/${id}/deactivate`, personSchema),
    reactivateTestPerson: (id: string) => request("POST", `/api/people/${id}/reactivate`, personSchema),

    listTeams: () => request("GET", "/api/teams", z.array(teamSchema)),
    createTeam: (body: { name: string }) => request("POST", "/api/teams", teamSchema, body),
    renameTeam: (id: string, body: { name: string }) => request("PATCH", team(id), teamSchema, body),
    removeTeam: (id: string) => request("DELETE", team(id), null),
    putTeamMember: (teamId: string, personId: string, body: { role: TeamRole }) =>
      request("PUT", `${team(teamId)}/members/${personId}`, teamMemberSchema, body),
    removeTeamMember: (teamId: string, personId: string) =>
      request("DELETE", `${team(teamId)}/members/${personId}`, null),

    listAreas: () => request("GET", "/api/areas", z.array(areaSchema)),
    createArea: (body: { name: string }) => request("POST", "/api/areas", areaSchema, body),
    renameArea: (id: string, body: { name: string }) => request("PATCH", `/api/areas/${id}`, areaSchema, body),
    removeArea: (id: string) => request("DELETE", `/api/areas/${id}`, null),

    listProjects: () => request("GET", "/api/projects", z.array(projectSchema)),
    getProject: (id: string) => request("GET", project(id), projectSchema),
    createProject: (body: CreateProjectBody) => request("POST", "/api/projects", projectSchema, body),
    updateProject: (id: string, body: UpdateProjectBody) => request("PATCH", project(id), projectSchema, body),
    putProjectMember: (projectId: string, personId: string, body: { role: ProjectRole }) =>
      request("PUT", `${project(projectId)}/members/${personId}`, projectMemberSchema, body),
    removeProjectMember: (projectId: string, personId: string) =>
      request("DELETE", `${project(projectId)}/members/${personId}`, null),
    putProjectTeam: (projectId: string, teamId: string) =>
      request("PUT", `${project(projectId)}/teams/${teamId}`, projectTeamSchema),
    removeProjectTeam: (projectId: string, teamId: string) =>
      request("DELETE", `${project(projectId)}/teams/${teamId}`, null),

    listTickets: (projectId: string) => request("GET", `${project(projectId)}/tickets`, z.array(ticketSummarySchema)),
    listTicketsIfChanged,
    getTicket: (id: string) => request("GET", ticket(id), ticketDetailSchema),
    createTicket: (projectId: string, body: CreateTicketBody) =>
      request("POST", `${project(projectId)}/tickets`, ticketDetailSchema, body),
    updateTicket: (id: string, body: UpdateTicketBody) => request("PATCH", ticket(id), ticketDetailSchema, body),
    removeTicket: (id: string) => request("DELETE", ticket(id), null),
    /** Ideias (ADR 0042): todas devolvem o detalhe do ticket. Mudar o estágio é de quem edita; aceitar e descartar, do gestor. */
    /** As ideias do projeto, por estágio (`ready`, `refining`, `new`, `discarded`) e, dentro dele, da mais antiga para a mais nova. */
    listIdeas: (projectId: string) => request("GET", `${project(projectId)}/ideas`, z.array(ideaListItemSchema)),
    putIdeaStage: (id: string, body: { stage: Exclude<IdeaStage, "discarded"> }) => request("PUT", `${ticket(id)}/idea-stage`, ticketDetailSchema, body),
    acceptIdea: (id: string) => request("POST", `${ticket(id)}/idea/accept`, ticketDetailSchema),
    discardIdea: (id: string) => request("POST", `${ticket(id)}/idea/discard`, ticketDetailSchema),
    /** Transforma um ticket comum em ideia (409 com código próprio quando há trabalho em andamento nele ou abaixo dele). */
    makeIdea: (id: string) => request("POST", `${ticket(id)}/idea`, ticketDetailSchema),
    putTicketAssignee: (id: string, personId: string) =>
      request("PUT", `${ticket(id)}/assignees/${personId}`, ticketDetailSchema),
    removeTicketAssignee: (id: string, personId: string) =>
      request("DELETE", `${ticket(id)}/assignees/${personId}`, null),
    /** Contribuições por área (ADR 0041): a resposta é a contribuição inteira. */
    createContribution: (ticketId: string, body: { areaId: string }) => request("POST", `${ticket(ticketId)}/contributions`, contributionSchema, body),
    updateContribution: (id: string, body: { text?: string; status?: ContributionStatus }) => request("PATCH", `/api/contributions/${id}`, contributionSchema, body),
    removeContribution: (id: string) => request("DELETE", `/api/contributions/${id}`, null),
    putContributionPerson: (id: string, personId: string) => request("PUT", `/api/contributions/${id}/people/${personId}`, contributionSchema),
    removeContributionPerson: (id: string, personId: string) => request("DELETE", `/api/contributions/${id}/people/${personId}`, null),
    /** "Este ticket depende de `ticketId`" (ADR 0037); repetir é sucesso. */
    addTicketDependency: (id: string, ticketId: string) =>
      request("POST", `${ticket(id)}/dependencies`, ticketDetailSchema, { ticketId }),
    removeTicketDependency: (id: string, ticketId: string) =>
      request("DELETE", `${ticket(id)}/dependencies/${ticketId}`, null),
    /** `scopeId`: o ticket em que a procura vai começar (ADR 0033, ADR 0034), ou `null` para o projeto inteiro; a IA recebe os títulos dos tickets com filhos dali. */
    openConversation: (projectId: string, body: { message: string; scopeId?: string | null }) =>
      request("POST", `${project(projectId)}/ticket-conversations`, conversationDetailSchema, body),
    sendConversationMessage: (id: string, body: { message: string; scopeId?: string | null }) =>
      request("POST", `${conversation(id)}/messages`, conversationDetailSchema, body),
    updateConversationDraft: (id: string, body: ConversationDraftBody) =>
      request("PATCH", `${conversation(id)}/draft`, conversationDetailSchema, body),
    getConversationPreview: (id: string) => request("GET", `${conversation(id)}/preview`, draftPreviewSchema),
    /**
     * `scopeId`: procura só dentro desse ticket (ADR 0031, ADR 0034); `null`, o projeto inteiro (sem isso, numa thread nascida no chat de um
     * ticket, o servidor parte desse ticket); ausente, o servidor decide. `startId`: o ramo que a pessoa
     * confirmou por último na pergunta (ADR 0054, adendo); a procura parte dele. Campo ausente não vai no corpo.
     */
    findPlacement: (id: string, scopeId?: string | null, startId?: string) =>
      request("POST", `${conversation(id)}/placement`, placementOutcomeSchema, scopeId === undefined && startId === undefined ? undefined : { ...(scopeId === undefined ? {} : { scopeId }), ...(startId === undefined ? {} : { startId }) }),
    /** A decisão guardada da última procura (`null` se ainda não houve): a thread reaberta remonta a pergunta por ela. */
    getPlacementDecision: (id: string) => request("GET", `${conversation(id)}/placement-decision`, placementDecisionSchema),
    getElaboration: (id: string) => request("POST", `${conversation(id)}/elaboration`, elaborationOutcomeSchema),
    createTicketFromConversation: (id: string, body: { parentId: string | null; placedBy: PlacedBy; group?: NewGroup } & ElaborationChoice) =>
      request("POST", `${conversation(id)}/ticket`, createdFromConversationSchema, body),
    listConversations: (projectId: string) =>
      request("GET", `/api/ticket-conversations?projectId=${encodeURIComponent(projectId)}`, z.array(conversationSummarySchema)),
    getConversation: (id: string) => request("GET", conversation(id), conversationDetailSchema),
    removeConversation: (id: string) => request("DELETE", conversation(id), null),
    importTickets: (projectId: string, body: ImportTicketsBody) =>
      request("POST", `${project(projectId)}/tickets/import`, z.array(ticketSummarySchema), body),

    getGithubInstallation: () =>
      request("GET", "/api/github/installation", z.object({ installation: githubInstallationSchema.nullable() })),
    connectGithub: () => request("POST", "/api/github/connect", z.object({ url: z.string() })),
    completeGithubConnection: (body: CompleteGithubBody) =>
      request("POST", "/api/github/connect/complete", z.object({ installation: githubInstallationSchema }), body),
    disconnectGithub: () => request("DELETE", "/api/github/installation", null),
    listGithubRepositories: () => request("GET", "/api/github/repositories", z.array(githubRepositorySchema)),
    listProjectRepositories: (projectId: string) =>
      request("GET", `${project(projectId)}/repositories`, z.array(projectRepositorySchema)),
    linkProjectRepository: (projectId: string, body: { repoId: number }) =>
      request("POST", `${project(projectId)}/repositories`, projectRepositorySchema, body),
    unlinkProjectRepository: (projectId: string, repositoryId: string) =>
      request("DELETE", `${project(projectId)}/repositories/${repositoryId}`, null),
    refreshProjectCode: (projectId: string) => request("POST", `${project(projectId)}/code/refresh`, codeRefreshSchema),
    getTicketCode: (id: string) => request("GET", `${ticket(id)}/code`, ticketCodeSchema),

    /** Atividade do ticket (ADR 0040), da mais recente para a mais antiga; `before` é o cursor que a página anterior devolveu. */
    /** O Linear (ADR 0060): a chave é pessoal e nunca volta; o vínculo do projeto com um time é permanente. */
    getLinearConnection: () => request("GET", "/api/linear/connection", linearConnectionSchema),
    connectLinear: (apiKey: string) => request("PUT", "/api/linear/connection", linearConnectionSchema, { apiKey }),
    disconnectLinear: () => request("DELETE", "/api/linear/connection", null),
    listLinearTeams: () => request("GET", "/api/linear/teams", z.array(linearTeamSchema)),
    getProjectLinear: (projectId: string) => request("GET", `${project(projectId)}/linear`, projectLinearSchema),
    openLinearRun: (projectId: string, body: OpenLinearRunBody) => request("POST", `${project(projectId)}/linear/runs`, linearRunSchema, body),
    getCurrentLinearRun: (projectId: string) => request("GET", `${project(projectId)}/linear/runs/current`, currentLinearRunSchema),
    getLinearPreview: (projectId: string) => request("GET", `${project(projectId)}/linear/preview`, linearPreviewSchema),
    stepLinearRun: (projectId: string, runId: string) => request("POST", `${project(projectId)}/linear/runs/${runId}/step`, linearRunSchema),
    /** Desiste da rodada aberta: o que já foi importado fica e dá para começar outra (ADR 0060). */
    abandonLinearRun: (projectId: string, runId: string) => request("POST", `${project(projectId)}/linear/runs/${runId}/abandon`, linearRunSchema),
    /** Procurar o lugar das raízes da importação (ADR 0060, seção 6): a situação, a rodada em passos e a lista "a conferir". */
    getLinearCategorize: (projectId: string) => request("GET", `${project(projectId)}/linear/categorize`, categorizeOverviewSchema),
    openLinearCategorize: (projectId: string) => request("POST", `${project(projectId)}/linear/categorize`, categorizeViewSchema),
    stepLinearCategorize: (projectId: string, runId: string) => request("POST", `${project(projectId)}/linear/categorize/${runId}/step`, categorizeViewSchema),
    abandonLinearCategorize: (projectId: string, runId: string) => request("POST", `${project(projectId)}/linear/categorize/${runId}/abandon`, categorizeViewSchema),
    listLinearToCheck: (projectId: string) => request("GET", `${project(projectId)}/linear/categorize/to-check`, toCheckSchema),
    dismissLinearToCheck: (projectId: string, ticketId: string) => request("POST", `${project(projectId)}/linear/categorize/to-check/${ticketId}/dismiss`, z.object({ ok: z.literal(true) })),
    linkProjectToLinear: (projectId: string, body: LinkProjectToLinearBody) => request("POST", `${project(projectId)}/linear`, projectLinearSchema, body),

    ticketActivity: (id: string, query: { before?: string; limit?: number; contribution?: string } = {}, options: { signal?: AbortSignal } = {}) => {
      const params = new URLSearchParams();
      if (query.contribution !== undefined) params.set("contribution", query.contribution);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.before !== undefined) params.set("before", query.before);
      const text = params.toString();
      return request("GET", `${ticket(id)}/activity${text === "" ? "" : `?${text}`}`, activityPageSchema, undefined, options.signal);
    },

    /** Comentários do ticket (ADR 0040, fatia 2): a resposta é a entrada de atividade do comentário. */
    createTicketComment: (id: string, body: { body: string; contributionId?: string }) => request("POST", `${ticket(id)}/comments`, commentEntrySchema, body),
    updateComment: (id: string, body: { body: string }) => request("PATCH", `/api/comments/${id}`, commentEntrySchema, body),
    removeComment: (id: string) => request("DELETE", `/api/comments/${id}`, null),

    /** A árvore de conversas da pessoa (ADR 0055): o chat geral, depois os tickets, cada um com as threads dentro. */
    listConversationTree: (options: { signal?: AbortSignal } = {}) => request("GET", "/api/conversations", conversationTreeSchema, undefined, options.signal),
    /** Lê uma conversa por id (principal, chat geral ou thread). */
    getConversationView: (id: string, query: { limit?: number; before?: string } = {}, options: { signal?: AbortSignal } = {}) =>
      request("GET", `/api/conversations/${id}${chatQuery(query)}`, conversationViewSchema, undefined, options.signal),
    /** Lê a conversa da pessoa num ticket, sem criar nada; `conversation: null` se ela ainda não tem. */
    getTicketConversationView: (ticketId: string, query: { limit?: number; before?: string } = {}, options: { signal?: AbortSignal } = {}) =>
      request("GET", `${ticket(ticketId)}/conversation${chatQuery(query)}`, conversationViewSchema, undefined, options.signal),
    /** Abre (ou obtém) a conversa principal da pessoa no ticket: só no primeiro envio. */
    openTicketConversation: (ticketId: string) => request("POST", `${ticket(ticketId)}/conversation`, openedSchema),
    /** Abre (ou obtém) o chat geral da pessoa: só no primeiro envio. */
    openGeneralConversation: () => request("POST", "/api/conversations/general", openedSchema),
    /** Sem `mentions`: fala com o assistente (principal) ou responde (thread); com elas: abre uma thread dentro da conversa. */
    sendChatMessage: (id: string, body: ChatWriteBody, options: { signal?: AbortSignal } = {}) =>
      request("POST", `/api/conversations/${id}/messages`, sendResultSchema, body, options.signal),
    /** Só quem abriu a thread inclui pessoas nela. */
    addConversationParticipants: (id: string, personIds: string[]) => request("POST", `/api/conversations/${id}/participants`, participantsResultSchema, { personIds }),
    /** `upTo`: o `cursor` da mensagem mais nova vista; sem ele, tudo o que a pessoa pode ler. */
    /** Fecha a conversa (e as de dentro) só para quem pede; `closedIds` serve ao "Desfazer". */
    closeConversation: (id: string) => request("POST", `/api/conversations/${id}/close`, closedResultSchema),
    reopenConversation: (id: string) => request("POST", `/api/conversations/${id}/reopen`, reopenedResultSchema),
    /** As conversas que a pessoa fechou e continuam fechadas, planas, da mais recente para a mais antiga. */
    listClosedConversations: (options: { signal?: AbortSignal } = {}) => request("GET", "/api/conversations/closed", conversationTreeSchema, undefined, options.signal),
    markConversationRead: (id: string, body: { upTo?: string } = {}) => request("POST", `/api/conversations/${id}/read`, readResultSchema, body),
    /** Apaga só a conversa da pessoa com o assistente (a principal); as threads ficam. */
    clearConversationMessages: (id: string) => request("DELETE", `/api/conversations/${id}/messages`, null),

    getTicketSummary: (id: string) => request("GET", `${ticket(id)}/summary`, ticketSummaryTextSchema),
    putTicketSummary: (id: string, body: { text: string }) => request("PUT", `${ticket(id)}/summary`, ticketSummaryTextSchema, body),
    regenerateTicketSummary: (id: string) => request("POST", `${ticket(id)}/summary/regenerate`, ticketSummaryTextSchema),
    /** Pede à IA um trecho em markdown para a descrição (ADR 0036). Não grava nada; `description` é o texto atual do editor. */
    draftTicketDescription: (id: string, body: { request: string; description: string }, options: { signal?: AbortSignal } = {}) =>
      request("POST", `${ticket(id)}/description/draft`, descriptionDraftSchema, body, options.signal),

    /** O aceite da organização para a IA (ADR 0039): qualquer membro lê; só administrador aceita e retira. */
    getAiConsent: () => request("GET", "/api/organization/ai-consent", aiConsentSchema),
    acceptAiConsent: (kind: AiConsentKind, version: string) => request("PUT", `/api/organization/ai-consent/${kind}`, aiConsentSchema, { version }),
    withdrawAiConsent: (kind: AiConsentKind) => request("DELETE", `/api/organization/ai-consent/${kind}`, aiConsentSchema),

    /** A chave "Permitir acesso por MCP" (ADR 0038); só administrador. */
    setMcpEnabled: (mcpEnabled: boolean) => request("PATCH", "/api/organization", mcpStateSchema, { mcpEnabled }),
    /** A chave "Permitir escrita por MCP" (ADR 0043); só administrador. */
    setMcpWriteEnabled: (mcpWriteEnabled: boolean) => request("PATCH", "/api/organization/mcp-write", mcpStateSchema, { mcpWriteEnabled }),
    setMcpPeopleEnabled: (mcpPeopleEnabled: boolean) => request("PATCH", "/api/organization/mcp-people", mcpStateSchema, { mcpPeopleEnabled }),
    /** Encerra o marcador de trabalho pela IA do ticket (ADR 0043); a resposta é o detalhe. */
    endAgentWork: (id: string) => request("DELETE", `${ticket(id)}/agent-work`, ticketDetailSchema),
    /** Cria um token de acesso por MCP para um projeto (ADR 0038); a resposta é a única vez em que o token inteiro aparece. */
    createAccessToken: (body: CreateAccessTokenBody) => request("POST", "/api/access-tokens", createdAccessTokenSchema, body),
    listAccessTokens: () => request("GET", "/api/access-tokens", z.array(accessTokenSchema)),
    /** Todos os tokens da organização, com a pessoa de cada um; só administrador. */
    listOrganizationAccessTokens: () => request("GET", "/api/access-tokens/organization", z.array(organizationAccessTokenSchema)),
    revokeAccessToken: (id: string) => request("DELETE", `/api/access-tokens/${id}`, null),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** O GitHub está ligado nesta API? Uma API antiga não manda o campo: conta como desligado. */
export const githubEnabled = (me: Me): boolean => me.github?.enabled === true;

/** A IA está ligada nesta API? Uma API antiga não manda o campo: conta como desligada. */
export const assistantEnabled = (me: Me): boolean => me.assistant?.enabled === true;

/** O servidor tem a IA configurada mas a organização ainda não aceitou (ADR 0039): as funções de IA ficam desligadas. */
export const assistantNeedsConsent = (me: Me): boolean => me.assistant?.configured === true && me.assistant.consent === false;

/** A seção "IA e privacidade" aparece: a IA está configurada neste servidor. Uma API antiga não manda o campo: não aparece. */
export const aiPrivacyAvailable = (me: Me): boolean => me.assistant?.configured === true;

/** A seção de MCP aparece nesta API? Uma API antiga não manda o campo: conta como ausente. */
export const mcpAvailable = (me: Me): boolean => me.mcp !== undefined;
