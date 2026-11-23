import { NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { TicketStatus } from "@treepm/domain";
import { z } from "zod";
import type { Principal } from "../access/principal.js";
import type { ProjectQueryService } from "../query/project-query.service.js";
import type { QueryOverview, QueryTicket, QueryTicketList, QueryTicketPage, QueryTicketSummary } from "../query/query.schema.js";
import { ideaStageSchema, ticketStatusSchema } from "../tickets/tickets.schema.js";

/**
 * As quatro ferramentas do servidor MCP (ADR 0038), só de leitura, sobre a camada de consulta (ADR 0037). Tudo o que o
 * cliente vê (nomes, descrições, campos, mensagens de erro) é em inglês: o cliente é de qualquer pessoa. A saída leva a
 * chave real do ticket e nunca id interno, dado de pessoa nem data.
 */

/** Nenhum resultado passa deste tamanho em JSON, em caracteres (ADR 0038: 25.000 tokens estimados, com folga). */
export const MAX_RESULT_CHARS = 80_000;

/** Entrada que não vale: vira resultado de ferramenta com erro (`isError`), com uma frase curta, nunca uma falha da requisição. */
export class ToolInputError extends Error {}

const STATUSES = "todo, in_progress, in_review, done, cancelled";

const KEY_SHAPE = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})$/;
const keyField = z
  .string()
  .trim()
  .max(32, "Ticket key is too long.")
  .regex(/^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$/, "Ticket key must look like PROJ-123.");

export const searchTicketsInput = z.strictObject({
  query: z.string().trim().min(1, "Query must not be empty.").max(200, "Query is too long (200 characters at most).").describe("Text to look for in ticket titles, descriptions and keys."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (default 8, at most 50)."),
});
export const getTicketInput = z.strictObject({
  key: keyField.describe("Ticket key of this project, for example PROJ-47."),
});
export const listTicketsInput = z.strictObject({
  status: z.array(ticketStatusSchema).max(5).optional().describe(`Only tickets in these statuses (any of: ${STATUSES}). Omit for all statuses.`),
  under: keyField.optional().describe("Only the descendants of this ticket key, at every level (the ticket itself is not included)."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, at most 200)."),
  after: keyField.optional().describe("Ticket key returned as `after` by the previous page; returns only tickets that come after it."),
});
export const projectOverviewInput = z.strictObject({});

const ideaSchema = z
  .union([z.strictObject({ kind: z.literal("root"), stage: ideaStageSchema }), z.strictObject({ kind: z.literal("inside"), root: z.string() })])
  .nullable()
  .describe("null for ordinary work. An idea is not accepted work yet: `root` is the idea itself (with its stage), `inside` is a ticket that is part of an idea (`root` is the key of the idea).");
const agentWorkSchema = z.strictObject({ until: z.string() }).nullable().describe("Set while an agent is marked as working on this ticket right now (`until` is when the mark expires); null otherwise.");

const summarySchema = z.strictObject({
  key: z.string().describe("Ticket key, for example PROJ-47."),
  title: z.string(),
  excerpt: z.string().describe("Start of the description."),
  status: ticketStatusSchema,
  parent: z.string().nullable().describe("Key of the parent ticket, or null for a top-level ticket."),
  idea: ideaSchema,
  agentWork: agentWorkSchema,
  priority: z.number().int().describe("The ticket's own priority: an integer from -999 to 999, 0 by default. A higher number comes first; negative goes last."),
  effective_priority: z.number().int().describe("The priority that counts: `priority` when it is not 0, otherwise the one of the nearest ancestor whose priority is not 0, otherwise 0."),
});
const listSchema = z.strictObject({
  tickets: z.array(summarySchema),
  truncated: z.boolean().describe("True when there were more tickets than fit in the result."),
});
const directionsSchema = z.strictObject({ outgoing: listSchema, incoming: listSchema });
const progressSchema = z.strictObject({ done: z.number().int(), total: z.number().int(), excluded: z.number().int(), ideas: z.number().int() });

export const searchTicketsOutput = listSchema;
export const getTicketOutput = z.strictObject({
  key: z.string(),
  title: z.string(),
  status: ticketStatusSchema,
  idea: ideaSchema,
  agentWork: agentWorkSchema,
  priority: summarySchema.shape.priority,
  effective_priority: summarySchema.shape.effective_priority,
  description: z.string().describe("Full description, never cut."),
  parent: z.string().nullable().describe("Key of the parent ticket (the ticket this one is part of), or null."),
  path: z.array(summarySchema).describe("From the top-level ancestor down to the parent; empty for a top-level ticket."),
  children: listSchema.describe("Tickets that are part of this one."),
  relations: z.strictObject({
    mentions: directionsSchema.describe("`outgoing`: tickets this one mentions in its text; `incoming`: tickets that mention this one."),
    depends_on: directionsSchema.describe("`outgoing`: tickets that must be finished before this one; `incoming`: tickets waiting for this one."),
  }),
});
export const listTicketsOutput = listSchema.extend({ after: z.string().nullable().describe("Pass as `after` to get the next page; null when there is no more.") });
export const projectOverviewOutput = z.strictObject({
  project: z.string().describe("Project key."),
  total: z.number().int().describe("Number of tickets that are work (ideas are not counted)."),
  ideas: z.strictObject({ new: z.number().int(), refining: z.number().int(), ready: z.number().int(), discarded: z.number().int() }).describe("Idea roots per stage. An idea is not accepted work yet."),
  by_status: z.strictObject({ todo: z.number().int(), in_progress: z.number().int(), in_review: z.number().int(), done: z.number().int(), cancelled: z.number().int() }),
  top: z.strictObject({
    tickets: z.array(summarySchema.extend({ progress: progressSchema.nullable().describe("Leaf tickets done / total below this ticket; null when it has no children.") })),
    truncated: z.boolean(),
  }),
});

type Summary = z.infer<typeof summarySchema>;
type TicketList = z.infer<typeof listSchema>;

const MEANING =
  "Tickets form a tree: the parent is the ticket a ticket is part of. " +
  "An idea is not accepted work yet: `idea` says whether a ticket is the root of an idea or inside one. " +
  "Priority: `priority` is the ticket's own number (-999 to 999, 0 by default, higher comes first) and `effective_priority` the one that counts, inherited from the nearest ancestor with a non-zero priority. " +
  "Relations: `mentions` means one ticket cites the other in its text; `depends_on` means the first ticket needs the other to be finished before it. " +
  `Statuses: ${STATUSES}.`;

export const TOOL_DEFINITIONS = {
  search_tickets: {
    title: "Search tickets",
    description: `Search the tickets of this project by text (title, description and key). Returns summaries (key, title, excerpt, status, parent key) of the best matches. Use it to find where a subject lives. ${MEANING}`,
    inputSchema: searchTicketsInput,
    outputSchema: searchTicketsOutput,
  },
  get_ticket: {
    title: "Get a ticket",
    description: `Read one ticket in full: complete description, status, parent, the path from the top of the tree down to the parent, children and the relations in both directions. ${MEANING} For \`mentions\`, \`outgoing\` lists tickets this one cites and \`incoming\` lists tickets that cite it. For \`depends_on\`, \`outgoing\` lists tickets that must be finished before this one and \`incoming\` lists tickets waiting for this one.`,
    inputSchema: getTicketInput,
    outputSchema: getTicketOutput,
  },
  list_tickets: {
    title: "List tickets",
    description: `List ticket summaries in key order, optionally filtered by status and by branch (\`under\`). When \`truncated\` is true there are more: ask for the next page with \`after\`. ${MEANING}`,
    inputSchema: listTicketsInput,
    outputSchema: listTicketsOutput,
  },
  get_project_overview: {
    title: "Get the project overview",
    description: `Overview of the project: number of tickets in total and per status, and the top-level tickets of the tree with the progress of each. ${MEANING}`,
    inputSchema: projectOverviewInput,
    outputSchema: projectOverviewOutput,
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export type ToolContext = {
  principal: Principal;
  project: { id: string; key: string };
};

/** Abre uma transação curta com a identidade que o token resolveu (cada execução abre a sua). */
export type RunInTenant = <T>(principal: Principal, fn: (tx: TenantClient) => Promise<T>) => Promise<T>;

type Page = { tickets: Summary[]; truncated: boolean };

/**
 * Executa as ferramentas. Recebe a identidade e o projeto já resolvidos: não conhece o token. Cada chamada abre a sua
 * transação (`RunInTenant`), então as permissões são conferidas de novo a cada execução.
 */
export class ProjectTools {
  constructor(
    private readonly run: RunInTenant,
    private readonly query: ProjectQueryService,
    private readonly context: ToolContext,
  ) {}

  private get projectKey(): string {
    return this.context.project.key;
  }

  async searchTickets(input: z.infer<typeof searchTicketsInput>): Promise<z.infer<typeof searchTicketsOutput>> {
    const found = await this.read((tx, principal) => this.query.search(tx, principal, this.context.project.id, input.query, input.limit === undefined ? {} : { limit: input.limit }), (tx, list) => this.page(tx, list));
    return fit(found, (result) => [result]);
  }

  async getTicket(input: z.infer<typeof getTicketInput>): Promise<z.infer<typeof getTicketOutput>> {
    const number = this.ticketNumber(input.key);
    return this.run(this.context.principal, (tx) => this.ticketIn(tx, this.context.principal, number));
  }

  /** O ticket como `get_ticket` o devolve, lido na transação que já está aberta (a escrita responde com isto, sem uma segunda transação). */
  async ticketIn(tx: TenantClient, principal: Principal, number: number): Promise<z.infer<typeof getTicketOutput>> {
    const found = await this.query.ticket(tx, principal, this.context.project.id, number).catch((error: unknown) => {
      if (error instanceof NotFoundException && error.message === "Ticket não encontrado.") throw new ToolInputError(`Ticket ${this.projectKey}-${number} does not exist in this project.`);
      throw error;
    });
    const ticket = await this.reduceTicket(tx, found);
    return fit(ticket, (result) => [result.children, result.relations.mentions.outgoing, result.relations.mentions.incoming, result.relations.depends_on.outgoing, result.relations.depends_on.incoming]);
  }

  async listTickets(input: z.infer<typeof listTicketsInput>): Promise<z.infer<typeof listTicketsOutput>> {
    const under = input.under === undefined ? undefined : this.ticketNumber(input.under);
    const after = input.after === undefined ? undefined : this.ticketNumber(input.after);
    const page = await this.read(
      (tx, principal) =>
        this.query
          .list(tx, principal, this.context.project.id, {
            ...(input.status ? { status: input.status as TicketStatus[] } : {}),
            ...(under !== undefined ? { under } : {}),
            ...(after !== undefined ? { after } : {}),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          })
          .catch((error: unknown) => {
            if (error instanceof NotFoundException && error.message === "Ticket não encontrado.") throw new ToolInputError(`Ticket ${this.projectKey}-${under ?? 0} does not exist in this project.`);
            throw error;
          }),
      async (tx, list: QueryTicketPage) => ({ ...(await this.page(tx, list)), after: list.after === null ? null : `${this.projectKey}-${list.after}` }),
    );
    const before = page.tickets.length;
    const result = fit(page, (value) => [value]);
    // Cortada por tamanho: a página seguinte recomeça logo depois do último ticket que coube.
    return result.tickets.length < before ? { ...result, after: result.tickets.at(-1)?.key ?? null } : result;
  }

  async getProjectOverview(): Promise<z.infer<typeof projectOverviewOutput>> {
    const overview = await this.read(
      (tx, principal) => this.query.overview(tx, principal, this.context.project.id),
      async (tx, value: QueryOverview) => {
        const numbers = await this.parentKeys(tx, value.top.tickets);
        return {
          project: value.projectKey,
          total: value.total,
          by_status: value.byStatus,
          ideas: value.ideas,
          top: {
            tickets: value.top.tickets.map((ticket) => ({ ...this.summary(ticket, numbers), progress: ticket.progress })),
            truncated: value.top.truncated,
          },
        };
      },
    );
    return fit(overview, (value) => [value.top]);
  }

  /** Lê e converte dentro da mesma transação (a conversão pode precisar de uma consulta a mais). */
  private read<A, B>(load: (tx: TenantClient, principal: Principal) => Promise<A>, convert: (tx: TenantClient, value: A) => Promise<B>): Promise<B> {
    return this.run(this.context.principal, async (tx) => convert(tx, await load(tx, this.context.principal)));
  }

  /** `PROJ-12` → 12, só se for deste projeto. O único analisador de chave, da leitura e da escrita (estrito: sem zeros à esquerda). */
  ticketNumber(key: string): number {
    const match = KEY_SHAPE.exec(key.trim().toUpperCase());
    if (!match) throw new ToolInputError("Ticket key must look like PROJ-123.");
    if (match[1] !== this.projectKey) throw new ToolInputError(`This server only serves project ${this.projectKey}; use keys like ${this.projectKey}-123.`);
    return Number(match[2]);
  }

  private async page(tx: TenantClient, list: QueryTicketList | QueryTicketPage): Promise<Page> {
    const numbers = await this.parentKeys(tx, list.tickets);
    return { tickets: list.tickets.map((ticket) => this.summary(ticket, numbers)), truncated: list.truncated };
  }

  private async reduceTicket(tx: TenantClient, ticket: QueryTicket): Promise<z.infer<typeof getTicketOutput>> {
    const { relations } = ticket;
    const lists = [ticket.children, relations.mentions.outgoing, relations.mentions.incoming, relations.dependsOn.outgoing, relations.dependsOn.incoming];
    const keys = await this.parentKeys(tx, [ticket, ...ticket.path, ...lists.flatMap((list) => list.tickets)]);
    const reduce = (list: QueryTicketList): TicketList => ({ tickets: list.tickets.map((entry) => this.summary(entry, keys)), truncated: list.truncated });
    const directions = (pair: { outgoing: QueryTicketList; incoming: QueryTicketList }) => ({ outgoing: reduce(pair.outgoing), incoming: reduce(pair.incoming) });
    const self = this.summary(ticket, keys);
    return {
      key: self.key,
      title: self.title,
      status: self.status,
      idea: self.idea,
      agentWork: self.agentWork,
      priority: self.priority,
      effective_priority: self.effective_priority,
      description: ticket.description,
      parent: self.parent,
      path: ticket.path.map((entry) => this.summary(entry, keys)),
      children: reduce(ticket.children),
      relations: { mentions: directions(relations.mentions), depends_on: directions(relations.dependsOn) },
    };
  }

  /** Chave do pai de cada resumo: os que já estão no resultado, mais uma consulta para os que faltam. */
  private async parentKeys(tx: TenantClient, summaries: readonly QueryTicketSummary[]): Promise<Map<string, string>> {
    const byId = new Map(summaries.map((entry) => [entry.id, entry.key]));
    const missing = [...new Set(summaries.map((entry) => entry.parentId).filter((id): id is string => id !== null && !byId.has(id)))];
    if (missing.length > 0) {
      for (const row of await tx.ticket.findMany({ where: { projectId: this.context.project.id, id: { in: missing } }, select: { id: true, number: true } })) {
        byId.set(row.id, `${this.projectKey}-${row.number}`);
      }
    }
    return byId;
  }

  private summary(entry: QueryTicketSummary, keys: ReadonlyMap<string, string>): Summary {
    return {
      key: entry.key,
      title: entry.title,
      excerpt: entry.descriptionExcerpt,
      status: entry.status,
      parent: entry.parentId === null ? null : (keys.get(entry.parentId) ?? null),
      idea: entry.idea === null ? null : entry.idea.kind === "root" ? { kind: "root", stage: entry.idea.stage } : { kind: "inside", root: `${this.projectKey}-${entry.idea.rootNumber}` },
      agentWork: entry.agentWork,
      priority: entry.priority,
      effective_priority: entry.effectivePriority,
    };
  }
}

type Cuttable = { tickets: unknown[]; truncated: boolean };

/**
 * Garante o teto de `MAX_RESULT_CHARS`: enquanto o JSON passa dele, tira tickets do fim da MAIOR lista (as demais
 * ficam) e marca `truncated`. Só entram em `lists` as listas que podem ser cortadas: a descrição e o caminho até a
 * raiz (`path`) NUNCA são cortados. Por isso o resultado pode passar de `MAX_RESULT_CHARS` quando o excesso não está
 * em lista cortável (uma árvore muito funda de títulos longos); a função sempre termina: para quando não há mais
 * ticket a tirar das listas.
 */
export function fit<T>(result: T, lists: (value: T) => Cuttable[]): T {
  const size = (): number => JSON.stringify(result).length;
  for (let current = size(); current > MAX_RESULT_CHARS; current = size()) {
    const largest = lists(result)
      .filter((list) => list.tickets.length > 0)
      .sort((a, b) => b.tickets.length - a.tickets.length)[0];
    if (!largest) break;
    // Tira em lotes enquanto o excesso é grande e de um em um perto do teto.
    const average = current / Math.max(1, lists(result).reduce((sum, list) => sum + list.tickets.length, 0) + 1);
    const batch = Math.max(1, Math.floor((current - MAX_RESULT_CHARS) / (2 * average)));
    largest.tickets.splice(Math.max(0, largest.tickets.length - batch), batch);
    largest.truncated = true;
  }
  return result;
}
