import { descriptionExcerpt, mentionedKeys, scanTicketKeys } from "@treepm/domain";
import type { FusionRule } from "@treepm/domain";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
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
  elaborationOutcomeSchema,
  placementBodySchema,
  placementOutcomeSchema,
  draftBodySchema,
  previewSchema,
} from "./conversations.schema.js";
import type { ConversationDetail, ConversationSummary } from "./conversations.schema.js";
import { buildRequestQuote, suggestedDescription, withRequestQuote } from "./request-quote.js";
import { forbiddenQuoteText, normalizeTitle, sanitizeElaboration } from "./elaboration.js";
import { ELABORATION_TIMEOUT_MS } from "./claude-ticket-elaborator.js";
import { loadPlacementTree } from "./branch-tree.js";
import { decisionOf, errorCode, handDecisionToTicket, readDecisionSafely, recordPlacedBy, saveDecision } from "./placement-decision.js";
import type { DecisionExtras, DoubtRecord, PlacementDecisionRecord } from "./placement-decision.js";
import { buildQuestion } from "./placement-question.js";
import type { PlacementQuestion } from "./placement-question.js";
import { relatedListing } from "./related-placement.js";
import { runPlacement } from "./placement-run.js";
import { linkExistingSuggestions, SUGGESTED_LOOKUP_TIMEOUT_MAX_MS } from "./suggested-links.js";
import { SEMANTIC_TRIAGE_DEADLINE_MS, semanticSearchOf } from "./semantic-triage.js";
import type { SemanticSearch } from "./semantic-triage.js";
import { embeddingStoreOf } from "./ticket-embeddings.js";
import type { LookupOutcome } from "./suggested-links.js";
import type { LinkLookupResult, LookupTicket } from "./suggested-links.js";
import type { PlacementOutcome } from "./placement-search.js";
import { PlacementService } from "./placement.service.js";
import { CreationThreads } from "./creation-threads.js";
import { TicketDraftService, childrenOf, draftMarkOf, requireScope } from "./ticket-draft.service.js";
import type { ConversationRow } from "./ticket-draft.service.js";
import { AssistantGate } from "./assistant-gate.js";
import { AssistantUnavailableError, PLACEMENT_TIMEOUTS } from "./ports.js";
import type { ConversationDraft, DraftChild, ElaborationLink, ElaborationSuggestion, ExistingMatcher, PlacementTimeouts } from "./ports.js";
import { QueuesStructure } from "../tickets/structure-queue.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { MAX_TICKET_DESCRIPTION } from "../tickets/tickets.schema.js";
import type { TicketDetail } from "../tickets/tickets.schema.js";
import type { ProjectRow } from "../tickets/tickets.service.js";


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
    @Inject(TicketDraftService) private readonly drafts: TicketDraftService,
    @Inject(CreationThreads) private readonly threads: CreationThreads,
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
      await this.drafts.requireWritableProject(tx, principal, projectId);
      return this.drafts.scopeGroupTitles(tx, projectId, body.scopeId);
    });
    const turn = await this.drafts.ask(provider, { history: [{ author: "person", body: body.message }], draft: null, groups });
    return tenant.run(async (tx, principal) => {
      const project = await this.drafts.requireWritableProject(tx, principal, projectId);
      const created = await this.drafts.create(tx, principal, project, body.message, turn);
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
      const { conversation } = await this.requireWritable(tx, principal, id, { reopens: true });
      const messages = await tx.ticketConversationMessage.findMany({
        where: { conversationId: id },
        orderBy: { position: "asc" },
        select: { author: true, body: true },
      });
      const groups = await this.drafts.scopeGroupTitles(tx, conversation.projectId, body.scopeId);
      return { conversation, messages, groups };
    });
    const history = [
      ...seen.messages.map((m) => ({ author: m.author as "person" | "assistant", body: m.body })),
      { author: "person" as const, body: body.message },
    ];
    const current = draftForProvider(seen.conversation);
    const turn = await this.drafts.ask(provider, { history, draft: current, groups: seen.groups });
    return tenant.run(async (tx, principal) => {
      await tx.$queryRaw`select 1 from ticket_conversations where id = ${id}::uuid for update`; // serializa turnos concorrentes
      const { conversation } = await this.requireWritable(tx, principal, id, { reopens: true });
      const count = await tx.ticketConversationMessage.count({ where: { conversationId: id } });
      if (count !== seen.messages.length) {
        throw new ConflictException({
          code: "conversation_changed",
          message: "A conversa mudou enquanto o assistente respondia. Recarregue e envie de novo.",
        });
      }
      await this.drafts.appendMessages(tx, conversation, count, body.message, turn);
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
    const { conversation } = await this.requireWritable(tx, principal, id, { reopens: true });
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
    const project = await this.drafts.findVisibleProject(tx, principal, conversation.projectId);
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
    const { judge, affinity, related, namer, embedder, semantic: settings, doubt: doubtConfig } = await this.gate.open(tenant);
    const seen = await tenant.run(async (tx, principal) => {
      const { conversation } = await this.requireWritable(tx, principal, id, { reopens: true });
      if (conversation.draftTitle === null) throw this.draftRequired();
      const [project, tree] = await Promise.all([
        tx.project.findFirstOrThrow({ where: { id: conversation.projectId }, select: { name: true, key: true } }),
        loadPlacementTree(tx, conversation.projectId),
      ]);
      const { tickets } = tree;
      // Conversa que nasceu no chat de um ticket (ADR 0056, item 5): sem escopo nem ponto de partida no corpo, a procura começa por esse ticket
      // (`scopeId`: ela julga se o pedido cabe ali e, se não cabe, procura no projeto todo). `scopeId: null` no corpo continua sendo o projeto inteiro.
      // A origem só vale como ponto de partida se estiver na árvore viva (ideia, cancelado ou embaixo de um: projeto inteiro).
      const found = body.scopeId === undefined && body.startId === undefined ? await this.threads.origin(tx, id) : null;
      const origin = found !== null && tickets.some((ticket) => ticket.id === found) ? found : null;
      const scopeId = origin ?? body.scopeId ?? null;
      if (scopeId) requireScope(tickets.find((ticket) => ticket.id === scopeId));
      this.requireStart(tickets, body.startId, scopeId);
      return {
        scopeId,
        draft: placementDraft(conversation),
        triage: { title: conversation.draftTitle, description: conversation.draftDescription ?? "", partTitles: childrenOf(conversation).map((child) => child.title) },
        projectKey: project.key,
        projectName: project.name,
        mark: draftMarkOf(conversation),
        snapshot: {
          projectId: conversation.projectId,
          tickets,
          notes: tree.notes,
        },
      };
    });
    const startId = body.startId ?? null;
    try {
      // Os relacionados (de baixo para cima) e a descida (de cima para baixo) andam juntos, e o lugar e a dúvida saem do mesmo núcleo
      // que a categorização do lote do Linear usa (`runPlacement`); só a descida pode derrubar a procura.
      const run = await runPlacement(this.placementService, {
        snapshot: seen.snapshot,
        draft: seen.draft,
        triage: seen.triage,
        judge,
        related,
        doubt: doubtConfig,
        // O passo de vetor (ADR 0053): o `embedder` é `null` sem chave; o projeto é o da conversa, já conferido por `requireWritable`.
        semantic: semanticSearchOf(embeddingStoreOf(tenant), embedder, seen.snapshot.projectId, settings),
        fusion: settings.mode === "interleave" ? "interleave" : "rrf",
        scopeId: seen.scopeId,
        startId,
        timeouts: this.timeouts,
      });
      const { rule, choice, picked, found, nodes } = run;
      let outcome = run.outcome;
      const listing = relatedListing(seen.snapshot.tickets, seen.projectKey, picked.related, picked.duplicate?.id ?? null);
      const doubt = run.doubt;
      let question: PlacementQuestion | null = null;
      if (doubt) {
        const step = outcome.trace.steps.find((candidate) => candidate.parentId === doubt?.parentId);
        const unjudged = seen.snapshot.tickets.filter((t) => t.parentId === doubt?.parentId && seen.snapshot.tickets.some((k) => k.parentId === t.id)).map((t) => t.id);
        question = buildQuestion({ doubt, stepCandidates: doubt.kind === "related" ? [] : (step?.candidates ?? []), choice, unjudged, byId: nodes, projectName: seen.projectName });
      }
      // A proposta de agrupador (feita sobre o palpite, como antes da ADR 0054) vem antes de a pergunta marcar o destino como incerto.
      const proposalBase = outcome;
      if (question) outcome = { ...outcome, uncertain: true };
      // A proposta tem prazo próprio e nunca derruba a procura: falha do provedor vira `unavailable` no resultado.
      const proposal = await this.placementService.propose(seen.draft, seen.snapshot, proposalBase, {
        affinity,
        namer,
        ...(picked.duplicate ? { excludeIds: [picked.duplicate.id] } : {}),
        ...(this.timeouts?.proposalMs ? { timeoutMs: this.timeouts.proposalMs } : {}),
      });
      const { trace, ...shown } = outcome;
      const record: DoubtRecord = {
        draftMark: seen.mark,
        confirmed: question === null,
        startId,
        question: question && { level: question.level, kind: question.kind, parentId: question.at.id, options: question.options.map((o) => ({ ticketId: o.id, number: nodes.get(o.id)?.number ?? 0, probability: o.probability })) },
      };
      const kept = await this.keepDecision(tenant, id, seen.snapshot, { ...shown, trace }, { related: picked.related, duplicateId: picked.duplicate?.id ?? null, rule, triage: found.triage ?? null, doubt: record });
      // Sem a decisão guardada a criação por `search` seria recusada (409): a resposta não confirma nada nem pergunta, e a tela pede que a pessoa confirme o lugar.
      return parseOutput(placementOutcomeSchema, { ...shown, ...proposal, ...listing, question: kept ? question : null, destinationConfirmed: kept && question === null });
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  /**
   * `placedBy: "search"` (ADR 0054, adendo): o `parentId` tem de ser o destino confirmado (sem pergunta aberta) da decisão guardada, e a
   * marca do rascunho tem de bater com o rascunho de agora. Sem decisão, sem marca ou com outra coisa: 409 `placement_stale` e a tela
   * procura de novo. A raiz nunca é destino confirmado por procura.
   */
  private async requireConfirmedSearch(tx: TenantClient, id: string, conversation: ConversationRow, parentId: string | null): Promise<void> {
    const stored = await readDecisionSafely(tx, id);
    const confirmed = stored?.doubt?.confirmed === true && stored.doubt.draftMark === draftMarkOf(conversation) ? (stored.chosenPath.at(-1) ?? null) : undefined;
    if (confirmed === undefined || confirmed === null || confirmed !== parentId) {
      throw new ConflictException({ code: "placement_stale", message: "A procura do lugar não vale mais para este rascunho ou não confirmou este destino: procure de novo." });
    }
  }

  /** `startId`: ticket vivo do projeto (a árvore da procura não tem ideia nem cancelado) e dentro do escopo, se houver. Senão, 400. */
  private requireStart(tickets: readonly { id: string; parentId: string | null }[], startId: string | undefined, scopeId: string | null): void {
    if (startId === undefined) return;
    const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    let inside = scopeId === null;
    for (let at = byId.get(startId); at && !inside; at = at.parentId === null ? undefined : byId.get(at.parentId)) inside = at.id === scopeId;
    if (!byId.has(startId) || !inside) throw new BadRequestException({ code: "invalid_start", message: "O ramo de partida não existe neste projeto, não está vivo ou está fora do escopo." });
  }

  /**
   * Guarda a decisão da procura (ADR 0052, item 5): só ids e números. Nunca derruba a procura: se a conversa mudou durante a descida
   * (fechada, apagada, permissão perdida) ou a gravação falha, o aviso vai ao registro e devolve `false` (também quando só a decisão sem a dúvida coube no banco); a resposta então não confirma
   * o destino nem faz pergunta (ADR 0054, adendo), porque a criação por `search` depende desta decisão.
   */
  private async keepDecision(tenant: TenantRunner, id: string, snapshot: { projectId: string; tickets: readonly { id: string; number: number }[] }, outcome: Pick<PlacementOutcome, "uncertain" | "trace">, extras: DecisionExtras): Promise<boolean> {
    try {
      const record = decisionOf(outcome, new Map(snapshot.tickets.map((t) => [t.id, t.number])), extras);
      const withDoubt = await tenant.run(async (tx, principal) => {
        await this.requireWritable(tx, principal, id, { reopens: true });
        return saveDecision(tx, { orgId: principal.organization.orgId, projectId: snapshot.projectId, conversationId: id, record });
      });
      // Banco sem a coluna `triage`: a decisão ficou sem a dúvida e a criação por `search` seria recusada, como se não tivesse sido guardada.
      if (!withDoubt) this.logger.warn("decisão da procura guardada sem a dúvida (coluna triage ausente)");
      return withDoubt;
    } catch (error) {
      this.logger.warn(`decisão da procura não guardada codigo=${errorCode(error)}`);
      return false;
    }
  }

  /** A decisão guardada da última procura da conversa (ADR 0052): só ids e números; `null` se ainda não houve procura. */
  @Get("ticket-conversations/:id/placement-decision")
  async placementDecision(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<{ decision: PlacementDecisionRecord | null }> {
    const conversation = await this.findOwn(tx, principal, id);
    await this.drafts.findVisibleProject(tx, principal, conversation.projectId);
    return { decision: await readDecisionSafely(tx, id) };
  }

  /**
   * As ligações e as tarefas que o pedido implica (ADR 0052, item 4). Lê o rascunho guardado e os relacionados da última procura
   * (a decisão guardada: só ids e números, nada é refeito nem custa outra chamada ao Jev). Nunca derruba nada: sem provedor, sem
   * aceite ou com erro do modelo, devolve listas vazias com o motivo, e a criação do ticket segue normal. O que o modelo devolve
   * passa por `sanitizeElaboration`; nada é gravado aqui.
   */
  @Post("ticket-conversations/:id/elaboration")
  @OwnTransactions()
  async elaboration(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<z.output<typeof elaborationOutcomeSchema>> {
    const empty = (unavailable: "not_configured" | "consent_required" | "unavailable") => parseOutput(elaborationOutcomeSchema, { links: [], suggested: [], unavailable });
    // O portão do aceite vem antes de ler rascunho e tickets, como nas outras rotas do assistente.
    let providers;
    try {
      providers = await this.gate.open(tenant);
    } catch (error) {
      const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined;
      if (code === "assistant_not_configured") return empty("not_configured");
      if (code === "assistant_consent_required") return empty("consent_required");
      throw error;
    }
    const seen = await tenant.run(async (tx, principal) => {
      const { conversation, project } = await this.requireWritable(tx, principal, id);
      if (conversation.draftTitle === null) throw this.draftRequired();
      const decision = await readDecisionSafely(tx, id);
      // O que mudou depois da procura (virou ideia, foi cancelado, com a subárvore) não vai ao modelo nem vira ligação.
      const liveTree = (await loadPlacementTree(tx, conversation.projectId)).tickets;
      const live = new Set(liveTree.map((ticket) => ticket.id));
      const ids = (decision?.related ?? []).map((entry) => entry.ticketId).filter((ticketId) => live.has(ticketId));
      const rows = ids.length === 0 ? [] : await tx.ticket.findMany({ where: { id: { in: ids }, projectId: conversation.projectId }, select: { id: true, number: true, title: true, description: true, status: true } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const related = ids.flatMap((ticketId) => {
        const row = byId.get(ticketId);
        return row ? [{ id: row.id, key: `${project.key}-${row.number}`, title: row.title, excerpt: descriptionExcerpt(row.description), status: row.status }] : [];
      });
      // O duplicado sai da árvore viva (já lida), não só dos relacionados: a procura das sugeridas também o evita.
      const duplicate = decision?.duplicateTicketId ? liveTree.find((ticket) => ticket.id === decision.duplicateTicketId) : undefined;
      // O lugar escolhido e os ancestrais dele (a decisão guardada): nenhuma ligação vai a eles.
      const pathIds = new Set(decision?.chosenPath ?? []);
      const path = liveTree.filter((ticket) => pathIds.has(ticket.id));
      return {
        ancestorKeys: new Set(path.map((ticket) => `${project.key}-${ticket.number}`)),
        excludeIds: new Set(path.map((ticket) => ticket.id)),
        draft: { title: conversation.draftTitle, description: conversation.draftDescription ?? "", parts: childrenOf(conversation) },
        related,
        duplicateKey: duplicate ? `${project.key}-${duplicate.number}` : null,
        projectKey: project.key,
        projectId: conversation.projectId,
        // A mesma leitura da árvore viva: a procura das tarefas sugeridas não lê mais nada do banco.
        tree: liveTree.map(({ id: ticketId, number, title, description, status }) => ({ id: ticketId, number, title, description, status })),
      };
    });
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeouts?.elaborationMs ?? ELABORATION_TIMEOUT_MS);
    try {
      const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("timeout"))));
      // Só chave, título, trecho e situação vão ao modelo: nenhum id.
      const sent = seen.related.map(({ key, title, excerpt, status }) => ({ key, title, excerpt, status }));
      const answer = await Promise.race([providers.elaborator.elaborate({ draft: seen.draft, related: sent }, { signal: controller.signal }), timedOut]);
      const claudeMs = Date.now() - started;
      const clean = sanitizeElaboration(answer, {
        draftTitle: seen.draft.title,
        partTitles: seen.draft.parts.map((part) => part.title),
        related: sent,
        duplicateKey: seen.duplicateKey,
        projectKey: seen.projectKey,
        ancestorKeys: seen.ancestorKeys,
      });
      // Tarefa sugerida que já existe na árvore vira ligação (ADR 0052, item 4). Falha ou prazo nunca derrubam a elaboração.
      const lookupStarted = Date.now();
      const found = await this.linkSuggested(providers.elaborator, seen, clean, started, semanticSearchOf(embeddingStoreOf(tenant), providers.embedder, seen.projectId, providers.semantic), providers.semantic.mode === "interleave" ? "interleave" : "rrf");
      const lookupMs = Date.now() - lookupStarted;
      const diagnostics = {
        model: { links: answer.links.length, suggested: answer.suggested.length },
        dropped: clean.dropped,
        lookups: found.lookups,
        timingsMs: { claude: claudeMs, lookup: lookupMs, secondCall: found.matchMs },
        ...(found.semantic ? { semantic: found.semantic } : {}),
      };
      // Só contagens e códigos: nunca texto do rascunho, de ticket nem do modelo.
      const tally = (counts: Record<string, number>): string => Object.entries(counts).map(([name, n]) => `${name}=${n}`).join(",");
      const outcomes: Record<string, number> = {};
      for (const lookup of found.lookups) outcomes[lookup.outcome] = (outcomes[lookup.outcome] ?? 0) + 1;
      this.logger.log(
        `elaboração diagnóstico modelo_ligacoes=${diagnostics.model.links} modelo_sugeridas=${diagnostics.model.suggested} descartes_ligacoes=${tally(clean.dropped.links)} descartes_sugeridas=${tally(clean.dropped.suggested)} procura=${tally(outcomes) || "nenhuma"} ms_claude=${claudeMs} ms_procura=${lookupMs} ms_segunda=${found.matchMs}${found.semantic ? ` vetor_sincronizados=${found.semantic.synced} vetor_gravados=${found.semantic.embedded} vetor_pendentes=${found.semantic.pending} ms_vetor=${found.semantic.syncMs + found.semantic.queryMs} vetor_falha=${found.semantic.failure ?? "nenhuma"}` : ""}`,
      );
      const titleOf = new Map([...sent.map((entry) => [entry.key, entry.title] as const), ...found.titles]);
      return parseOutput(elaborationOutcomeSchema, {
        links: found.links.map((link) => ({ ...link, ...(link.de === "pai" ? {} : { deTitle: seen.draft.parts[link.de]?.title ?? "" }), dependeDeTitle: titleOf.get(link.dependeDe) ?? "" })),
        suggested: found.suggested,
        unavailable: null,
        diagnostics,
      });
    } catch (error) {
      // Só o motivo vai ao registro: nunca texto do rascunho nem do modelo.
      this.logger.warn(`elaboração indisponível motivo=${error instanceof AssistantUnavailableError ? error.reason : errorCode(error)}`);
      return empty("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A procura das tarefas sugeridas na árvore (`linkExistingSuggestions`) com o prazo que sobrou da elaboração, limitado a
   * `SUGGESTED_LOOKUP_TIMEOUT_MAX_MS`. Nunca lança: qualquer falha devolve o que veio, com o motivo (sem texto) no registro.
   */
  private async linkSuggested(
    matcher: ExistingMatcher,
    seen: { draft: { title: string }; related: readonly { key: string }[]; duplicateKey: string | null; projectKey: string; tree: readonly LookupTicket[]; excludeIds: ReadonlySet<string> },
    clean: { links: ElaborationLink[]; suggested: ElaborationSuggestion[] },
    started: number,
    semantic: SemanticSearch,
    fusion: FusionRule,
  ): Promise<LinkLookupResult> {
    const untouched = (outcome: LookupOutcome | null): LinkLookupResult => ({
      links: clean.links,
      suggested: clean.suggested,
      titles: new Map(),
      failed: 0,
      lookups: outcome === null ? [] : clean.suggested.map(() => ({ outcome, candidates: 0, chosen: false })),
      matchMs: 0,
    });
    if (clean.suggested.length === 0) return untouched(null);
    const left = (this.timeouts?.elaborationMs ?? ELABORATION_TIMEOUT_MS) - (Date.now() - started);
    const budget = Math.min(this.timeouts?.suggestedLookupMs ?? SUGGESTED_LOOKUP_TIMEOUT_MAX_MS, left);
    if (budget <= 0) {
      this.logger.warn("procura das sugeridas sem prazo motivo=no_time_left");
      return untouched("skipped_no_time");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const result = await linkExistingSuggestions({ ...clean, tree: seen.tree, projectKey: seen.projectKey, duplicateKey: seen.duplicateKey, excludeIds: seen.excludeIds, matcher, signal: controller.signal, semantic, fusion, semanticDeadlineMs: Math.min(SEMANTIC_TRIAGE_DEADLINE_MS, Math.floor(budget / 4)) });
      if (result.failed > 0) this.logger.warn(`procura das sugeridas incompleta falhas=${result.failed} de=${clean.suggested.length}`);
      return result;
    } catch (error) {
      this.logger.warn(`procura das sugeridas indisponível motivo=${error instanceof AssistantUnavailableError ? error.reason : errorCode(error)}`);
      return untouched("lookup_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Não chama provedor: funciona sem as chaves. Idempotente: cada conversa cria no máximo um ticket. */
  @Post("ticket-conversations/:id/ticket")
  @QueuesStructure({ by: "conversation" })
  async createTicket(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(createTicketBodySchema)) body: z.output<typeof createTicketBodySchema>,
  ): Promise<{ conversation: ConversationDetail; ticket: TicketDetail }> {
    // Serializa chamadas simultâneas: a segunda espera a primeira terminar e então vê o ticket criado.
    await tx.$queryRaw`select 1 from ticket_conversations where id = ${id}::uuid for update`;
    const conversation = await this.findOwn(tx, principal, id);
    const project = await this.drafts.requireWritableProject(tx, principal, conversation.projectId);
    if (conversation.status === "ticket_created" && conversation.createdTicketId) {
      return parseOutput(createdTicketSchema, {
        conversation: await this.detail(tx, id),
        ticket: await this.tickets.detail(tx, project, conversation.createdTicketId),
        children: await this.createdChildren(tx, project, id, conversation.createdTicketId),
        warnings: [],
      });
    }
    if (conversation.status !== "open") {
      throw new ConflictException({ code: "conversation_closed", message: "A conversa já foi encerrada." });
    }
    // A repetição idempotente (acima) não reabre; quem de fato cria o ticket volta a ver a thread de criação.
    await this.threads.reopen(tx, principal, id);
    if (conversation.draftTitle === null) throw this.draftRequired();
    // ADR 0054 (adendo): `search` só vale para o destino confirmado da última procura guardada para este rascunho; as outras escolhas são da pessoa.
    if (body.placedBy === "search") await this.requireConfirmedSearch(tx, id, conversation, body.parentId);
    // ADR 0045: criar pai, filhos e agrupador muda a estrutura. A trava vem antes de ler a ideia que contém o lugar escolhido.
    await this.tickets.lockStructure(tx, project.id);
    // Ordem das travas (ADR 0046): estrutura → dependências → linhas de ticket → linha do projeto. Com ligações a criar, a trava de
    // dependências vem aqui, antes de o primeiro `create` reservar número na linha do projeto: a rota de dependências a pega primeiro.
    if (body.links.length > 0) await this.tickets.lockDependencies(tx, project.id);
    // Ideia (ADR 0044, adendo): o pai nasce como ideia pelo mesmo caminho da tela, com a mesma permissão. Num lugar que já está
    // dentro de uma ideia, o que nasce faz parte dela, sem estágio próprio, e a opção não pede permissão nenhuma.
    const asIdea = conversation.draftIdea && (await this.tickets.ideaRootFor(tx, project, body.parentId)) === null;
    if (asIdea) this.authorization.registerIdea(principal.actor, project.id);
    const built = await this.assemble(tx, project, conversation);
    this.requireFits(built);
    const { resolved, warnings } = await this.resolveLinks(tx, project, body.links, built.children, body.parentId ?? null);
    if (built.unknownKeys.length > 0) {
      throw new ConflictException({
        code: "unknown_ticket_keys",
        message: `A descrição cita tickets que não existem neste projeto: ${built.unknownKeys.join(", ")}. Corrija a conversa e confirme de novo.`,
        details: { keys: built.unknownKeys },
      });
    }
    // A sugerida que cita ticket que não existe, ou que forjaria a citação do pedido, é descartada com aviso: a criação segue.
    const suggested = await this.keepSuggested(tx, project, conversation, built.unknownKeys, body.suggested, warnings);
    const origin = { origin: "assistant", conversationId: id };
    // A ordem única das travas de tickets (ADR 0068, revisão 1): tudo o que as criações abaixo travam (o lugar com a subida, os
    // tickets do pai novo, os mencionados e os que citam as chaves novas, os alvos das ligações) num comando só, antes da primeira
    // reserva de número. As descrições vão na ordem em que os tickets nascem, para os números previstos baterem com a reserva.
    const descriptions = [
      ...(body.group ? [body.group.description] : []),
      built.description,
      ...built.children.map((child) => child.description),
      ...suggested.map((task) => suggestedDescription(task.motivo, task.description)),
    ];
    await this.tickets.lockLinkedTickets(tx, project, body.parentId ?? null, descriptions, [...(body.group?.ticketIds ?? []), ...resolved.map((link) => link.target.id)]);
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
    // As sugeridas ficam depois das partes da pessoa, com a linha fixa e sem a citação do pedido; o evento guarda quem as sugeriu.
    for (const task of suggested) {
      kids.push(
        await this.tickets.create(
          tx,
          principal,
          project,
          { title: task.title, description: suggestedDescription(task.motivo, task.description), parentId: ticket.id, status: "todo", assigneeIds: [] },
          { ...origin, suggestedBy: "assistant" },
        ),
      );
    }
    // As ligações valem na mesma operação; uma que a regra de dependência recusar vira aviso, nunca derruba a criação.
    for (const link of resolved) {
      const from = link.de === "pai" ? ticket : kids[link.de];
      const outcome = from ? await this.tickets.linkDependency(tx, principal, project, { id: from.id, number: from.number }, link.target) : "self";
      if (outcome === "cycle" || outcome === "self") warnings.push({ code: "link_discarded", de: link.de, dependeDe: link.key, reason: outcome });
    }
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId: conversation.orgId, id } },
      data: { status: "ticket_created", createdTicketId: ticket.id, closedAt: new Date() },
    });
    // De que tipo foi a escolha do lugar (migration 0032), na decisão da conversa e antes de ela passar ao ticket; é diagnóstico.
    const marked = await recordPlacedBy(tx, { conversationId: id, placedBy: body.placedBy });
    if (marked !== null) this.logger.warn(`tipo de escolha do lugar não guardado codigo=${marked}`);
    // A decisão da procura passa a ser do ticket criado (ADR 0052): a conversa pode ser apagada depois sem levá-la.
    const handed = await handDecisionToTicket(tx, { orgId: conversation.orgId, conversationId: id, ticketId: ticket.id });
    if (handed !== null) this.logger.warn(`decisão da procura não passou ao ticket codigo=${handed}`);
    // Ticket criado a partir de uma thread de criação (ADR 0056, item 5): a conversa vai, copiada, para a conversa principal do ticket novo (na mesma transação).
    await this.threads.copyToTicket(tx, principal, { ticketConversationId: id, ticketId: ticket.id });
    return parseOutput(createdTicketSchema, {
      conversation: await this.detail(tx, id),
      // Com filhos, o pai é lido de novo: o progresso e a contagem dele mudam quando os filhos nascem.
      ticket: kids.length > 0 ? await this.tickets.detail(tx, project, ticket.id) : ticket,
      children: kids,
      warnings,
    });
  }

  @Get("ticket-conversations")
  async list(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Query("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<ConversationSummary[]> {
    await this.drafts.findVisibleProject(tx, principal, projectId);
    // As que nasceram numa thread de criação aparecem pela thread (ADR 0056), não nesta lista.
    const inThreads = await this.threads.linkedIds(tx, principal);
    const rows = await tx.ticketConversation.findMany({
      where: { projectId, authorPersonId: principal.person.id, ...(inThreads.length > 0 ? { id: { notIn: inThreads } } : {}) },
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
    await this.drafts.findVisibleProject(tx, principal, conversation.projectId);
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
    await this.drafts.findVisibleProject(tx, principal, conversation.projectId);
    // Descartar é para rascunho: a conversa que já virou ticket e tem thread de criação fica (o cartão da thread diz `created` e leva ao ticket).
    if (conversation.status === "ticket_created" && (await this.threads.hasThread(tx, id))) {
      throw new ConflictException({ code: "creation_created", message: "O ticket desta conversa já foi criado: não há rascunho a descartar." });
    }
    await tx.ticketConversation.delete({ where: { orgId_id: { orgId: conversation.orgId, id } } });
  }

  // ---- regras ---------------------------------------------------------------------------------------------

  /**
   * O que será gravado (ADR 0044): o título e a descrição do pai com a citação do pedido na frente (as mensagens da pessoa
   * naquela conversa, na ordem, como ela as escreveu), os filhos, e as chaves de ticket da parte escrita pela IA que não
   * existem no projeto. Chaves que a própria pessoa escreveu em alguma mensagem não são recusadas, nem quando a IA as repete.
   */
  private async assemble(tx: TenantClient, project: ProjectRow, conversation: ConversationRow, extraTexts: readonly string[] = []) {
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
    const cited = [...new Set([aiDescription, ...children.map((child) => child.description), ...extraTexts].flatMap((text) => mentionedKeys(text)))].filter(
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

  /**
   * Resolve as ligações pedidas ANTES de criar qualquer ticket (ADR 0052, item 4): o alvo é um ticket que já existe neste projeto
   * (o número que o ticket novo vai ter, outro projeto e chave inventada não resolvem) e a origem é o pai ou uma parte do rascunho.
   * O que não vale vira aviso; repetida some em silêncio.
   */
  private async resolveLinks(tx: TenantClient, project: ProjectRow, links: readonly { de: "pai" | number; deTitle?: string | undefined; dependeDe: string }[], parts: readonly { title: string }[], parentId: string | null) {
    const warnings: z.output<typeof createdTicketSchema>["warnings"] = [];
    const prefix = `${project.key}-`;
    const numberOf = (key: string): number | null => {
      const number = key.startsWith(prefix) ? Number(key.slice(prefix.length)) : Number.NaN;
      return Number.isInteger(number) && number >= 1 && number <= 2_147_483_647 ? number : null;
    };
    const numbers = [...new Set(links.flatMap((link) => numberOf(link.dependeDe) ?? []))];
    const found = numbers.length === 0 ? [] : await tx.ticket.findMany({ where: { projectId: project.id, number: { in: numbers } }, select: { id: true, number: true } });
    const byNumber = new Map(found.map((row) => [row.number, row]));
    // Só a árvore viva (sem ideias nem cancelados) pode ser alvo, como na procura.
    const live = found.length === 0 ? new Set<string>() : new Set((await loadPlacementTree(tx, project.id)).tickets.map((ticket) => ticket.id));
    // Um ticket não depende do próprio pai nem de um ancestral: a cadeia do pai escolhido para cima (uma consulta, só com ligações).
    const ancestors = links.length === 0 ? new Map<string, string | null>() : await this.tickets.ancestorLinks(tx, project, parentId);
    const seen = new Set<string>();
    const resolved: { de: "pai" | number; key: string; target: { id: string; number: number } }[] = [];
    for (const link of links) {
      const pair = `${link.de}>${link.dependeDe}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const number = numberOf(link.dependeDe);
      const target = number === null ? undefined : byNumber.get(number);
      if (!target) warnings.push({ code: "link_discarded", de: link.de, dependeDe: link.dependeDe, reason: "unknown_ticket" });
      else if (ancestors.has(target.id)) warnings.push({ code: "link_discarded", de: link.de, dependeDe: link.dependeDe, reason: "ancestor" });
      else if (!live.has(target.id)) warnings.push({ code: "link_discarded", de: link.de, dependeDe: link.dependeDe, reason: "inactive_ticket" });
      else if (link.de !== "pai" && (link.de >= parts.length || normalizeTitle(parts[link.de]!.title) !== normalizeTitle(link.deTitle ?? ""))) warnings.push({ code: "link_discarded", de: link.de, dependeDe: link.dependeDe, reason: "invalid_part" });
      else resolved.push({ de: link.de, key: link.dependeDe, target });
    }
    return { resolved, warnings };
  }

  /**
   * As sugeridas que valem: descarta (com aviso) a que cita ticket que não existe no projeto ou que forjaria a citação do pedido.
   * As chaves inexistentes são as que a conferência do rascunho ainda não tinha achado sozinha.
   */
  private async keepSuggested(
    tx: TenantClient,
    project: ProjectRow,
    conversation: ConversationRow,
    draftUnknown: readonly string[],
    tasks: readonly { title: string; description: string; motivo: string }[],
    warnings: z.output<typeof createdTicketSchema>["warnings"],
  ) {
    if (tasks.length === 0) return [];
    const withTasks = await this.assemble(tx, project, conversation, tasks.map((task) => `${task.title}\n${task.motivo}\n${task.description}`));
    const missing = new Set(withTasks.unknownKeys.filter((key) => !draftUnknown.includes(key)));
    const kept: typeof tasks[number][] = [];
    for (const task of tasks) {
      if (forbiddenQuoteText(task.title, task.motivo, task.description)) warnings.push({ code: "suggested_discarded", title: task.title, reason: "forbidden_text" });
      else if (mentionedKeys(`${task.title}\n${task.motivo}\n${task.description}`).some((key) => missing.has(key))) warnings.push({ code: "suggested_discarded", title: task.title, reason: "unknown_keys" });
      else kept.push(task);
    }
    return kept;
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

  /** Inexistente, de outra pessoa ou de outra organização (RLS): o mesmo 404. */
  private async findOwn(tx: TenantClient, { person }: Principal, id: string): Promise<ConversationRow> {
    const conversation = await tx.ticketConversation.findFirst({ where: { id, authorPersonId: person.id } });
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return conversation;
  }

  /**
   * Conversa própria, projeto visível e liberado para escrita, e conversa ainda aberta. `reopens`: a rota é de quem escreve ou decide
   * (mensagem, rascunho, destino): a thread de criação que a pessoa fechou volta à barra. Abrir para olhar (`elaboration`) não reabre.
   */
  private async requireWritable(tx: TenantClient, principal: Principal, id: string, options: { reopens: boolean } = { reopens: false }) {
    const conversation = await this.findOwn(tx, principal, id);
    const project = await this.drafts.requireWritableProject(tx, principal, conversation.projectId);
    if (conversation.status !== "open") {
      throw new ConflictException({ code: "conversation_closed", message: "A conversa já foi encerrada." });
    }
    if (options.reopens) await this.threads.reopen(tx, principal, id);
    return { conversation, project };
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
