import { Body, Controller, Delete, Get, HttpCode, Inject, Logger, Param, Post, Query, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
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
import type { ConversationTree, ConversationView, PageQuery, SendMessageBody, participantsResultSchema, readResultSchema } from "./conversation.schema.js";
import { AssistantUnavailableError } from "./ports.js";
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
    if (body.topic === true) {
      // Pedido que não cabe é 422, sem gastar IA e sem gravar nada; o aceite e o provedor vêm depois da forma e antes de tudo o mais.
      if (mentions.length > 0) throw new UnprocessableEntityException({ code: "topic_with_mentions", message: "Um assunto novo não marca ninguém: ele é só seu e do assistente." });
      if (body.ticketId !== undefined) throw new UnprocessableEntityException({ code: "topic_with_ticket", message: "O assunto novo herda o ticket da conversa onde nasce." });
      if (kind === "thread") throw new UnprocessableEntityException({ code: "topic_in_thread", message: "Um assunto novo só abre na conversa principal, não dentro de uma thread." });
      return this.assistantTurn(tenant, id, body.body, true);
    }
    if (mentions.length > 0) return tenant.run((tx, principal) => this.conversations.openThread(tx, principal, id, body.body, mentions, body.ticketId));
    if (kind === "thread" && purpose !== "topic") return tenant.run((tx, principal) => this.conversations.postInThread(tx, principal, id, body.body));
    return this.assistantTurn(tenant, id, body.body, false);
  }

  /**
   * A vez do assistente: aceite e provedor → leitura curta → chamada SEM transação aberta → escrita curta que confere tudo de novo.
   * `opening`: o texto abre uma thread de assunto (que só existe depois da resposta); senão é uma mensagem numa conversa que já fala
   * com o assistente (a principal ou uma thread de assunto), que reserva a vez.
   */
  private async assistantTurn(tenant: TenantRunner, id: string, text: string, opening: boolean): Promise<z.output<typeof sendResultSchema>> {
    const { chat: provider } = await this.gate.open(tenant);
    const prep = await tenant.run((tx, principal) => (opening ? this.conversations.prepareTopicOpening(tx, principal, id, text) : this.conversations.prepareAssistantTurn(tx, principal, id, text)));
    let reply: { message: string; model: string; title?: string | null };
    try {
      reply = await provider.reply({
        ticket: prep.context,
        history: prep.history,
        projects: prep.projects.map((project) => project.key),
        tools: new ChatToolExecutor(tenant, this.query, prep.projects),
        wantTitle: prep.wantTitle,
      });
    } catch (error) {
      if (!opening) await this.release(tenant, id);
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
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
