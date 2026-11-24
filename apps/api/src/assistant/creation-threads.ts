import { Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";
import { ConversationService } from "./conversation.service.js";

/**
 * A ponte da conversa de novo ticket (rotas antigas, `ticket-conversations`) com a thread de criação (ADR 0056, item 5). Existe para o
 * controlador dessas rotas não injetar o serviço das conversas: ele continua fora da enumeração de rotas de conversa.
 */
@Injectable()
export class CreationThreads {
  constructor(@Inject(ConversationService) private readonly conversations: ConversationService) {}

  origin(tx: TenantClient, ticketConversationId: string): Promise<string | null> {
    return this.conversations.creationOrigin(tx, ticketConversationId);
  }

  /** As conversas de novo ticket da pessoa que nasceram numa thread de criação: elas aparecem pela thread, não pela lista antiga. */
  linkedIds(tx: TenantClient, principal: Principal): Promise<string[]> {
    return this.conversations.creationLinkedIds(tx, principal.person.id);
  }

  hasThread(tx: TenantClient, ticketConversationId: string): Promise<boolean> {
    return this.conversations.creationThreadExists(tx, ticketConversationId);
  }

  copyToTicket(tx: TenantClient, principal: Principal, input: { ticketConversationId: string; ticketId: string }): Promise<void> {
    return this.conversations.copyCreationToTicket(tx, principal, input);
  }
}
