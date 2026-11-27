import { NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { isOverdue, safeLinearKey, safeLinearUrl } from "@treepm/domain";
import type { TicketStatus } from "@treepm/domain";
import { z } from "zod";
import type { Principal } from "../access/principal.js";
import type { ProjectQueryService } from "../query/project-query.service.js";
import type { QueryDependencyList, QueryOverview, QueryTicket, QueryTicketList, QueryTicketPage, QueryTicketSummary } from "../query/query.schema.js";
import type { QueueTicket } from "../query/project-query.service.js";
import { listProjectLabels } from "../tickets/labels.service.js";
import { ideaStageSchema, ticketStatusSchema } from "../tickets/tickets.schema.js";
import { labelOut } from "./mcp-text.js";
import { PERSON_NAME_SELECT, mcpPersonRef } from "./person-name.js";
import type { PersonNameSource } from "./person-name.js";

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
export const workQueueInput = z.strictObject({
  under: keyField.optional().describe("Only the queue inside this ticket's branch: the ticket itself and its descendants, at every level."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of tickets returned (default 20, at most 50). `total` always counts the whole queue."),
});

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
  dueDate: z.string().nullable().describe("The due date, a calendar day YYYY-MM-DD with no time and no time zone; null when the ticket has none."),
  overdue: z.boolean().describe("True when the ticket has a due date before today and is todo, in_progress or in_review (done and cancelled are never overdue). Today is the current day in UTC."),
  labels: z.array(z.string()).describe("The names of the ticket's labels, in name order; empty when it has none."),
});
const listSchema = z.strictObject({
  tickets: z.array(summarySchema),
  truncated: z.boolean().describe("True when there were more tickets than fit in the result."),
});
const directionsSchema = z.strictObject({ outgoing: listSchema, incoming: listSchema });
const progressSchema = z.strictObject({ done: z.number().int(), total: z.number().int(), excluded: z.number().int(), ideas: z.number().int() });

export const searchTicketsOutput = listSchema;
const queueTicketSchema = summarySchema.extend({ path: z.array(z.strictObject({ key: z.string(), title: z.string() })).describe("From the top-level ancestor down to the parent: key and title of each; empty for a top-level ticket.") });
export const workQueueOutput = z.strictObject({
  tickets: z.array(queueTicketSchema).describe("The queue in working order: the best next ticket first."),
  total: z.number().int().describe("How many tickets are in the whole queue (more than `tickets` when `truncated`)."),
  truncated: z.boolean().describe("True when the queue has more tickets than `limit`."),
  empty_reason: z
    .enum(["all_waiting", "all_others", "none"])
    .nullable()
    .describe("Null when the queue has tickets. When it is empty: all_waiting (everything else waits for another open ticket to start), all_others (everything ready is assigned to other people) or none (nothing to do here, or mixed reasons)."),
});
/** Uma dependência (ADR 0068): o resumo do outro ticket e o tipo. */
const dependencyListSchema = z.strictObject({
  tickets: z.array(summarySchema.extend({ need: z.enum(["start", "deliver"]).describe("start: the work waits for the other ticket to start; deliver: the work can start, but cannot be done before the other ticket.") })),
  truncated: listSchema.shape.truncated,
});
const dependencyDirectionsSchema = z.strictObject({ outgoing: dependencyListSchema, incoming: dependencyListSchema });
export const getTicketOutput = z.strictObject({
  key: z.string(),
  title: z.string(),
  status: ticketStatusSchema,
  blocked: z.boolean().describe("True when someone marked an impediment on this open ticket (see mark_impediment): something is in the way and needs action. Waiting for another ticket is not blocked."),
  place: z
    .enum(["free", "next", "waiting"])
    .nullable()
    .describe("Place in the queue, for an open ticket without children that is not an idea: free (every dependency to start is finished), next (it waits only for free tickets) or waiting (it waits for tickets that wait too). Null otherwise."),
  idea: ideaSchema,
  agentWork: agentWorkSchema,
  priority: summarySchema.shape.priority,
  effective_priority: summarySchema.shape.effective_priority,
  dueDate: summarySchema.shape.dueDate,
  overdue: summarySchema.shape.overdue,
  labels: summarySchema.shape.labels,
  description: z.string().describe("Full description, never cut."),
  parent: z.string().nullable().describe("Key of the parent ticket (the ticket this one is part of), or null."),
  path: z.array(summarySchema).describe("From the top-level ancestor down to the parent; empty for a top-level ticket."),
  children: listSchema.describe("Tickets that are part of this one."),
  relations: z.strictObject({
    mentions: directionsSchema.describe("`outgoing`: tickets this one mentions in its text; `incoming`: tickets that mention this one."),
    depends_on: dependencyDirectionsSchema.describe("`outgoing`: tickets this one depends on; `incoming`: tickets that depend on this one. Each with its need (start or deliver)."),
    related: listSchema.describe("Tickets related to this one (\"related to\", no direction). It comes from Linear and carries no rule: it does not block nor order work."),
  }),
  linear: z
    .strictObject({
      key: z.string().nullable().describe("The current Linear identifier, for example ENG-12; null when the ticket came from a Linear project (projects have no identifier)."),
      url: z.string().nullable().describe("Address of the issue or project in Linear."),
    })
    .nullable()
    .describe("Where the ticket came from, when it was imported from Linear; null otherwise."),
});
export const listTicketsOutput = listSchema.extend({ after: z.string().nullable().describe("Pass as `after` to get the next page; null when there is no more.") });
export const listLabelsInput = z.strictObject({});
export const listLabelsOutput = z.strictObject({
  labels: z
    .array(z.strictObject({ name: z.string(), color: z.string().describe("One of: gray, brown, orange, olive, cyan, indigo, violet, rose."), tickets: z.number().int().describe("How many tickets have this label.") }))
    .describe("The labels of this project, in name order."),
});
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

/** Alcance "pessoas e conversas" (ADR 0062): quem é responsável pelo ticket. Só nome e identificador, nunca e-mail, papel ou foto. */
const assigneeSchema = z.strictObject({ id: z.string().describe("Person id, to use with set_ticket_assignees."), name: z.string() });
const assigneesField = z.array(assigneeSchema).describe("The people assigned to the ticket, by name (empty when nobody is).");
export const listPeopleInput = z.strictObject({});
export const listPeopleOutput = z.strictObject({
  people: z
    .array(z.strictObject({ id: z.string(), name: z.string(), me: z.boolean().describe("True for the person who owns the token.") }))
    .describe("The people who can be assigned to tickets of this project: active people who can see the project, in name order."),
});

const summaryPeopleSchema = summarySchema.extend({ assignees: assigneesField });
const listPeopleSchema = z.strictObject({ tickets: z.array(summaryPeopleSchema), truncated: listSchema.shape.truncated });
const directionsPeopleSchema = z.strictObject({ outgoing: listPeopleSchema, incoming: listPeopleSchema });
const searchTicketsPeopleOutput = listPeopleSchema;
const listTicketsPeopleOutput = listPeopleSchema.extend({ after: listTicketsOutput.shape.after });
const workQueuePeopleOutput = workQueueOutput.extend({ tickets: z.array(summaryPeopleSchema.extend({ path: queueTicketSchema.shape.path })) });
const getTicketPeopleOutput = getTicketOutput.extend({
  assignees: assigneesField,
  path: z.array(summaryPeopleSchema),
  children: listPeopleSchema,
  relations: z.strictObject({
    mentions: directionsPeopleSchema,
    depends_on: z.strictObject({
      outgoing: z.strictObject({ tickets: z.array(summaryPeopleSchema.extend({ need: dependencyListSchema.shape.tickets.element.shape.need })), truncated: listSchema.shape.truncated }),
      incoming: z.strictObject({ tickets: z.array(summaryPeopleSchema.extend({ need: dependencyListSchema.shape.tickets.element.shape.need })), truncated: listSchema.shape.truncated }),
    }),
    related: listPeopleSchema,
  }),
});

type Assignee = z.infer<typeof assigneeSchema>;
/** Resumo de ticket; `assignees` só existe com o alcance de pessoas efetivo (sem ele a chave NÃO existe, nem vazia). */
type Summary = z.infer<typeof summarySchema> & { assignees?: Assignee[] };
type TicketList = { tickets: Summary[]; truncated: boolean };
type Directions = { outgoing: TicketList; incoming: TicketList };
type DependencyList = { tickets: (Summary & { need: "start" | "deliver" })[]; truncated: boolean };
export type TicketOutput = Omit<z.infer<typeof getTicketOutput>, "path" | "children" | "relations"> & {
  assignees?: Assignee[];
  path: Summary[];
  children: TicketList;
  relations: { mentions: Directions; depends_on: { outgoing: DependencyList; incoming: DependencyList }; related: TicketList };
};

const MEANING_LINEAR = "`linear` says where an imported ticket came from in Linear (its identifier and address).";

const MEANING =
  "Tickets form a tree: the parent is the ticket a ticket is part of. A ticket with child tickets (ideas do not count) has its status computed from them. " +
  "An idea is not accepted work yet: `idea` says whether a ticket is the root of an idea or inside one. " +
  "Priority: `priority` is the ticket's own number (-999 to 999, 0 by default, higher comes first) and `effective_priority` the one that counts, inherited from the nearest ancestor with a non-zero priority. " +
  "Due date: `dueDate` is a calendar day (YYYY-MM-DD, no time, no time zone) or null; `overdue` is true when that day is before today and the ticket is todo, in_progress or in_review and is not an idea (an idea is never overdue). Today is the current day in UTC, so near midnight it can differ from the TreePM screen, which uses the viewer's day. A ticket's due date is its own: it is not inherited from or imposed on its parent or children, and it does not change the order of the work queue. " +
  "Relations: `mentions` means one ticket cites the other in its text; `depends_on` means the first ticket needs the other to be finished, to start (need start) or only to be done (need deliver); `related` means \"related to\" (comes from Linear, no rule: it neither blocks nor orders work). " +
  "Labels: `labels` lists the names of the ticket's labels (labels belong to the project; list_labels lists them all). " +
  `Statuses: ${STATUSES}.`;

const definitions = (people: boolean) => ({
  search_tickets: {
    title: "Search tickets",
    description: `Search the tickets of this project by text (title, description and key). Returns summaries (key, title, excerpt, status, parent key) of the best matches. Use it to find where a subject lives. ${MEANING}`,
    inputSchema: searchTicketsInput,
    outputSchema: people ? searchTicketsPeopleOutput : searchTicketsOutput,
  },
  get_ticket: {
    title: "Get a ticket",
    description: `Read one ticket in full: complete description, status, parent, the path from the top of the tree down to the parent, children, the relations in both directions and, for a ticket imported from Linear, its Linear identifier and address. ${MEANING} ${MEANING_LINEAR} For \`mentions\`, \`outgoing\` lists tickets this one cites and \`incoming\` lists tickets that cite it. For \`depends_on\`, \`outgoing\` lists tickets this one depends on and \`incoming\` lists tickets that depend on this one, each with its need. \`blocked\` is an impediment someone marked; \`place\` is free, next or waiting. \`related\` is one list without direction: the same pair shows on both tickets.`,
    inputSchema: getTicketInput,
    outputSchema: people ? getTicketPeopleOutput : getTicketOutput,
  },
  list_tickets: {
    title: "List tickets",
    description: `List ticket summaries in key order, optionally filtered by status and by branch (\`under\`). When \`truncated\` is true there are more: ask for the next page with \`after\`. ${MEANING}`,
    inputSchema: listTicketsInput,
    outputSchema: people ? listTicketsPeopleOutput : listTicketsOutput,
  },
  get_work_queue: {
    title: "Get the work queue",
    description: `The "next to work on" queue of the person who owns the token, in this project (or inside one branch with \`under\`), in working order: highest effective priority first, then tickets assigned to that person before unassigned ones, then ticket number. A ticket is in the queue when it is todo, has no child ticket, is not an idea nor inside one, is free (every dependency to start is finished; dependencies to deliver do not count), is not blocked by a marked impediment, has no agent working mark, and is assigned to that person or to nobody. It is the same queue the TreePM screen shows. It is the queue of the person who owns the token, not of the whole team. Each call reads the whole project (do not call it in a loop; call it when you need to pick work, not per ticket). It does not change anything: it does not start a ticket, assign it or mark it as worked on; use update_ticket_status and set_agent_work for that. When the queue is empty, \`empty_reason\` says why. ${MEANING}`,
    inputSchema: workQueueInput,
    outputSchema: people ? workQueuePeopleOutput : workQueueOutput,
  },
  get_project_overview: {
    title: "Get the project overview",
    description: `Overview of the project: number of tickets in total and per status, and the top-level tickets of the tree with the progress of each. ${MEANING}`,
    inputSchema: projectOverviewInput,
    outputSchema: projectOverviewOutput,
  },
  list_labels: {
    title: "List the labels of the project",
    description: "The labels of this project, in name order: the name, the color and how many tickets have it. Use these names with addLabels and removeLabels of create_ticket and update_ticket (when the token can write). A ticket has at most 20 labels and a project at most 200.",
    inputSchema: listLabelsInput,
    outputSchema: listLabelsOutput,
  },
});

/** As cinco leituras de sempre; com o alcance de pessoas efetivo, as quatro de ticket passam a trazer `assignees`. */
export const TOOL_DEFINITIONS = definitions(false);
export const PEOPLE_TOOL_DEFINITIONS = definitions(true);

/** Só existe com o alcance de pessoas efetivo (ADR 0062). */
export const PEOPLE_READ_TOOL_DEFINITIONS = {
  list_people: {
    title: "List the people of the project",
    description:
      "The people who can be assigned to tickets of this project, by name: active people who can see the project, in name order, with `me: true` on the person who owns the token. Use their ids with set_ticket_assignees. No e-mail, role or photo is returned. It is the list the TreePM screen offers when you assign a ticket to someone. Names of people leave TreePM through this tool, because the organization turned on the \"People and conversations\" scope and this token has it.",
    inputSchema: listPeopleInput,
    outputSchema: listPeopleOutput,
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export type ToolContext = {
  principal: Principal;
  project: { id: string; key: string };
  /** O alcance "pessoas e conversas" EFETIVO (token com ele E chave da organização ligada agora). Ausente = desligado. */
  people?: boolean;
};

/** Quem diz quem pode ser responsável de um projeto (a regra de `TicketsService`, a mesma da tela). */
export type PeopleSource = {
  assignablePeople(tx: TenantClient, projectId: string): Promise<PersonNameSource[]>;
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
    private readonly peopleSource?: PeopleSource,
  ) {}

  /** O alcance de pessoas efetivo desta requisição (token com ele e chave da organização ligada). */
  private get withPeople(): boolean {
    return this.context.people === true;
  }

  private get projectKey(): string {
    return this.context.project.key;
  }

  async searchTickets(input: z.infer<typeof searchTicketsInput>): Promise<TicketList> {
    const found = await this.read((tx, principal) => this.query.search(tx, principal, this.context.project.id, input.query, input.limit === undefined ? {} : { limit: input.limit }), (tx, list) => this.page(tx, list));
    return fit(found, (result) => [result]);
  }

  async getTicket(input: z.infer<typeof getTicketInput>): Promise<TicketOutput> {
    const number = this.ticketNumber(input.key);
    return this.run(this.context.principal, (tx) => this.ticketIn(tx, this.context.principal, number));
  }

  /** O ticket como `get_ticket` o devolve, lido na transação que já está aberta (a escrita responde com isto, sem uma segunda transação). */
  async ticketIn(tx: TenantClient, principal: Principal, number: number): Promise<TicketOutput> {
    const found = await this.query.ticket(tx, principal, this.context.project.id, number).catch((error: unknown) => {
      if (error instanceof NotFoundException && error.message === "Ticket não encontrado.") throw new ToolInputError(`Ticket ${this.projectKey}-${number} does not exist in this project.`);
      throw error;
    });
    const ticket = await this.reduceTicket(tx, found);
    return fit(ticket, (result) => [result.children, result.relations.mentions.outgoing, result.relations.mentions.incoming, result.relations.depends_on.outgoing, result.relations.depends_on.incoming, result.relations.related]);
  }

  /** O resumo de um ticket (como nas listas), lido na transação já aberta: a escrita responde com isto. */
  async summaryIn(tx: TenantClient, principal: Principal, number: number): Promise<Summary> {
    const found = await this.query.ticket(tx, principal, this.context.project.id, number);
    return this.summary(found, await this.parentKeys(tx, [found, ...found.path]));
  }

  async listTickets(input: z.infer<typeof listTicketsInput>): Promise<TicketList & { after: string | null }> {
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

  async getWorkQueue(input: z.infer<typeof workQueueInput>): Promise<Omit<z.infer<typeof workQueueOutput>, "tickets"> & { tickets: (Summary & { path: { key: string; title: string }[] })[] }> {
    const under = input.under === undefined ? undefined : this.ticketNumber(input.under);
    const queue = await this.read(
      (tx, principal) =>
        this.query
          .workQueue(tx, principal, this.context.project.id, { ...(under === undefined ? {} : { under }), ...(input.limit === undefined ? {} : { limit: input.limit }) })
          .catch((error: unknown) => {
            if (error instanceof NotFoundException && error.message === "Ticket não encontrado.") throw new ToolInputError(`Ticket ${this.projectKey}-${under ?? 0} does not exist in this project.`);
            throw error;
          }),
      async (tx, value) => {
        const keys = await this.parentKeys(tx, value.tickets);
        const who = await this.assigneesOf(tx, value.tickets);
        return { tickets: value.tickets.map((ticket: QueueTicket) => ({ ...this.summary(ticket, keys, who), path: ticket.path })), total: value.total, truncated: value.truncated, empty_reason: value.emptyReason };
      },
    );
    return fit(queue, (value) => [value]);
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
    const who = await this.assigneesOf(tx, list.tickets);
    return { tickets: list.tickets.map((ticket) => this.summary(ticket, numbers, who)), truncated: list.truncated };
  }

  private async reduceTicket(tx: TenantClient, ticket: QueryTicket): Promise<TicketOutput> {
    const { relations } = ticket;
    const lists = [ticket.children, relations.mentions.outgoing, relations.mentions.incoming, relations.dependsOn.outgoing, relations.dependsOn.incoming, relations.related];
    const keys = await this.parentKeys(tx, [ticket, ...ticket.path, ...lists.flatMap((list) => list.tickets)]);
    const who = await this.assigneesOf(tx, [ticket, ...ticket.path, ...lists.flatMap((list) => list.tickets)]);
    const reduce = (list: QueryTicketList): TicketList => ({ tickets: list.tickets.map((entry) => this.summary(entry, keys, who)), truncated: list.truncated });
    const directions = (pair: { outgoing: QueryTicketList; incoming: QueryTicketList }) => ({ outgoing: reduce(pair.outgoing), incoming: reduce(pair.incoming) });
    const needs = (list: QueryDependencyList): DependencyList => ({ tickets: list.tickets.map((entry) => ({ ...this.summary(entry, keys, who), need: entry.need })), truncated: list.truncated });
    const self = this.summary(ticket, keys, who);
    return {
      key: self.key,
      title: self.title,
      status: self.status,
      // O impedimento só como fato (ADR 0068): o motivo não sai pelo MCP.
      blocked: ticket.blocked,
      place: ticket.place,
      idea: self.idea,
      agentWork: self.agentWork,
      priority: self.priority,
      effective_priority: self.effective_priority,
      dueDate: self.dueDate,
      overdue: self.overdue,
      labels: self.labels,
      description: ticket.description,
      parent: self.parent,
      path: ticket.path.map((entry) => this.summary(entry, keys, who)),
      children: reduce(ticket.children),
      // `related` (ADR 0061): só os tickets, como as outras listas; a origem no Linear (ids da relação e das issues) nunca sai daqui.
      relations: { mentions: directions(relations.mentions), depends_on: { outgoing: needs(relations.dependsOn.outgoing), incoming: needs(relations.dependsOn.incoming) }, related: reduce(relations.related) },
      linear: await this.linearOrigin(tx, ticket.id),
      ...(self.assignees === undefined ? {} : { assignees: self.assignees }),
    };
  }

  /**
   * De onde o ticket veio no Linear (ADR 0062, seção 5): SÓ a chave atual e o endereço. Criador, datas, chaves antigas, ids, workspace e
   * time da origem nunca saem pelo MCP (ADR 0061, seção 6); um teste de fonte confere que estas são as únicas colunas lidas.
   */
  private async linearOrigin(tx: TenantClient, ticketId: string): Promise<TicketOutput["linear"]> {
    const origin = await tx.ticketExternalRef.findFirst({ where: { ticketId, projectId: this.context.project.id, provider: "linear" }, select: { externalKey: true, externalUrl: true } });
    // Só com forma validada (TREEPM-496): valor antigo gravado fora da forma não é regravado, só deixa de sair.
    return origin ? { key: safeLinearKey(origin.externalKey), url: safeLinearUrl(origin.externalUrl) } : null;
  }

  /**
   * Responsáveis por ticket, pelo nome (ADR 0062), numa consulta só para a resposta inteira. Só com o alcance de pessoas efetivo:
   * sem ele devolve `null`, e nenhum resumo ganha a chave `assignees`. Nunca e-mail, papel nem foto.
   */
  private async assigneesOf(tx: TenantClient, summaries: readonly QueryTicketSummary[]): Promise<Map<string, Assignee[]> | null> {
    if (!this.withPeople) return null;
    const ids = [...new Set(summaries.map((entry) => entry.id))];
    const rows = ids.length === 0 ? [] : await tx.ticketAssignee.findMany({ where: { ticketId: { in: ids } }, select: { ticketId: true, person: { select: PERSON_NAME_SELECT } } });
    const byTicket = new Map<string, Assignee[]>();
    for (const row of rows) byTicket.set(row.ticketId, [...(byTicket.get(row.ticketId) ?? []), mcpPersonRef(row.person)]);
    for (const list of byTicket.values()) list.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
    return byTicket;
  }

  /** `list_people` (só com o alcance de pessoas efetivo): quem pode ser responsável neste projeto, pela regra da tela. */
  async listPeople(): Promise<z.infer<typeof listPeopleOutput>> {
    if (!this.withPeople || !this.peopleSource) throw new ToolInputError("This tool is not available.");
    const source = this.peopleSource;
    return this.run(this.context.principal, async (tx) => {
      const people = await source.assignablePeople(tx, this.context.project.id);
      return { people: people.map((person) => ({ ...mcpPersonRef(person), me: person.id === this.context.principal.person.id })) };
    });
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

  private summary(entry: QueryTicketSummary, keys: ReadonlyMap<string, string>, who: ReadonlyMap<string, Assignee[]> | null = null): Summary {
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
      dueDate: entry.dueDate,
      // "Hoje" do MCP é o dia em UTC (ADR 0064); a tela usa o do navegador.
      overdue: isOverdue({ dueDate: entry.dueDate, category: entry.status, today: this.query.utcToday(), idea: entry.idea !== null }),
      // Etiquetas (ADR 0065): só os nomes, pelo limpador (podem ter vindo do Linear); nem o id daqui nem o de lá.
      labels: entry.labels.map((label) => labelOut(label.name)),
      ...(who === null ? {} : { assignees: who.get(entry.id) ?? [] }),
    };
  }

  /** `list_labels`: as etiquetas do projeto (nome limpo, cor, contagem), sem id. Quem vê o projeto. */
  async listLabels(): Promise<z.infer<typeof listLabelsOutput>> {
    return this.run(this.context.principal, async (tx) => {
      await this.query.requireProject(tx, this.context.principal, this.context.project.id);
      const labels = await listProjectLabels(tx, this.context.project.id);
      return { labels: labels.map((label) => ({ name: labelOut(label.name), color: label.color, tickets: label.ticketCount })) };
    });
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
