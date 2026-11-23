import { ideaRootsOf, mentionedKeys, scanTicketKeys } from "@treepm/domain";
import type { IdeaStage, TicketStatus } from "@treepm/domain";
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
  previewSchema,
} from "./conversations.schema.js";
import type { ConversationDetail, ConversationSummary } from "./conversations.schema.js";
import { buildRequestQuote, withRequestQuote } from "./request-quote.js";
import { PlacementService } from "./placement.service.js";
import { AssistantGate } from "./assistant-gate.js";
import { AssistantUnavailableError, PLACEMENT_TIMEOUTS } from "./ports.js";
import type { ConversationDraft, ConversationProvider, ConversationTurn, DraftChild, PlacementTimeouts } from "./ports.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { MAX_TICKET_DESCRIPTION } from "../tickets/tickets.schema.js";
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
  draftChildren: unknown;
  draftIdea: boolean;
  ready: boolean;
  createdTicketId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Os filhos guardados do rascunho (JSON validado pelo banco e por quem grava); ausente = nenhum. */
const childrenOf = (row: { draftChildren: unknown }): DraftChild[] =>
  Array.isArray(row.draftChildren) ? (row.draftChildren as DraftChild[]).map(({ title, description }) => ({ title, description })) : [];

/**
 * O texto que a procura do lugar usa (ADR 0044): a descrição do pai e, com filhos, a lista dos títulos deles. A citação do
 * pedido nunca entra (ela só é montada na criação), então nada fica duplicado. A procura roda uma vez, para o pai.
 */
const placementDraft = (row: ConversationRow): { title: string; description: string } => {
  const description = row.draftDescription ?? "";
  const titles = childrenOf(row).map((child) => `- ${child.title}`);
  if (titles.length === 0) return { title: row.draftTitle ?? "", description };
  const parts = `Partes:\n${titles.join("\n")}`;
  return { title: row.draftTitle ?? "", description: description === "" ? parts : `${description}\n\n${parts}` };
};

/** O rascunho da conversa, ou `null` se ainda não há. */
const draftOf = (row: ConversationRow): { title: string; description: string; children: DraftChild[]; idea: boolean } | null =>
  row.draftTitle === null ? null : { title: row.draftTitle, description: row.draftDescription ?? "", children: childrenOf(row), idea: row.draftIdea };

/** O que vai ao provedor: sem `children` quando o rascunho é um ticket só, como antes da ADR 0044; `idea` sempre, para a IA ver o que a pessoa ligou ou desligou à mão. */
const draftForProvider = (row: ConversationRow): ConversationDraft | null => {
  const draft = draftOf(row);
  if (draft === null) return null;
  return {
    title: draft.title,
    description: draft.description,
    ...(draft.children.length > 0 ? { children: draft.children } : {}),
    idea: draft.idea,
  };
};

const asStatus = (row: { status: string }) => row.status as ConversationSummary["status"];

function toSummary(row: ConversationRow): ConversationSummary {
  return parseOutput(conversationSummarySchema, {
    id: row.id,
    projectId: row.projectId,
    status: asStatus(row),
    draft: draftOf(row),
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
          ...(turn.draft ? { draftChildren: [...(turn.draft.children ?? [])], draftIdea: turn.draft.idea === true } : {}),
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
    const current = draftForProvider(seen.conversation);
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
      data: {
        draftTitle: body.title,
        draftDescription: body.description,
        // Sem `children` no corpo, os filhos ficam como estão; a lista nova (inclusive vazia) substitui a anterior.
        ...(body.children ? { draftChildren: body.children } : {}),
        // Sem `idea` no corpo, a opção fica como está.
        ...(body.idea !== undefined ? { draftIdea: body.idea } : {}),
      },
    });
    return this.detail(tx, id);
  }

  /**
   * O que a criação vai gravar, sem criar nada (ADR 0044): a descrição já com a citação do pedido, os filhos, e o que a
   * criação recusaria (chaves que não existem, tamanho). Não chama provedor.
   */
  @Get("ticket-conversations/:id/preview")
  async preview(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<z.output<typeof previewSchema>> {
    const conversation = await this.findOwn(tx, principal, id);
    const project = await this.findVisibleProject(tx, principal, conversation.projectId);
    if (conversation.draftTitle === null) throw this.draftRequired();
    const built = await this.assemble(tx, project, conversation);
    return parseOutput(previewSchema, {
      title: built.title,
      description: built.description,
      quote: built.quote,
      children: built.children,
      idea: conversation.draftIdea,
      unknownKeys: built.unknownKeys,
      descriptionTooLong: built.description.length > MAX_TICKET_DESCRIPTION,
    });
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
      const [project, allTickets, summaries] = await Promise.all([
        tx.project.findFirstOrThrow({ where: { id: conversation.projectId }, select: { name: true } }),
        tx.ticket.findMany({
          where: { projectId: conversation.projectId },
          select: { id: true, parentId: true, number: true, title: true, description: true, status: true, ideaStage: true },
        }),
        tx.branchSummary.findMany({ where: { projectId: conversation.projectId }, select: { ticketId: true, summary: true } }),
      ]);
      // Uma ideia (a raiz e o que está dentro) não é lugar para um ticket novo: não entra na procura (ADR 0043).
      const inIdea = ideaRootsOf(allTickets.map((t) => ({ id: t.id, parentId: t.parentId, status: t.status as TicketStatus, ideaStage: (t.ideaStage ?? null) as IdeaStage | null })));
      const tickets = allTickets.filter((t) => !inIdea.has(t.id)).map(({ id, parentId, number, title, description }) => ({ id, parentId, number, title, description }));
      if (body.scopeId) this.requireScope(tickets.find((ticket) => ticket.id === body.scopeId));
      return {
        draft: placementDraft(conversation),
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
        children: await this.createdChildren(tx, project, id, conversation.createdTicketId),
      });
    }
    if (conversation.status !== "open") {
      throw new ConflictException({ code: "conversation_closed", message: "A conversa já foi encerrada." });
    }
    if (conversation.draftTitle === null) throw this.draftRequired();
    // ADR 0045: criar pai, filhos e agrupador muda a estrutura. A trava vem antes de ler a ideia que contém o lugar escolhido.
    await this.tickets.lockStructure(tx, project.id);
    // Ideia (ADR 0044, adendo): o pai nasce como ideia pelo mesmo caminho da tela, com a mesma permissão. Num lugar que já está
    // dentro de uma ideia, o que nasce faz parte dela, sem estágio próprio, e a opção não pede permissão nenhuma.
    const asIdea = conversation.draftIdea && (await this.tickets.ideaRootFor(tx, body.parentId)) === null;
    if (asIdea) this.authorization.registerIdea(principal.actor, project.id);
    const built = await this.assemble(tx, project, conversation);
    this.requireFits(built);
    if (built.unknownKeys.length > 0) {
      throw new ConflictException({
        code: "unknown_ticket_keys",
        message: `A descrição cita tickets que não existem neste projeto: ${built.unknownKeys.join(", ")}. Corrija a conversa e confirme de novo.`,
        details: { keys: built.unknownKeys },
      });
    }
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
        title: built.title,
        description: built.description,
        parentId,
        status: "todo",
        assigneeIds: [],
        ...(asIdea ? { idea: true } : {}),
      },
      origin,
    );
    // Os filhos nascem dentro do pai, na ordem do rascunho, na mesma transação da rota: falhou um, não existe nenhum.
    const kids: TicketDetail[] = [];
    for (const child of built.children) {
      kids.push(await this.tickets.create(tx, principal, project, { title: child.title, description: child.description, parentId: ticket.id, status: "todo", assigneeIds: [] }, origin));
    }
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId: conversation.orgId, id } },
      data: { status: "ticket_created", createdTicketId: ticket.id, closedAt: new Date() },
    });
    return parseOutput(createdTicketSchema, {
      conversation: await this.detail(tx, id),
      // Com filhos, o pai é lido de novo: o progresso e a contagem dele mudam quando os filhos nascem.
      ticket: kids.length > 0 ? await this.tickets.detail(tx, project, ticket.id) : ticket,
      children: kids,
    });
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

  /**
   * O que será gravado (ADR 0044): o título e a descrição do pai com a citação do pedido na frente (as mensagens da pessoa
   * naquela conversa, na ordem, como ela as escreveu), os filhos, e as chaves de ticket da parte escrita pela IA que não
   * existem no projeto. Chaves que a própria pessoa escreveu em alguma mensagem não são recusadas, nem quando a IA as repete.
   */
  private async assemble(tx: TenantClient, project: ProjectRow, conversation: ConversationRow) {
    const messages = (
      await tx.ticketConversationMessage.findMany({
        where: { conversationId: conversation.id, author: "person" },
        orderBy: { position: "asc" },
        select: { body: true },
      })
    ).map((message) => message.body);
    const aiDescription = conversation.draftDescription ?? "";
    const children = childrenOf(conversation);
    const personKeys = new Set(messages.flatMap((message) => scanTicketKeys(message).map((match) => match.key)));
    const prefix = `${project.key}-`;
    const cited = [...new Set([aiDescription, ...children.map((child) => child.description)].flatMap((text) => mentionedKeys(text)))].filter(
      (key) => key.startsWith(prefix) && !personKeys.has(key),
    );
    const numbers = cited.map((key) => ({ key, number: Number(key.slice(prefix.length)) }));
    const existing = new Set(
      numbers.length === 0
        ? []
        : (
            await tx.ticket.findMany({
              where: { projectId: project.id, number: { in: numbers.filter((entry) => entry.number <= 2_147_483_647).map((entry) => entry.number) } },
              select: { number: true },
            })
          ).map((row) => row.number),
    );
    return {
      title: conversation.draftTitle ?? "",
      description: withRequestQuote(messages, aiDescription),
      quote: buildRequestQuote(messages),
      aiDescription,
      children,
      unknownKeys: numbers.filter((entry) => !existing.has(entry.number)).map((entry) => entry.key),
    };
  }

  /** Nunca corta o texto da pessoa: a citação fica inteira e a criação é recusada, pedindo para encurtar a parte da IA. */
  private requireFits(built: { quote: string; description: string }): void {
    if (built.quote.length > MAX_TICKET_DESCRIPTION) {
      throw new ConflictException({
        code: "request_too_long",
        message: "O pedido da pessoa, citado inteiro no ticket, já passa do tamanho máximo da descrição. Divida o pedido em conversas menores.",
        details: { max: MAX_TICKET_DESCRIPTION, quoteLength: built.quote.length },
      });
    }
    if (built.description.length > MAX_TICKET_DESCRIPTION) {
      throw new ConflictException({
        code: "description_too_long",
        message: "A citação do pedido mais a descrição passam do tamanho máximo. Encurte a descrição escrita pelo assistente; o pedido original nunca é cortado.",
        details: { max: MAX_TICKET_DESCRIPTION, length: built.description.length, quoteLength: built.quote.length },
      });
    }
  }

  /** Os filhos que esta conversa criou sob o pai (já criada antes), na ordem do número: lidos do histórico, que guarda a conversa. */
  private async createdChildren(tx: TenantClient, project: ProjectRow, conversationId: string, parentId: string): Promise<TicketDetail[]> {
    const events = await tx.activityEvent.findMany({
      where: { kind: "ticket.created", payload: { path: ["conversationId"], equals: conversationId } },
      select: { subjectId: true },
    });
    const ids = events.map((event) => event.subjectId).filter((subjectId) => subjectId !== parentId);
    if (ids.length === 0) return [];
    const rows = await tx.ticket.findMany({ where: { id: { in: ids }, parentId }, orderBy: { number: "asc" }, select: { id: true } });
    const details: TicketDetail[] = [];
    for (const row of rows) details.push(await this.tickets.detail(tx, project, row.id));
    return details;
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
        ...(turn.draft
          ? {
              draftTitle: turn.draft.title,
              draftDescription: turn.draft.description,
              draftChildren: [...(turn.draft.children ?? [])],
              // Uma IA que não manda `idea` mantém a opção como está.
              ...(turn.draft.idea !== undefined ? { draftIdea: turn.draft.idea } : {}),
            }
          : {}),
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
