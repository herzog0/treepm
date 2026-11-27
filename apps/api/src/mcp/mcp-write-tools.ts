import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import { DUE_DATE_MAX, DUE_DATE_MIN, LABELS_PER_TICKET, cleanLabelName, isValidDueDate, labelNameKey } from "@treepm/domain";
import type { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { commentBodySchema } from "../tickets/ticket-comments.schema.js";
import type { TicketCommentsService } from "../tickets/ticket-comments.service.js";
import type { AgentWorkService } from "../tickets/agent-work.service.js";
import type { LabelRef } from "../tickets/labels.schema.js";
import type { LabelsService } from "../tickets/labels.service.js";
import { dependencyNeedSchema, impedimentReasonSchema, ticketDescriptionSchema, ticketPrioritySchema, ticketStatusSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import { structureKey, withStructureSlot } from "../tickets/structure-queue.js";
import type { TicketsService } from "../tickets/tickets.service.js";
import { WRITE_LIMIT_PER_PERSON_PER_MINUTE } from "./mcp-limits.js";
import { labelOut, looseLabelKey } from "./mcp-text.js";
import { ToolInputError } from "./mcp-tools.js";
import type { ProjectTools, RunInTenant, ToolContext } from "./mcp-tools.js";

/**
 * As ferramentas de escrita do servidor MCP (ADR 0043; ADR 0062, fatia 1: editar, mover e relações). Só existem para token de alcance `write` com a chave de escrita da
 * organização ligada. NÃO reescrevem regra: chamam os serviços de ticket, comentário e marcador, com o `Principal` da pessoa do
 * token marcado com a origem (`via: mcp`) e o id do REGISTRO do token. Tudo em inglês, como as de leitura.
 */
export const WRITE_TOOL_NAMES = ["update_ticket_status", "add_comment", "set_agent_work", "set_ticket_priority", "create_ticket", "update_ticket", "move_ticket", "add_dependency", "remove_dependency", "mark_impediment", "clear_impediment", "set_ticket_assignees", "start_linear_sync", "continue_linear_sync"] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

const keyField = z.string().trim().max(32, "Ticket key is too long.").regex(/^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$/, "Ticket key must look like PROJ-123.");

export const updateStatusInput = z.strictObject({
  key: keyField.describe("Ticket key of this project, for example PROJ-47."),
  status: ticketStatusSchema.describe("New status: todo, in_progress, in_review, done or cancelled."),
});
export const addCommentInput = z.strictObject({
  key: keyField.describe("Ticket key of this project."),
  body: commentBodySchema.describe("Comment text, 1 to 10,000 characters. Plain text or markdown."),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "requestId must be 8 to 64 letters, digits, - or _.").optional().describe("Optional. If you repeat the call with the same requestId on the same ticket within 10 minutes (for example after a timeout), you get the same commentId and no second comment is created."),
});
export const setAgentWorkInput = z.strictObject({
  key: keyField.describe("Ticket key of this project."),
  working: z.boolean().describe("true to mark (or renew) that an agent is working on this ticket now; false to clear the mark."),
  minutes: z.number().int().min(5).max(240).optional().describe("How long the mark lasts, 5 to 240 minutes (default 60). It expires on its own."),
  note: z.string().max(200).optional().describe("Optional one-line note shown on the ticket page, up to 200 characters."),
});

export const setTicketPriorityInput = z.strictObject({
  key: keyField.describe("Ticket key of this project."),
  priority: ticketPrioritySchema.describe("New priority: an integer from -999 to 999. 0 means \"no priority of its own\" (the ticket inherits the one of its nearest ancestor). Higher comes first; negative goes last."),
});
/** O prazo no MCP: a mesma regra da tela e da API, com a mensagem em inglês, como os outros campos do MCP. */
const dueDateField = z.string().refine(isValidDueDate, `dueDate must be a calendar day YYYY-MM-DD that exists, from ${DUE_DATE_MIN} to ${DUE_DATE_MAX}.`);
const requestIdField = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "requestId must be 8 to 64 letters, digits, - or _.");
/** Etiquetas por NOME (ADR 0065): o domínio limpa o nome (espaços, controle, corte em 60); o que não sobra nada é recusado aqui. */
const labelNamesField = z
  .array(z.string().max(200, "A label name is too long.").refine((name) => cleanLabelName(name) !== null, "Label names must not be empty or too long."))
  .max(LABELS_PER_TICKET, `At most ${LABELS_PER_TICKET} labels per list.`);
const ADD_LABELS = "Optional names of labels to put on the ticket. A name that matches a label of this project (ignoring case, or as list_labels and the ticket reads show it) puts that label; a new name creates the label.";
const REMOVE_LABELS = "Optional names of labels to take off the ticket (as list_labels and the ticket reads show them; case is ignored). A name that is no label of this project makes the whole call fail and nothing changes; a label the ticket does not have is ignored.";
export const createTicketInput = z.strictObject({
  title: ticketTitleSchema.describe("Ticket title, 1 to 200 characters."),
  description: ticketDescriptionSchema.optional().describe("Optional description. Plain text or markdown; a key like PROJ-12 in it becomes a mention of that ticket."),
  parent: keyField.optional().describe("Optional key of the ticket this one is part of. Omit to create a top-level ticket."),
  priority: ticketPrioritySchema.optional().describe("Optional own priority, -999 to 999 (default 0)."),
  idea: z.boolean().optional().describe("true to register the ticket as an idea (not accepted work yet) instead of ordinary work."),
  dueDate: dueDateField.nullable().optional().describe("Optional due date: a calendar day YYYY-MM-DD (no time, no time zone), from 2000-01-01 to 2100-12-31. Omit or null for none."),
  addLabels: labelNamesField.optional().describe(ADD_LABELS),
  requestId: requestIdField.optional().describe("Optional. If you repeat the call with the same requestId and the same title within 10 minutes (for example after a timeout), you get the ticket already created and no second one is created."),
});

export const updateTicketInput = z.strictObject({
  key: keyField.describe("Ticket key of this project, for example PROJ-47."),
  title: ticketTitleSchema.optional().describe("Optional new title, 1 to 200 characters."),
  description: ticketDescriptionSchema.optional().describe("Optional new description (replaces the old one). Plain text or markdown; a key like PROJ-12 in it becomes a mention of that ticket; a mention of a person is refused."),
  dueDate: dueDateField.nullable().optional().describe("Optional due date: a calendar day YYYY-MM-DD (no time, no time zone), from 2000-01-01 to 2100-12-31; null removes it."),
  addLabels: labelNamesField.optional().describe(ADD_LABELS),
  removeLabels: labelNamesField.optional().describe(REMOVE_LABELS),
});
export const moveTicketInput = z.strictObject({
  key: keyField.describe("Key of the ticket to move."),
  parent: keyField.nullable().describe("Key of the ticket that becomes its parent (it must be in this project), or null to move it to the top level."),
});
export const dependencyInput = z.strictObject({
  key: keyField.describe("Key of the ticket that depends on another."),
  dependsOn: keyField.describe("Key of the ticket it depends on (it must be in this project)."),
});
export const addDependencyInput = dependencyInput.extend({
  need: dependencyNeedSchema
    .optional()
    .describe("What the dependency holds: start (default; the work cannot start until the other ticket is finished) or deliver (the work can start now, but the ticket cannot be done until the other ticket is finished)."),
});
export const markImpedimentInput = z.strictObject({
  key: keyField.describe("Ticket key of this project, for example PROJ-47."),
  reason: impedimentReasonSchema.describe("Why the ticket is blocked: what is in the way and what would unblock it, 1 to 1000 characters. A mention of a person is refused."),
});
export const clearImpedimentInput = z.strictObject({ key: keyField.describe("Ticket key of this project, for example PROJ-47.") });

export const setTicketAssigneesInput = z.strictObject({
  key: keyField.describe("Ticket key of this project, for example PROJ-47."),
  personIds: z.array(z.uuid("Each person id must be an id returned by list_people.")).max(50, "At most 50 people.").describe("The COMPLETE list of people who are responsible for the ticket, as ids from list_people. People not in the list are removed; an empty list removes everybody."),
});

const agentWorkOutput = z.strictObject({ since: z.string(), until: z.string(), note: z.string() }).nullable();
export const addCommentOutput = z.strictObject({ key: z.string(), commentId: z.string() });
const ticketSummaryOutput = z.strictObject({
  key: z.string(),
  title: z.string(),
  excerpt: z.string(),
  status: ticketStatusSchema,
  parent: z.string().nullable(),
  idea: z.union([z.strictObject({ kind: z.literal("root"), stage: z.string() }), z.strictObject({ kind: z.literal("inside"), root: z.string() })]).nullable(),
  agentWork: z.strictObject({ until: z.string() }).nullable(),
  priority: z.number().int(),
  effective_priority: z.number().int(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  labels: z.array(z.string()),
});
export const createTicketOutput = z.strictObject({ key: z.string(), ticket: ticketSummaryOutput });
export const setAgentWorkOutput = z.strictObject({ key: z.string(), agentWork: agentWorkOutput });

const NOTE = "This tool changes data on behalf of the person who owns the token, with the same rules as the TreePM screen.";
/** Por que etiquetas vão por `addLabels`/`removeLabels` e não pela lista inteira (ADR 0065): um cliente que esquece uma não apaga nada. */
const LABELS_NOTE =
  "Labels are changed by name with addLabels and removeLabels, not by sending the whole list: a label you do not mention stays, so forgetting one never removes it. A ticket has at most 20 labels and a project at most 200; going over makes the call fail and nothing changes. Label changes notify nobody.";
export const WRITE_TOOL_DEFINITIONS = {
  update_ticket_status: {
    title: "Update a ticket's status",
    description: `Change the status of one ticket (todo, in_progress, in_review, done, cancelled). A ticket with child tickets (ideas do not count) has its status computed from them and cannot be set by hand: change the child tickets instead. A ticket that depends on another one to deliver cannot be done until that one is done or cancelled. Tickets that are an idea or inside an idea stay in todo until the idea is accepted. Returns the ticket as get_ticket does. ${NOTE}`,
    inputSchema: updateStatusInput,
  },
  add_comment: {
    title: "Add a comment to a ticket",
    description: `Write a comment on a ticket (not on an area). Returns only the ticket key and the comment id; comments cannot be read through this server. ${NOTE}`,
    inputSchema: addCommentInput,
    outputSchema: addCommentOutput,
  },
  set_agent_work: {
    title: "Mark that an agent is working on a ticket",
    description: `Turn on, renew or turn off the "an agent is working on this now" mark of a ticket. The mark expires by itself after \`minutes\` (default 60); call again to renew. It is refused on done or cancelled tickets and on ideas. It does not change the status. ${NOTE}`,
    inputSchema: setAgentWorkInput,
    outputSchema: setAgentWorkOutput,
  },
  set_ticket_priority: {
    title: "Set a ticket's priority",
    description: `Set the own priority of one ticket (an integer from -999 to 999; higher comes first, 0 means none of its own, so it inherits the nearest ancestor's). It changes nothing else: not the status, title, description, parent or assignees. Returns the ticket as get_ticket does. The change shows in the ticket history as made through MCP. ${NOTE}`,
    inputSchema: setTicketPriorityInput,
  },
  create_ticket: {
    title: "Create a ticket",
    description: `Create one ticket in this project with a title and, optionally, a description, a parent ticket, a priority, a due date (a calendar day YYYY-MM-DD), labels (addLabels, by name; missing ones are created) and idea: true to register it as an idea. You choose where it goes: it does not look for a place by itself, does not use any AI and does not assign people. A ticket inside an idea stays in todo. It does not move, edit or delete existing tickets. To retry safely after a timeout, repeat the call with the same requestId and the same arguments within 10 minutes: you get the same ticket, not a second one. Returns the new ticket key and its summary. Counts toward the limit of ${WRITE_LIMIT_PER_PERSON_PER_MINUTE} changes per minute. ${LABELS_NOTE} ${NOTE}`,
    inputSchema: createTicketInput,
    outputSchema: createTicketOutput,
  },
  update_ticket: {
    title: "Edit a ticket's title, description, due date and labels",
    description: `Change the title, the description, the due date, the labels or any of them of one ticket (at least one). The description replaces the old one; a key like PROJ-12 in it becomes a mention of that ticket, and a mention of a person is refused. The due date is a calendar day YYYY-MM-DD with no time and no time zone; null removes it. Setting a due date notifies nobody and does not change the order of the work queue. It does not change the status, priority, parent or assignees (other tools do). ${LABELS_NOTE} Repeating the same call changes nothing the second time. Returns the ticket as get_ticket does. The change shows in the ticket history as made through MCP. ${NOTE}`,
    inputSchema: updateTicketInput,
  },
  move_ticket: {
    title: "Move a ticket in the tree",
    description: `Change the parent of one ticket: another ticket of this project, or null for the top level. It follows the rules of the screen: no cycle (not under itself or a descendant), the status of the old and the new parent is computed again from their child tickets, and a ticket that is in progress, in review or done cannot go into an idea. It cannot move a ticket to another project. A parent that is not in this project is refused. Repeating the same call changes nothing the second time. Returns the ticket as get_ticket does. ${NOTE}`,
    inputSchema: moveTicketInput,
  },
  add_dependency: {
    title: "Make a ticket depend on another",
    description: `Record that one ticket depends on another ticket of this project, to start (default: the work waits until the other ticket is finished) or to deliver (the work can start now; the ticket can only be done after the other ticket is finished). Between two tickets there is at most one dependency: calling again with the other need changes the need. A ticket cannot depend on itself, and a dependency that would close a cycle (of either need) is refused. If the same dependency already exists nothing changes. It changes nothing else. Returns the ticket that depends, as get_ticket does. ${NOTE}`,
    inputSchema: addDependencyInput,
  },
  remove_dependency: {
    title: "Remove a dependency between two tickets",
    description: `Remove the record that one ticket depends on another ticket of this project. If there is no such dependency the call is refused, as on the screen. It changes nothing else. Returns the ticket that depended, as get_ticket does. ${NOTE}`,
    inputSchema: dependencyInput,
  },
  mark_impediment: {
    title: "Mark a ticket as blocked",
    description: `Mark an impediment on one open ticket, with the reason: something is in the way of the work and needs action. The ticket becomes blocked until someone clears the impediment or the ticket is done or cancelled. Calling again replaces the reason. It is refused on done or cancelled tickets. Waiting for another ticket is not an impediment: use add_dependency for that. It changes nothing else. Returns the ticket as get_ticket does. ${NOTE}`,
    inputSchema: markImpedimentInput,
  },
  clear_impediment: {
    title: "Clear a ticket's impediment",
    description: `Remove the impediment of one ticket, so it is no longer blocked. If the ticket has no impediment nothing changes. It changes nothing else. Returns the ticket as get_ticket does. ${NOTE}`,
    inputSchema: clearImpedimentInput,
  },
} as const;

/** Só existe para token de escrita COM o alcance de pessoas efetivo (ADR 0062). */
export const PEOPLE_WRITE_TOOL_DEFINITIONS = {
  set_ticket_assignees: {
    title: "Set who is responsible for a ticket",
    description: `Define the COMPLETE list of people responsible for one ticket, by person id (get the ids from list_people). People who are in the list and were not responsible are added; people who were responsible and are not in the list are removed; an empty list removes everybody. The people must be active and able to see the project: a person who cannot be assigned (unknown, from another organization, no longer in the organization or without access to the project) makes the whole call fail and nothing changes, with the same short answer for all those cases. Repeating the same list changes nothing and records nothing. It changes nothing else about the ticket. Returns the ticket as get_ticket does. The changes show in the ticket history as made through MCP. ${NOTE}`,
    inputSchema: setTicketAssigneesInput,
  },
} as const;

/** Resumo dos argumentos de uma criação (não os argumentos): a repetição só vale se tudo o que foi pedido bater. */
function requestDigest(input: z.infer<typeof createTicketInput>, parentId: string | null): string {
  // O prazo entra no resumo só quando foi pedido: o resumo de uma criação sem prazo continua o mesmo de antes (ADR 0064).
  // As etiquetas também (ADR 0065): só quando foram pedidas, como o prazo.
  const normalized = JSON.stringify([input.title, input.description ?? "", parentId, input.idea === true, input.priority ?? 0, ...(input.dueDate ? [input.dueDate] : []), ...(input.addLabels?.length ? [{ labels: input.addLabels }] : [])]);
  return createHash("sha256").update(normalized).digest("hex");
}

export type WriteServices = {
  tickets: TicketsService;
  comments: TicketCommentsService;
  agentWork: AgentWorkService;
  authorization: AuthorizationService;
  labels: LabelsService;
};
export type WriteContext = ToolContext & { tokenId: string; fresh: boolean };

const CONFLICTS: Record<string, string> = {
  project_archived: "This project is archived and read-only.",
  status_is_derived: "This ticket has child tickets, so its status is computed from its child tickets. Change the status of the child tickets instead.",
  ticket_in_idea: "Tickets inside an idea stay in todo until the idea is accepted.",
  agent_work_in_idea: "An idea is not worked on before it is accepted.",
  agent_work_finished: "A done or cancelled ticket cannot be marked as worked on.",
  structure_busy: "The project structure is busy; try again in a moment.",
  concurrent_update: "Another change happened at the same time. Try again in a moment.",
  ticket_cycle: "A ticket cannot be moved under itself or one of its descendants.",
  move_into_idea_blocked: "A ticket that is in progress, in review or done cannot go into an idea; move only what is still todo.",
  dependency_self: "A ticket cannot depend on itself.",
  dependency_cycle: "That dependency would close a cycle of dependencies.",
  ticket_finished: "A done or cancelled ticket cannot be marked as blocked.",
  request_id_reused: "requestId already used with a different request. Use a new requestId for a new request.",
  label_limit_ticket: `A ticket can have at most ${LABELS_PER_TICKET} labels. Remove one first. Nothing was changed.`,
  label_limit_project: "This project already has the most labels it can have (200). Delete one on the TreePM screen first. Nothing was changed.",
  label_name_taken: "A label with that name already exists in this project.",
};

/** A recusa de um serviço (exceção do Nest, em português) como frase curta em inglês; nada de detalhe interno. */
export function refusalMessage(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const status = error.getStatus();
  const payload = error.getResponse();
  const code = typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
  if (status === 403) return "You do not have permission to change this ticket.";
  if (status === 404) return code === "dependency_not_found" ? "There is no such dependency between these tickets." : code === "label_not_found" ? "That label no longer exists in this project. Nothing was changed." : "Ticket or project not found.";
  if (status === 400) return code === "label_name_invalid" ? "Label names must not be empty or too long." : "Invalid input.";
  if (status === 409 && code === "ticket_has_open_delivery_dependencies") {
    const keys = (payload as { details?: { keys?: unknown } }).details?.keys;
    const list = Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string").join(", ") : "";
    return `This ticket depends on ${list || "other tickets"} to deliver: finish or cancel ${list ? "them" : "those"} first, or change the dependency to start.`;
  }
  if (status === 409) return (typeof code === "string" ? CONFLICTS[code] : undefined) ?? "The change conflicts with the current state of the ticket.";
  return null;
}

/** A recusa de `requireAssignable`: pessoa inexistente (404), inativa ou sem acesso ao projeto (409). Qualquer outra recusa segue o caminho comum. */
function isPersonRefusal(error: HttpException): boolean {
  const payload = error.getResponse();
  const code = typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
  // O 404 de pessoa tem a mensagem "Pessoa não encontrada." (a do ticket é outra e segue o caminho comum).
  if (error.getStatus() === 404) return typeof payload === "string" ? payload === "Pessoa não encontrada." : (payload as { message?: unknown }).message === "Pessoa não encontrada.";
  return code === "person_inactive" || code === "person_without_project_access";
}

export class WriteTools {
  constructor(
    private readonly run: RunInTenant,
    private readonly services: WriteServices,
    private readonly reader: ProjectTools,
    private readonly context: WriteContext,
  ) {}

  /**
   * Toda escrita: exige a participação conferida agora (sem a memória de 5 minutos), relê a pessoa e os papéis atuais dentro da
   * própria transação e marca a origem. Sem a marca de "conferido", não escreve. A chave passa pelo MESMO analisador estrito das
   * leituras (`ProjectTools.ticketNumber`), e `fn` recebe o número canônico: a resposta é montada dentro desta transação.
   */
  private async write<T>(key: string, fn: (tx: TenantClient, principal: Principal, ticketId: string, number: number) => Promise<T>): Promise<T> {
    const number = this.reader.ticketNumber(key);
    return this.writeAs(async (tx, principal) => {
      const ticket = await tx.ticket.findFirst({ where: { projectId: this.context.project.id, number }, select: { id: true } });
      if (!ticket) throw new ToolInputError(`Ticket ${this.context.project.key}-${number} does not exist in this project.`);
      return fn(tx, principal, ticket.id, number);
    });
  }

  /** A parte comum de toda escrita (ver `write`), sem ticket de partida: a criação a usa. */
  private async writeAs<T>(fn: (tx: TenantClient, principal: Principal) => Promise<T>): Promise<T> {
    if (!this.context.fresh) throw new ToolInputError("This change could not be verified. Try again.");
    return this.run(this.context.principal, async (tx) => {
      const base = this.context.principal;
      const person = await tx.person.findFirst({ where: { id: base.person.id }, select: { active: true } });
      if (!person?.active) throw new ToolInputError("Access denied.");
      const actor = await this.services.authorization.loadActor(tx, base.person.id, base.person.clerkRole);
      const principal: Principal = { ...base, actor, via: { kind: "mcp", tokenId: this.context.tokenId } };
      return fn(tx, principal);
    });
  }

  async updateTicketStatus(input: z.infer<typeof updateStatusInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      await this.services.tickets.updateTicket(tx, principal, id, { status: input.status });
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  async setTicketPriority(input: z.infer<typeof setTicketPriorityInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      await this.services.tickets.updateTicket(tx, principal, id, { priority: input.priority });
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  async updateTicket(input: z.infer<typeof updateTicketInput>) {
    const add = input.addLabels ?? [];
    const remove = input.removeLabels ?? [];
    const fields = input.title !== undefined || input.description !== undefined || input.dueDate !== undefined;
    if (!fields && add.length === 0 && remove.length === 0) throw new ToolInputError("Provide a title, a description, a due date, labels to add or remove, or any of them.");
    return this.write(input.key, async (tx, principal, id, number) => {
      // As etiquetas são resolvidas ANTES de qualquer escrita: um nome recusado não deixa o título mudado (tudo numa transação, de todo modo).
      const labels = add.length + remove.length > 0 ? await this.labelChange(tx, add, remove) : null;
      // Só etiquetas: o ticket não é "editado" (nenhum `ticket.updated`), como na tela, que tem a rota própria das etiquetas.
      if (fields) {
        await this.services.tickets.updateTicket(tx, principal, id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        });
      }
      if (labels) await this.services.labels.changeTicketLabels(tx, principal, id, labels);
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  /**
   * Nomes de etiqueta → o pedido do serviço da tela (`LabelsService.changeTicketLabels`, ADR 0065). O cliente só vê o nome LIMPO
   * (`labelOut`): a volta acha a etiqueta pela chave do nome cru (a do banco, `name_key`) e, se nenhuma casa, pela chave do nome limpo.
   * Nome cru casa primeiro (é único no projeto); duas etiquetas que ficam iguais depois de limpas e nenhuma igual crua = ambíguo, recusado.
   * Em `addLabels`, nome sem etiqueta vira etiqueta nova (o serviço cria, com as conferências e limites da tela). Em `removeLabels`, nome
   * que não é etiqueta do projeto RECUSA a chamada inteira (um erro de digitação não passa como "tirei"); etiqueta do projeto que o ticket
   * não tem não muda nada, como na tela. Uma consulta (no máximo 200 etiquetas).
   */
  private async labelChange(tx: TenantClient, add: readonly string[], remove: readonly string[]): Promise<{ add: LabelRef[]; remove: string[] }> {
    const rows = await tx.projectLabel.findMany({ where: { projectId: this.context.project.id }, select: { id: true, name: true, nameKey: true } });
    const byRaw = new Map(rows.map((row) => [row.nameKey, row]));
    const byClean = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      const key = looseLabelKey(labelOut(row.name));
      byClean.set(key, [...(byClean.get(key) ?? []), row]);
    }
    const find = (name: string): string | null => {
      const raw = byRaw.get(labelNameKey(cleanLabelName(name) as string));
      if (raw) return raw.id;
      const clean = byClean.get(looseLabelKey(name)) ?? [];
      if (clean.length > 1) throw new ToolInputError("A label name matches more than one label of this project. Rename one of them on the TreePM screen. Nothing was changed.");
      return clean[0]?.id ?? null;
    };
    const adds: LabelRef[] = add.map((name) => {
      const id = find(name);
      return id === null ? { name } : { labelId: id };
    });
    const removes = remove.map((name) => {
      const id = find(name);
      if (id === null) throw new ToolInputError("There is no label named like that in this project (see list_labels). Nothing was changed.");
      return id;
    });
    if (adds.some((ref) => "labelId" in ref && removes.includes(ref.labelId))) throw new ToolInputError("A label cannot be both added and removed in one call. Nothing was changed.");
    return { add: adds, remove: removes };
  }

  /**
   * Muda a estrutura (ADR 0045): o mesmo caminho da rota `PATCH tickets/:id` com `parentId`. A fila em memória vem ANTES da
   * transação (mesma chave: organização e projeto, como `@QueuesStructure({ by: "ticket" })` resolve para o projeto do ticket) e a
   * trava do banco é pega por `updateTicket` assim que o corpo traz `parentId`, inclusive `null`.
   */
  async moveTicket(input: z.infer<typeof moveTicketInput>) {
    const parentNumber = input.parent === null ? null : this.reader.ticketNumber(input.parent);
    this.reader.ticketNumber(input.key);
    // Recusa barata antes da fila: sem a verificação fresca nada é escrito, então nem vale esperar uma vaga.
    if (!this.context.fresh) throw new ToolInputError("This change could not be verified. Try again.");
    const move = () => this.write(input.key, async (tx, principal, id, number) => {
      let parentId: string | null = null;
      if (parentNumber !== null) {
        const parent = await tx.ticket.findFirst({ where: { projectId: this.context.project.id, number: parentNumber }, select: { id: true } });
        if (!parent) throw new ToolInputError(`Ticket ${this.context.project.key}-${parentNumber} does not exist in this project.`);
        parentId = parent.id;
      }
      await this.services.tickets.updateTicket(tx, principal, id, { parentId });
      return this.reader.ticketIn(tx, principal, number);
    });
    const key = structureKey(this.context.principal.session.orgId, this.context.project.id);
    return key === undefined ? move() : withStructureSlot(key, move);
  }

  async addDependency(input: z.infer<typeof addDependencyInput>) {
    return this.dependency(input, (tx, principal, id, otherId) => this.services.tickets.addDependency(tx, principal, id, otherId, input.need ?? "start"));
  }

  /** Marca o impedimento (ADR 0068, seção 5) pelo mesmo caminho da tela. */
  async markImpediment(input: z.infer<typeof markImpedimentInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      await this.services.tickets.markImpediment(tx, principal, id, input.reason);
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  /** Limpa o impedimento (ADR 0068, seção 5) pelo mesmo caminho da tela. */
  async clearImpediment(input: z.infer<typeof clearImpedimentInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      await this.services.tickets.clearImpediment(tx, principal, id);
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  async removeDependency(input: z.infer<typeof dependencyInput>) {
    return this.dependency(input, (tx, principal, id, otherId) => this.services.tickets.removeDependency(tx, principal, id, otherId));
  }

  private async dependency(input: z.infer<typeof dependencyInput>, apply: (tx: TenantClient, principal: Principal, id: string, otherId: string) => Promise<unknown>) {
    const otherNumber = this.reader.ticketNumber(input.dependsOn);
    return this.write(input.key, async (tx, principal, id, number) => {
      const other = await tx.ticket.findFirst({ where: { projectId: this.context.project.id, number: otherNumber }, select: { id: true } });
      if (!other) throw new ToolInputError(`Ticket ${this.context.project.key}-${otherNumber} does not exist in this project.`);
      await apply(tx, principal, id, other.id);
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  async createTicket(input: z.infer<typeof createTicketInput>): Promise<z.infer<typeof createTicketOutput>> {
    const parentNumber = input.parent === undefined ? undefined : this.reader.ticketNumber(input.parent);
    // Recusa barata antes da fila: sem a verificação fresca nada é escrito, então nem vale esperar uma vaga.
    if (!this.context.fresh) throw new ToolInputError("This change could not be verified. Try again.");
    const create = (): Promise<z.infer<typeof createTicketOutput>> => this.writeAs(async (tx, principal) => {
      const labels = input.addLabels?.length ? await this.labelChange(tx, input.addLabels, []) : null;
      let parentId: string | null = null;
      if (parentNumber !== undefined) {
        const parent = await tx.ticket.findFirst({ where: { projectId: this.context.project.id, number: parentNumber }, select: { id: true } });
        if (!parent) throw new ToolInputError(`Ticket ${this.context.project.key}-${parentNumber} does not exist in this project.`);
        parentId = parent.id;
      }
      const { created, repeated } = await this.services.tickets.createChecked(
        tx,
        principal,
        this.context.project.id,
        { title: input.title, description: input.description, parentId, idea: input.idea, dueDate: input.dueDate },
        {},
        input.requestId === undefined ? undefined : { id: input.requestId, digest: requestDigest(input, parentId) },
      );
      if (!repeated && input.priority !== undefined && input.priority !== 0) await this.services.tickets.updateTicket(tx, principal, created.id, { priority: input.priority });
      // Etiquetas pelo mesmo serviço da tela (um evento `ticket.labels_changed`); a repetição já as tem.
      if (!repeated && labels) await this.services.labels.changeTicketLabels(tx, principal, created.id, labels);
      const ticket = await this.reader.summaryIn(tx, principal, created.number);
      return { key: ticket.key, ticket };
    });
    // Com pai, a criação muda a estrutura (ADR 0045, adendo 1): espera na fila em memória antes de abrir a transação, como na rota HTTP
    // (mesma chave: o projeto). Sem pai não pega a trava e não passa pela fila.
    const key = parentNumber === undefined ? undefined : structureKey(this.context.principal.session.orgId, this.context.project.id);
    return key === undefined ? create() : withStructureSlot(key, create);
  }

  /**
   * Define os responsáveis pelo MESMO serviço das rotas `PUT/DELETE tickets/:id/assignees/:personId` (`TicketsService.setAssignees`).
   * Pessoa nova que não pode ser responsável (inexistente, de outra organização, inativa ou sem acesso ao projeto): UMA frase curta,
   * igual nos quatro casos, para a resposta não dizer qual deles é.
   */
  async setTicketAssignees(input: z.infer<typeof setTicketAssigneesInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      try {
        await this.services.tickets.setAssignees(tx, principal, id, input.personIds);
      } catch (error) {
        if (error instanceof HttpException && isPersonRefusal(error)) throw new ToolInputError("One of these people cannot be assigned to this ticket. Nothing was changed.");
        throw error;
      }
      return this.reader.ticketIn(tx, principal, number);
    });
  }

  async addComment(input: z.infer<typeof addCommentInput>): Promise<z.infer<typeof addCommentOutput>> {
    return this.write(input.key, async (tx, principal, id, number) => {
      const entry = await this.services.comments.add(tx, principal, id, input.body, undefined, input.requestId);
      return { key: `${this.context.project.key}-${number}`, commentId: entry.id };
    });
  }

  async setAgentWork(input: z.infer<typeof setAgentWorkInput>): Promise<z.infer<typeof setAgentWorkOutput>> {
    return this.write(input.key, async (tx, principal, id, number) => ({
      key: `${this.context.project.key}-${number}`,
      agentWork: await this.services.agentWork.set(tx, principal, id, { working: input.working, minutes: input.minutes, note: input.note }),
    }));
  }
}
