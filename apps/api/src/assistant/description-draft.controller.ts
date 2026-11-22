import { Body, ConflictException, Controller, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { descriptionDraftBodySchema, descriptionDraftResponseSchema } from "./description-draft.schema.js";
import type { DescriptionDraftResponse } from "./description-draft.schema.js";
import { AssistantUnavailableError, DESCRIPTION_WRITER } from "./ports.js";
import type { DescriptionWriter } from "./ports.js";

/**
 * Pedir à IA um trecho para a descrição (ADR 0036). Não grava nada e não cria evento: o texto volta para a pessoa, que
 * decide inserir no editor; a descrição só é salva pelo caminho de sempre. Ao provedor vão só o título, a descrição do
 * corpo, os títulos do caminho até a raiz e o pedido.
 */
@Controller()
export class DescriptionDraftController {
  private readonly logger = new Logger("DescriptionDraft");

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(DESCRIPTION_WRITER) private readonly writer: DescriptionWriter | null,
  ) {}

  /** Leitura curta → chamada SEM transação aberta (a IA demora). */
  @Post("tickets/:id/description/draft")
  @HttpCode(200)
  @OwnTransactions()
  async draft(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(descriptionDraftBodySchema)) body: z.output<typeof descriptionDraftBodySchema>,
  ): Promise<DescriptionDraftResponse> {
    const writer = this.requireEnabled();
    const context = await tenant.run(async (tx, principal) => {
      const { ticket } = await this.requireEditable(tx, principal, id);
      return { title: ticket.title, ancestors: await this.ancestorTitles(tx, ticket.parentId) };
    });

    try {
      const result = await writer.write({ ...context, description: body.description, request: body.request });
      // Texto fora de 1 a 6.000 caracteres não é resposta: nunca é cortado em silêncio.
      const parsed = descriptionDraftResponseSchema.safeParse(result);
      if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
      return parsed.data;
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  private requireEnabled(): DescriptionWriter {
    if (!assistantEnabled(this.config) || !this.writer) {
      throw new ServiceUnavailableException({
        code: "assistant_not_configured",
        message: "O assistente não está configurado neste ambiente.",
      });
    }
    return this.writer;
  }

  /** Visível (404), pode editar o ticket (403) e projeto não arquivado (409). Inexistente, de outra organização (RLS) ou invisível: o mesmo 404. */
  private async requireEditable(tx: TenantClient, principal: Principal, id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    this.authorization.editTicket(principal.actor, project.id);
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
    return { project, ticket };
  }

  /** Os títulos do topo até o pai (só títulos; a guarda contra ciclo é de segurança, a árvore não os tem). */
  private async ancestorTitles(tx: TenantClient, parentId: string | null): Promise<string[]> {
    const titles: string[] = [];
    const seen = new Set<string>();
    let next = parentId;
    while (next && !seen.has(next)) {
      seen.add(next);
      const row = await tx.ticket.findFirst({ where: { id: next }, select: { title: true, parentId: true } });
      if (!row) break;
      titles.unshift(row.title);
      next = row.parentId;
    }
    return titles;
  }
}
