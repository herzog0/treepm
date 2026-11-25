import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, Logger, Param, Post, Query, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { rawPersonRefIds } from "@treepm/domain";
import type { TenantClient } from "@treepm/db";
import { assistantSpeaksIn } from "@treepm/domain";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { ProjectQueryService } from "../query/project-query.service.js";
import { AssistantGate } from "./assistant-gate.js";
import { ChatToolExecutor } from "./chat-tools.js";
import { ConversationService } from "./conversation.service.js";
import { addParticipantsBodySchema, markReadBodySchema, openedSchema, pageQuerySchema, sendMessageBodySchema, sendResultSchema } from "./conversation.schema.js";
import type { ConversationTree, ConversationView, PageQuery, SendMessageBody, closedResultSchema, participantsResultSchema, readResultSchema, reopenedResultSchema } from "./conversation.schema.js";
import { AssistantUnavailableError } from "./ports.js";
import { TicketDraftService } from "./ticket-draft.service.js";
import type { z } from "zod";

/**
 * Conversas em níveis (ADR 0055). Toda rota que recebe o id de uma conversa passa por `ConversationAccess.resolve` (404 igual para
 * "não existe" e "você não participa"); as rotas "minhas" (a árvore, o chat geral, a conversa do ticket) só devolvem o que é da
 * própria pessoa. Só a mensagem SEM menção na conversa principal passa pela porta do aceite e chama o provedor (leitura curta →
 * chamada SEM transação aberta → escrita curta que confere tudo de novo, como a conversa de novo ticket, ADR 0029); a porta vem
 * DEPOIS de o acesso à conversa ser conferido, para quem não participa receber 404 e nunca 403 ou 503.
 */
@Controller()
export class ConversationController {
  private readonly logger = new Logger("Conversations");

  constructor(
    @Inject(AssistantGate) private readonly gate: AssistantGate,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(ProjectQueryService) private readonly query: ProjectQueryService,
    @Inject(TicketDraftService) private readonly drafts: TicketDraftService,
  ) {}

  @Get("conversations")
  tree(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<ConversationTree> {
    return this.conversations.tree(tx, principal);
  }

  @Post("conversations/general")
  @HttpCode(200)
  async openGeneral(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<z.output<typeof openedSchema>> {
    return parseOutput(openedSchema, await this.conversations.openGeneral(tx, principal));
  }

  /** As conversas que a pessoa fechou e continuam fechadas (para reabrir). Antes de `conversations/:id`, que não aceita esta palavra. */
  @Get("conversations/closed")
  closedList(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<ConversationTree> {
    return this.conversations.closedList(tx, principal);
  }

  @Get("tickets/:ticketId/conversation")
  ticketView(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
    @Query(new ZodPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<ConversationView> {
    return this.conversations.ticketView(tx, principal, ticketId, page);
  }

  @Post("tickets/:ticketId/conversation")
  @HttpCode(200)
  async openTicket(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("ticketId", new ZodPipe(idSchema)) ticketId: string): Promise<z.output<typeof openedSchema>> {
    return parseOutput(openedSchema, await this.conversations.openTicket(tx, principal, ticketId));
  }

  @Get("conversations/:id")
  view(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Query(new ZodPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<ConversationView> {
    return this.conversations.view(tx, principal, id, page);
  }

  @Post("conversations/:id/close")
  @HttpCode(200)
  close(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<z.output<typeof closedResultSchema>> {
    return this.conversations.close(tx, principal, id);
  }

  @Post("conversations/:id/reopen")
  @HttpCode(200)
  reopen(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<z.output<typeof reopenedResultSchema>> {
    return this.conversations.reopenOne(tx, principal, id);
  }

  @Post("conversations/:id/messages")
  @OwnTransactions()
  async send(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(sendMessageBodySchema)) body: SendMessageBody,
  ): Promise<z.output<typeof sendResultSchema>> {
    const mentions = body.mentions ?? [];
    // O acesso à conversa vem antes de tudo (404), inclusive antes da porta do aceite.
    const { kind, purpose } = await tenant.run((tx, principal) => this.conversations.kindOf(tx, principal, id));
    // ADR 0058: o texto não cita pessoa que não esteja na lista enviada à parte (o servidor não decide participante pelo texto).
    // A varredura é crua (sem exceção para código): mensagem é texto, não markdown; a web conta igual.
    if (rawPersonRefIds(body.body).some((personId) => !mentions.includes(personId))) {
      throw new UnprocessableEntityException({ code: "mention_mismatch", message: "O texto marca uma pessoa que não está na lista de marcados." });
    }
    // Onde o assistente fala é UMA regra (`assistantSpeaksIn`); fora dela (thread com pessoas) não há criação, projeto nem vez do assistente.
    const speaks = assistantSpeaksIn({ kind, purpose });
    // Dentro da thread de criação não há mensagens da conversa comum (ADR 0056, item 5): o conteúdo é a conversa de novo ticket, pelas rotas dela.
    if (purpose === "creation") throw new UnprocessableEntityException({ code: "creation_thread", message: "Esta thread é a criação de um ticket: a conversa acontece pelas rotas dela, não por mensagens." });
    if (body.creation === true) {
      if (mentions.length > 0 || body.topic === true || body.ticketId !== undefined) throw new UnprocessableEntityException({ code: "creation_with_other", message: "Criar um ticket não combina com marcar pessoas, abrir assunto ou indicar ticket." });
      if (!speaks) throw new UnprocessableEntityException({ code: "creation_in_thread", message: "Um ticket novo só nasce na conversa principal ou numa thread de assunto, não numa thread com pessoas." });
      return this.directCreation(tenant, id, body.body, body.projectId);
    }
    if (body.projectId !== undefined && (mentions.length > 0 || !speaks)) {
      throw new UnprocessableEntityException({ code: "project_not_applicable", message: "O projeto só vale numa mensagem ao assistente." });
    }
    if (body.topic === true) {
      // Pedido que não cabe é 422, sem gastar IA e sem gravar nada; o aceite e o provedor vêm depois da forma e antes de tudo o mais.
      if (mentions.length > 0) throw new UnprocessableEntityException({ code: "topic_with_mentions", message: "Um assunto novo não marca ninguém: ele é só seu e do assistente." });
      if (body.ticketId !== undefined) throw new UnprocessableEntityException({ code: "topic_with_ticket", message: "O assunto novo herda o ticket da conversa onde nasce." });
      if (kind === "thread") throw new UnprocessableEntityException({ code: "topic_in_thread", message: "Um assunto novo só abre na conversa principal, não dentro de uma thread." });
      return this.assistantTurn(tenant, id, body.body, true, body.projectId);
    }
    if (mentions.length > 0) {
      return tenant.run((tx, principal) => this.conversations.sendMentioning(tx, principal, id, body.body, mentions, body.ticketId, speaks));
    }
    if (!speaks) return tenant.run((tx, principal) => this.conversations.postInThread(tx, principal, id, body.body));
    return this.assistantTurn(tenant, id, body.body, false, body.projectId);
  }

  /**
   * A vez do assistente: aceite e provedor → leitura curta → chamada SEM transação aberta → escrita curta que confere tudo de novo.
   * `opening`: o texto abre uma thread de assunto (que só existe depois da resposta); senão é uma mensagem numa conversa que já fala
   * com o assistente (a principal ou uma thread de assunto), que reserva a vez.
   */
  private async assistantTurn(tenant: TenantRunner, id: string, text: string, opening: boolean, projectId: string | undefined): Promise<z.output<typeof sendResultSchema>> {
    const { chat: provider, conversation: drafter } = await this.gate.open(tenant);
    const prep = await tenant.run((tx, principal) => (opening ? this.conversations.prepareTopicOpening(tx, principal, id, text) : this.conversations.prepareAssistantTurn(tx, principal, id, text, projectId)));
    let reply: { message: string; model: string; title?: string | null; openDraft?: string };
    try {
      reply = await provider.reply({
        ticket: prep.context,
        history: prep.history,
        projects: prep.projects.map((project) => project.key),
        tools: new ChatToolExecutor(tenant, this.query, prep.projects, prep.draftTool, () => tenant.run((tx, principal) => this.conversations.reopenOpenCreations(tx, principal))),
        wantTitle: prep.wantTitle,
        draftTool: prep.draftTool,
      });
    } catch (error) {
      if (!opening) await this.release(tenant, id);
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
    // O assistente chamou `open_ticket_draft`: a vez termina aqui e quem abre o rascunho é o servidor, pelo mesmo caminho do pedido direto.
    if (reply.openDraft !== undefined) {
      try {
        return await this.openDraft(tenant, drafter, { id, text, request: reply.openDraft, projectId, assistant: { model: reply.model, seenLastSeq: prep.seenLastSeq } });
      } catch (error) {
        await this.release(tenant, id);
        throw error;
      }
    }
    try {
      if (opening) return parseOutput(sendResultSchema, { kind: "topic", ...(await tenant.run((tx, principal) => this.conversations.recordTopicOpening(tx, principal, id, text, reply))) });
      const saved = await tenant.run((tx, principal) => this.conversations.recordAssistantTurn(tx, principal, id, text, reply, prep.seenLastSeq));
      return parseOutput(sendResultSchema, { kind: "assistant", ...saved });
    } catch (error) {
      if (!opening) await this.release(tenant, id);
      throw error;
    }
  }

  /** O pedido direto (`creation: true`): o texto abre a thread de criação, sem passar pelo modelo do chat. */
  private async directCreation(tenant: TenantRunner, id: string, text: string, projectId: string | undefined): Promise<z.output<typeof sendResultSchema>> {
    const { conversation: drafter } = await this.gate.open(tenant);
    return this.openDraft(tenant, drafter, { id, text, request: text, projectId, assistant: null });
  }

  /**
   * Os dois caminhos caem aqui: leitura curta (projeto e cota) → a conversa de novo ticket responde ao pedido (SEM transação aberta, pelo
   * mesmo serviço da rota `POST projects/:id/ticket-conversations`) → escrita curta que confere tudo de novo. O provedor vê o `request`; a
   * conversa guarda o que a pessoa escreveu (a citação "Pedido original" é dela, nunca do que o modelo resumiu).
   */
  private async openDraft(
    tenant: TenantRunner,
    drafter: Awaited<ReturnType<AssistantGate["open"]>>["conversation"],
    input: { id: string; text: string; request: string; projectId: string | undefined; assistant: { model: string; seenLastSeq: number } | null },
  ): Promise<z.output<typeof sendResultSchema>> {
    // A cota já foi cobrada na vez do assistente (caminho da ferramenta); o pedido direto cobra a sua.
    const prep = await tenant.run((tx, principal) => this.conversations.prepareCreation(tx, principal, input.id, input.projectId, { quota: input.assistant === null }));
    const turn = await this.drafts.ask(drafter, { history: [{ author: "person", body: input.request }], draft: null, groups: prep.groups });
    const saved = await tenant
      .run((tx, principal) =>
        this.conversations.recordCreation(tx, principal, { id: input.id, text: input.text, request: input.request, projectId: prep.project.id, requestedProjectId: input.projectId, turn, assistant: input.assistant }),
      )
      .catch(async (error: unknown) => {
        // O 409 desfaz a transação inteira: a reabertura do rascunho fechado, que esbarrou no limite, precisa de uma transação própria.
        if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === "creation_open") {
          // Se a reabertura falhar, o 409 original continua sendo a resposta (como em `release`).
          await tenant.run((tx, principal) => this.conversations.reopenOpenCreations(tx, principal)).catch(() => undefined);
        }
        throw error;
      });
    return parseOutput(sendResultSchema, { kind: "creation", ...saved });
  }

  /** Solta a vez do assistente; falha ao soltar não esconde o erro de verdade (a reserva vence sozinha). */
  private async release(tenant: TenantRunner, id: string): Promise<void> {
    try {
      await tenant.run((tx, principal) => this.conversations.releaseTurn(tx, principal, id));
    } catch {
      // a reserva vence sozinha
    }
  }

  @Post("conversations/:id/participants")
  addParticipants(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(addParticipantsBodySchema)) body: z.output<typeof addParticipantsBodySchema>,
  ): Promise<z.output<typeof participantsResultSchema>> {
    return this.conversations.addParticipants(tx, principal, id, body.personIds);
  }

  @Post("conversations/:id/read")
  @HttpCode(200)
  read(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(markReadBodySchema.default({}))) body: z.output<typeof markReadBodySchema>,
  ): Promise<z.output<typeof readResultSchema>> {
    return this.conversations.markRead(tx, principal, id, body.upTo);
  }

  @Delete("conversations/:id/messages")
  @HttpCode(204)
  async clear(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<void> {
    await this.conversations.clear(tx, principal, id);
  }
}
