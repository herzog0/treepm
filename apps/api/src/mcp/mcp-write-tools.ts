import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import type { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { commentBodySchema } from "../tickets/ticket-comments.schema.js";
import type { TicketCommentsService } from "../tickets/ticket-comments.service.js";
import type { AgentWorkService } from "../tickets/agent-work.service.js";
import { ticketDescriptionSchema, ticketPrioritySchema, ticketStatusSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import type { TicketsService } from "../tickets/tickets.service.js";
import { ToolInputError } from "./mcp-tools.js";
import type { ProjectTools, RunInTenant, ToolContext } from "./mcp-tools.js";

/**
 * As cinco ferramentas de escrita do servidor MCP (ADR 0043). Só existem para token de alcance `write` com a chave de escrita da
 * organização ligada. NÃO reescrevem regra: chamam os serviços de ticket, comentário e marcador, com o `Principal` da pessoa do
 * token marcado com a origem (`via: mcp`) e o id do REGISTRO do token. Tudo em inglês, como as de leitura.
 */
export const WRITE_TOOL_NAMES = ["update_ticket_status", "add_comment", "set_agent_work", "set_ticket_priority", "create_ticket"] as const;
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
const requestIdField = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "requestId must be 8 to 64 letters, digits, - or _.");
export const createTicketInput = z.strictObject({
  title: ticketTitleSchema.describe("Ticket title, 1 to 200 characters."),
  description: ticketDescriptionSchema.optional().describe("Optional description. Plain text or markdown; a key like PROJ-12 in it becomes a mention of that ticket."),
  parent: keyField.optional().describe("Optional key of the ticket this one is part of. Omit to create a top-level ticket."),
  priority: ticketPrioritySchema.optional().describe("Optional own priority, -999 to 999 (default 0)."),
  idea: z.boolean().optional().describe("true to register the ticket as an idea (not accepted work yet) instead of ordinary work."),
  requestId: requestIdField.optional().describe("Optional. If you repeat the call with the same requestId and the same title within 10 minutes (for example after a timeout), you get the ticket already created and no second one is created."),
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
});
export const createTicketOutput = z.strictObject({ key: z.string(), ticket: ticketSummaryOutput });
export const setAgentWorkOutput = z.strictObject({ key: z.string(), agentWork: agentWorkOutput });

const NOTE = "This tool changes data on behalf of the person who owns the token, with the same rules as the TreePM screen.";
export const WRITE_TOOL_DEFINITIONS = {
  update_ticket_status: {
    title: "Update a ticket's status",
    description: `Change the status of one ticket (todo, in_progress, in_review, done, cancelled). A ticket can only be done when its children are done or cancelled; tickets that are an idea or inside an idea stay in todo until the idea is accepted. Returns the ticket as get_ticket does. ${NOTE}`,
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
    description: `Create one ticket in this project with a title and, optionally, a description, a parent ticket, a priority and idea: true to register it as an idea. You choose where it goes: it does not look for a place by itself, does not use any AI and does not assign people. A ticket inside an idea stays in todo. It does not move, edit or delete existing tickets. To retry safely after a timeout, repeat the call with the same requestId and the same arguments within 10 minutes: you get the same ticket, not a second one. Returns the new ticket key and its summary. Counts toward the limit of 40 changes per minute. ${NOTE}`,
    inputSchema: createTicketInput,
    outputSchema: createTicketOutput,
  },
} as const;

/** Resumo dos argumentos de uma criação (não os argumentos): a repetição só vale se tudo o que foi pedido bater. */
function requestDigest(input: z.infer<typeof createTicketInput>, parentId: string | null): string {
  const normalized = JSON.stringify([input.title, input.description ?? "", parentId, input.idea === true, input.priority ?? 0]);
  return createHash("sha256").update(normalized).digest("hex");
}

export type WriteServices = {
  tickets: TicketsService;
  comments: TicketCommentsService;
  agentWork: AgentWorkService;
  authorization: AuthorizationService;
};
export type WriteContext = ToolContext & { tokenId: string; fresh: boolean };

const CONFLICTS: Record<string, string> = {
  project_archived: "This project is archived and read-only.",
  ticket_has_open_children: "Finish or cancel the open child tickets first.",
  ticket_in_idea: "Tickets inside an idea stay in todo until the idea is accepted.",
  agent_work_in_idea: "An idea is not worked on before it is accepted.",
  agent_work_finished: "A done or cancelled ticket cannot be marked as worked on.",
  request_id_reused: "requestId already used with a different request. Use a new requestId for a new request.",
};

/** A recusa de um serviço (exceção do Nest, em português) como frase curta em inglês; nada de detalhe interno. */
export function refusalMessage(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const status = error.getStatus();
  const payload = error.getResponse();
  const code = typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
  if (status === 403) return "You do not have permission to change this ticket.";
  if (status === 404) return "Ticket or project not found.";
  if (status === 400) return "Invalid input.";
  if (status === 409) return (typeof code === "string" ? CONFLICTS[code] : undefined) ?? "The change conflicts with the current state of the ticket.";
  return null;
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

  async createTicket(input: z.infer<typeof createTicketInput>): Promise<z.infer<typeof createTicketOutput>> {
    const parentNumber = input.parent === undefined ? undefined : this.reader.ticketNumber(input.parent);
    return this.writeAs(async (tx, principal) => {
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
        { title: input.title, description: input.description, parentId, idea: input.idea },
        {},
        input.requestId === undefined ? undefined : { id: input.requestId, digest: requestDigest(input, parentId) },
      );
      if (!repeated && input.priority !== undefined && input.priority !== 0) await this.services.tickets.updateTicket(tx, principal, created.id, { priority: input.priority });
      const ticket = await this.reader.summaryIn(tx, principal, created.number);
      return { key: ticket.key, ticket };
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
