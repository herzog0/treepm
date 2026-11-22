import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import {
  conversationDetailSchema,
  conversationMessageBodySchema,
  conversationSummarySchema,
  createTicketBodySchema,
  createdTicketSchema,
  placementBodySchema,
  placementOutcomeSchema,
  draftBodySchema,
} from "./conversations.schema.js";
import type { ConversationDetail, ConversationSummary } from "./conversations.schema.js";
import { PlacementService } from "./placement.service.js";
import { AssistantGate } from "./assistant-gate.js";
import { AssistantUnavailableError, PLACEMENT_TIMEOUTS } from "./ports.js";
import type { ConversationProvider, ConversationTurn, PlacementTimeouts } from "./ports.js";
import { TicketsService } from "../tickets/tickets.service.js";
import type { TicketDetail } from "../tickets/tickets.schema.js";
import type { ProjectRow } from "../tickets/tickets.service.js";

/** Teto dos títulos de agrupadores que vão ao Claude em cada turno (ADR 0033). */
const MAX_GROUP_TITLES = 30;

type ConversationRow = {
  orgId: string;
  id: string;
  projectId: string;
  authorPersonId: string;
  status: string;
  draftTitle: string | null;
  draftDescription: string | null;
  ready: boolean;
  createdTicketId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const asStatus = (row: { status: string }) => row.status as ConversationSummary["status"];

function toSummary(row: ConversationRow): ConversationSummary {
  return parseOutput(conversationSummarySchema, {
    id: row.id,
    projectId: row.projectId,
    status: asStatus(row),
    draft: row.draftTitle === null ? null : { title: row.draftTitle, description: row.draftDescription ?? "" },
    ready: row.ready,
    createdTicketId: row.createdTicketId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Conversa de novo ticket com a IA (ADR 0029). As duas rotas que chamam o provedor (`@OwnTransactions`) fazem
 * leitura curta → chamada SEM transação aberta → escrita curta que confere tudo de novo. As demais seguem o
 * padrão da ADR 0021. Só a autora lê, continua e apaga a conversa; todo o resto responde 404.
 */
@Controller()
export class TicketConversationsController {
  private readonly logger = new Logger("TicketConversations");

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(AssistantGate) private readonly gate: AssistantGate,
    @Optional() @Inject(PLACEMENT_TIMEOUTS) private readonly timeouts: PlacementTimeouts | null,
    @Inject(PlacementService) private readonly placementService: PlacementService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  @Post("projects/:projectId/ticket-conversations")
  @OwnTransactions()
  async open(
    @Tenant() tenant: TenantRunner,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(conversationMessageBodySchema)) body: z.output<typeof conversationMessageBodySchema>,
  ): Promise<ConversationDetail> {
    const { conversation: provider } = await this.gate.open(tenant);
    const groups = await tenant.run(async (tx, principal) => {
      await this.requireWritableProject(tx, principal, projectId);
      return this.scopeGroupTitles(tx, projectId, body.scopeId);
    });
    const turn = await this.ask(provider, { history: [{ author: "person", body: body.message }], draft: null, groups });
    return tenant.run(async (tx, principal) => {
      const project = await this.requireWritableProject(tx, principal, projectId);
      const created = await tx.ticketConversation.create({
        data: {
          orgId: project.orgId,
          projectId,
          authorPersonId: principal.person.id,
          draftTitle: turn.draft?.title ?? null,
          draftDescription: turn.draft?.description ?? null,
          ready: turn.ready,
        },
      });
      await this.appendMessages(tx, created, 0, body.message, turn);
      return this.detail(tx, created.id);
    });
  }

  @Post("ticket-conversations/:id/messages")
  @OwnTransactions()
  async message(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(conversationMessageBodySchema)) body: z.output<typeof conversationMessageBodySchema>,
  ): Promise<ConversationDetail> {
    const { conversation: provider } = await this.gate.open(tenant);
    const seen = await tenant.run(async (tx, principal) => {
      const { conversation } = await this.requireWritable(tx, principal, id);
      const messages = await tx.ticketConversationMessage.findMany({
        where: { conversationId: id },
        orderBy: { position: "asc" },
        select: { author: true, body: true },
      });
      const groups = await this.scopeGroupTitles(tx, conversation.projectId, body.scopeId);
      return { conversation, messages, groups };
    });
    const history = [
      ...seen.messages.map((m) => ({ author: m.author as "person" | "assistant", body: m.body })),
      { author: "person" as const, body: body.message },
    ];
    const current =
      seen.conversation.draftTitle === null
        ? null
        : { title: seen.conversation.draftTitle, description: seen.conversation.draftDescription ?? "" };
    const turn = await this.ask(provider, { history, draft: current, groups: seen.groups });
    return tenant.run(async (tx, principal) => {
      await tx.$queryRaw`select 1 from ticket_conversations where id = ${id}::uuid for update`; // serializa turnos concorrentes
      const { conversation } = await this.requireWritable(tx, principal, id);
      const count = await tx.ticketConversationMessage.count({ where: { conversationId: id } });
      if (count !== seen.messages.length) {
        throw new ConflictException({
          code: "conversation_changed",
          message: "A conversa mudou enquanto o assistente respondia. Recarregue e envie de novo.",
        });
      }
      await this.appendMessages(tx, conversation, count, body.message, turn);
      return this.detail(tx, id);
    });
  }

  @Patch("ticket-conversations/:id/draft")
  async draft(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(draftBodySchema)) body: z.output<typeof draftBodySchema>,
  ): Promise<ConversationDetail> {
    const { conversation } = await this.requireWritable(tx, principal, id);
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId: conversation.orgId, id } },
      data: { draftTitle: body.title, draftDescription: body.description },
    });
    return this.detail(tx, id);
  }

  @Post("ticket-conversations/:id/placement")
  @OwnTransactions()
  async placement(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(placementBodySchema.default({}))) body: z.output<typeof placementBodySchema>,
  ): Promise<z.output<typeof placementOutcomeSchema>> {
    const { judge, summarizer, affinity, namer } = await this.gate.open(tenant);
    const seen = await tenant.run(async (tx, principal) => {
      const { conversation } = await this.requireWritable(tx, principal, id);
      if (conversation.draftTitle === null) throw this.draftRequired();
      const [project, tickets, summaries] = await Promise.all([
        tx.project.findFirstOrThrow({ where: { id: conversation.projectId }, select: { name: true } }),
        tx.ticket.findMany({
          where: { projectId: conversation.projectId },
          select: { id: true, parentId: true, number: true, title: true, description: true },
        }),
        tx.branchSummary.findMany({ where: { projectId: conversation.projectId }, select: { ticketId: true, summary: true } }),
      ]);
      if (body.scopeId) this.requireScope(tickets.find((ticket) => ticket.id === body.scopeId));
      return {
        draft: { title: conversation.draftTitle, description: conversation.draftDescription ?? "" },
        snapshot: {
          projectId: conversation.projectId,
          projectName: project.name,
          tickets,
          summaries: new Map(summaries.map((s) => [s.ticketId, { summary: s.summary }])),
        },
      };
    });
    try {
      const recheck = (tx: TenantClient, principal: Principal) => this.requireWritable(tx, principal, id);
      const outcome = await this.placementService.search(seen.draft, seen.snapshot, {
        judge,
        summarizer,
        tenant,
        recheck,
        ...(body.scopeId ? { scopeId: body.scopeId } : {}),
        ...(this.timeouts?.descentMs ? { timeoutMs: this.timeouts.descentMs } : {}),
      });
      // A proposta tem prazo próprio e nunca derruba a procura: falha do provedor vira `unavailable` no resultado.
      const proposal = await this.placementService.propose(seen.draft, seen.snapshot, outcome, {
        affinity,
        namer,
        summarizer,
        tenant,
        recheck,
        ...(this.timeouts?.proposalMs ? { timeoutMs: this.timeouts.proposalMs } : {}),
      });
      return parseOutput(placementOutcomeSchema, { ...outcome, ...proposal });
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  /** Não chama provedor: funciona sem as chaves. Idempotente: cada conversa cria no máximo um ticket. */
  @Post("ticket-conversations/:id/ticket")
  async createTicket(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(createTicketBodySchema)) body: z.output<typeof createTicketBodySchema>,
  ): Promise<{ conversation: ConversationDetail; ticket: TicketDetail }> {
    // Serializa chamadas simultâneas: a segunda espera a primeira terminar e então vê o ticket criado.
    await tx.$queryRaw`select 1 from ticket_conversations where id = ${id}::uuid for update`;
    const conversation = await this.findOwn(tx, principal, id);
    const project = await this.requireWritableProject(tx, principal, conversation.projectId);
    if (conversation.status === "ticket_created" && conversation.createdTicketId) {
      return parseOutput(createdTicketSchema, {
        conversation: await this.detail(tx, id),
        ticket: await this.tickets.detail(tx, project, conversation.createdTicketId),
      });
    }
    if (conversation.status !== "open") {
      throw new ConflictException({ code: "conversation_closed", message: "A conversa já foi encerrada." });
    }
    if (conversation.draftTitle === null) throw this.draftRequired();
    const origin = { origin: "assistant", conversationId: id };
    let parentId = body.parentId;
    if (body.group) {
      this.authorization.editTicket(principal.actor, project.id);
      parentId = await this.tickets.createParentAndMove(tx, principal, project, body.parentId, body.group, origin);
    }
    const ticket = await this.tickets.create(
      tx,
      principal,
      project,
      {
        title: conversation.draftTitle,
        description: conversation.draftDescription ?? "",
        parentId,
        status: "todo",
        assigneeIds: [],
      },
      origin,
    );
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId: conversation.orgId, id } },
      data: { status: "ticket_created", createdTicketId: ticket.id, closedAt: new Date() },
    });
    return parseOutput(createdTicketSchema, { conversation: await this.detail(tx, id), ticket });
  }

  @Get("ticket-conversations")
  async list(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Query("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<ConversationSummary[]> {
    await this.findVisibleProject(tx, principal, projectId);
    const rows = await tx.ticketConversation.findMany({
      where: { projectId, authorPersonId: principal.person.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return rows.map(toSummary);
  }

  @Get("ticket-conversations/:id")
  async get(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<ConversationDetail> {
    const conversation = await this.findOwn(tx, principal, id);
    await this.findVisibleProject(tx, principal, conversation.projectId);
    return this.detail(tx, id);
  }

  @Delete("ticket-conversations/:id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    const conversation = await this.findOwn(tx, principal, id);
    await this.findVisibleProject(tx, principal, conversation.projectId);
    await tx.ticketConversation.delete({ where: { orgId_id: { orgId: conversation.orgId, id } } });
  }

  // ---- regras ---------------------------------------------------------------------------------------------

  /** Qualquer ticket do projeto da conversa serve de escopo (ADR 0034); de outro projeto ou organização (pela RLS): o mesmo 404. */
  private requireScope(scope: unknown): void {
    if (!scope) throw new NotFoundException("Ticket de escopo não encontrado.");
  }

  /**
   * Os títulos dos filhos que têm filhos do lugar da procura (ADR 0033, 0034): filhos diretos do escopo, ou da raiz do
   * projeto sem escopo; no máximo 30, na ordem do número. Confere o escopo como a procura. Só títulos, nenhum id.
   */
  private async scopeGroupTitles(tx: TenantClient, projectId: string, scopeId: string | null | undefined): Promise<string[]> {
    if (scopeId) {
      this.requireScope(await tx.ticket.findFirst({ where: { id: scopeId, projectId }, select: { id: true } }));
    }
    const rows = await tx.ticket.findMany({
      where: { projectId, parentId: scopeId ?? null, children: { some: {} } },
      orderBy: { number: "asc" },
      take: MAX_GROUP_TITLES,
      select: { title: true },
    });
    return rows.map((row) => row.title);
  }

  private draftRequired(): ConflictException {
    return new ConflictException({ code: "draft_required", message: "A conversa ainda não tem rascunho." });
  }

  private async ask(provider: ConversationProvider, input: Parameters<ConversationProvider["turn"]>[0]): Promise<ConversationTurn> {
    try {
      return await provider.turn(input);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  /** Inexistente, de outra pessoa ou de outra organização (RLS): o mesmo 404. */
  private async findOwn(tx: TenantClient, { person }: Principal, id: string): Promise<ConversationRow> {
    const conversation = await tx.ticketConversation.findFirst({ where: { id, authorPersonId: person.id } });
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return conversation;
  }

  private async findVisibleProject(tx: TenantClient, { actor }: Principal, projectId: string): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  /** Visível (404), pode criar ticket (403) e não arquivado (409). */
  private async requireWritableProject(tx: TenantClient, principal: Principal, projectId: string): Promise<ProjectRow> {
    const project = await this.findVisibleProject(tx, principal, projectId);
    this.authorization.createTicket(principal.actor, projectId);
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
    return project;
  }

  /** Conversa própria, projeto visível e liberado para escrita, e conversa ainda aberta. */
  private async requireWritable(tx: TenantClient, principal: Principal, id: string) {
    const conversation = await this.findOwn(tx, principal, id);
    const project = await this.requireWritableProject(tx, principal, conversation.projectId);
    if (conversation.status !== "open") {
      throw new ConflictException({ code: "conversation_closed", message: "A conversa já foi encerrada." });
    }
    return { conversation, project };
  }

  private async appendMessages(
    tx: TenantClient,
    conversation: Pick<ConversationRow, "orgId" | "id">,
    existing: number,
    personText: string,
    turn: ConversationTurn,
  ): Promise<void> {
    const { orgId, id: conversationId } = conversation;
    await tx.ticketConversationMessage.createMany({
      data: [
        { orgId, conversationId, position: existing + 1, author: "person", body: personText },
        { orgId, conversationId, position: existing + 2, author: "assistant", body: turn.message, model: turn.model },
      ],
    });
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId, id: conversationId } },
      data: {
        ready: turn.ready,
        // `null` da IA mantém o rascunho anterior (inclusive o editado à mão pela pessoa).
        ...(turn.draft ? { draftTitle: turn.draft.title, draftDescription: turn.draft.description } : {}),
      },
    });
  }

  private async detail(tx: TenantClient, id: string): Promise<ConversationDetail> {
    const row = await tx.ticketConversation.findFirstOrThrow({
      where: { id },
      include: { messages: { orderBy: { position: "asc" } } },
    });
    return parseOutput(conversationDetailSchema, {
      ...toSummary(row),
      messages: row.messages.map((m) => ({
        id: m.id,
        author: m.author,
        body: m.body,
        model: m.model,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  }
}
