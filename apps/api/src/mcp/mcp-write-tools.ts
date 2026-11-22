import { HttpException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import type { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { commentBodySchema } from "../tickets/ticket-comments.schema.js";
import type { TicketCommentsService } from "../tickets/ticket-comments.service.js";
import type { AgentWorkService } from "../tickets/agent-work.service.js";
import { ticketStatusSchema } from "../tickets/tickets.schema.js";
import type { TicketsService } from "../tickets/tickets.service.js";
import { ToolInputError } from "./mcp-tools.js";
import type { ProjectTools, RunInTenant, ToolContext } from "./mcp-tools.js";

/**
 * As três ferramentas de escrita do servidor MCP (ADR 0043). Só existem para token de alcance `write` com a chave de escrita da
 * organização ligada. NÃO reescrevem regra: chamam os serviços de ticket, comentário e marcador, com o `Principal` da pessoa do
 * token marcado com a origem (`via: mcp`) e o id do REGISTRO do token. Tudo em inglês, como as de leitura.
 */
export const WRITE_TOOL_NAMES = ["update_ticket_status", "add_comment", "set_agent_work"] as const;
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

const agentWorkOutput = z.strictObject({ since: z.string(), until: z.string(), note: z.string() }).nullable();
export const addCommentOutput = z.strictObject({ key: z.string(), commentId: z.string() });
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
} as const;

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
  request_id_reused: "requestId already used with a different text. Use a new requestId for a new comment.",
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
    if (!this.context.fresh) throw new ToolInputError("This change could not be verified. Try again.");
    const number = this.reader.ticketNumber(key);
    return this.run(this.context.principal, async (tx) => {
      const base = this.context.principal;
      const person = await tx.person.findFirst({ where: { id: base.person.id }, select: { active: true } });
      if (!person?.active) throw new ToolInputError("Access denied.");
      const actor = await this.services.authorization.loadActor(tx, base.person.id, base.person.clerkRole);
      const principal: Principal = { ...base, actor, via: { kind: "mcp", tokenId: this.context.tokenId } };
      const ticket = await tx.ticket.findFirst({ where: { projectId: this.context.project.id, number }, select: { id: true } });
      if (!ticket) throw new ToolInputError(`Ticket ${this.context.project.key}-${number} does not exist in this project.`);
      return fn(tx, principal, ticket.id, number);
    });
  }

  async updateTicketStatus(input: z.infer<typeof updateStatusInput>) {
    return this.write(input.key, async (tx, principal, id, number) => {
      await this.services.tickets.updateTicket(tx, principal, id, { status: input.status });
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
