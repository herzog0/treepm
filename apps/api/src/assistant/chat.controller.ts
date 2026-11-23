import { Body, Controller, Delete, Get, HttpCode, Inject, Logger, Param, Post, Query, ServiceUnavailableException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { AssistantGate } from "./assistant-gate.js";
import { ChatService } from "./chat.service.js";
import { markReadBodySchema, pageQuerySchema, replyBodySchema, sendMessageBodySchema, sendResultSchema } from "./chat.schema.js";
import type { ChatList, ChatView, PageQuery, SendMessageBody, ThreadView, readResultSchema, replyResultSchema } from "./chat.schema.js";
import { AssistantUnavailableError } from "./ports.js";
import type { z } from "zod";

/**
 * Chat de trabalho por ticket (ADR 0049). Só a mensagem SEM menção ao assistente passa pela porta do aceite e chama o provedor
 * (leitura curta → chamada SEM transação aberta → escrita curta que confere tudo de novo, como a conversa de novo ticket, ADR 0029).
 * Mensagem com menção e as threads são conversa entre pessoas: não precisam de aceite nem de provedor configurado.
 */
@Controller()
export class ChatController {
  private readonly logger = new Logger("Chat");

  constructor(
    @Inject(AssistantGate) private readonly gate: AssistantGate,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  @Get("chats")
  list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<ChatList> {
    return this.chat.list(tx, principal);
  }

  @Get("tickets/:ticketId/chat")
  view(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
    @Query(new ZodPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<ChatView> {
    return this.chat.view(tx, principal, ticketId, page);
  }

  @Get("chat-threads/:threadId")
  thread(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("threadId", new ZodPipe(idSchema)) threadId: string,
    @Query(new ZodPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<ThreadView> {
    return this.chat.thread(tx, principal, threadId, page);
  }

  @Post("tickets/:ticketId/chat/messages")
  @OwnTransactions()
  async send(
    @Tenant() tenant: TenantRunner,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
    @Body(new ZodPipe(sendMessageBodySchema)) body: SendMessageBody,
  ): Promise<z.output<typeof sendResultSchema>> {
    const mentions = body.mentions ?? [];
    if (mentions.length > 0) {
      const thread = await tenant.run((tx, principal) => this.chat.startThread(tx, principal, ticketId, body.body, mentions));
      return parseOutput(sendResultSchema, { kind: "thread", thread });
    }
    // A porta do aceite vem antes de ler qualquer coisa do ticket (ADR 0039).
    const { chat: provider } = await this.gate.open(tenant);
    const prep = await tenant.run(async (tx, principal) => {
      return this.chat.prepareAssistantTurn(tx, principal, ticketId, body.body);
    });
    let reply: { message: string; model: string };
    try {
      reply = await provider.reply({ ticket: prep.context, history: prep.history });
    } catch (error) {
      await this.release(tenant, ticketId);
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
    let saved;
    try {
      saved = await tenant.run((tx, principal) => this.chat.recordAssistantTurn(tx, principal, ticketId, body.body, reply, prep.seenLastSeq));
    } catch (error) {
      await this.release(tenant, ticketId);
      throw error;
    }
    return parseOutput(sendResultSchema, { kind: "assistant", ...saved });
  }

  /** Solta a vez do assistente; falha ao soltar não esconde o erro de verdade (a reserva vence sozinha). */
  private async release(tenant: TenantRunner, ticketId: string): Promise<void> {
    try {
      await tenant.run((tx, principal) => this.chat.releaseTurn(tx, principal, ticketId));
    } catch {
      // a reserva vence sozinha
    }
  }

  @Post("chat-threads/:threadId/messages")
  reply(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("threadId", new ZodPipe(idSchema)) threadId: string,
    @Body(new ZodPipe(replyBodySchema)) body: SendMessageBody,
  ): Promise<z.output<typeof replyResultSchema>> {
    return this.chat.replyInThread(tx, principal, threadId, body.body, body.mentions ?? []);
  }

  @Post("tickets/:ticketId/chat/read")
  @HttpCode(200)
  read(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
    @Body(new ZodPipe(markReadBodySchema.default({}))) body: z.output<typeof markReadBodySchema>,
  ): Promise<z.output<typeof readResultSchema>> {
    return this.chat.markRead(tx, principal, ticketId, body.upTo);
  }

  @Delete("tickets/:ticketId/chat/messages")
  @HttpCode(204)
  async clear(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
  ): Promise<void> {
    await this.chat.clear(tx, principal, ticketId);
  }
}
