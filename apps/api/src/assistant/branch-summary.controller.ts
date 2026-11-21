import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { descriptionExcerpt } from "@treepm/domain";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { branchContentMark } from "./branch-mark.js";
import { groupTextBodySchema, groupTextResponseSchema } from "./branch-summary.schema.js";
import type { GroupTextResponse } from "./branch-summary.schema.js";
import { AssistantUnavailableError, BRANCH_SUMMARIZER } from "./ports.js";
import type { BranchSummarizer, BranchSummaryInput } from "./ports.js";

type Source = "assistant" | "person";

/**
 * O texto fixo do agrupador ("O que entra aqui", ADR 0033): ler, escrever à mão e pedir à IA que reescreva. O texto
 * guardado é o que a procura usa e só muda por estas rotas. Com a IA desligada as três respondem como as demais rotas
 * do assistente (503 `assistant_not_configured`).
 */
@Controller()
export class BranchSummaryController {
  private readonly logger = new Logger("BranchSummary");

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(BRANCH_SUMMARIZER) private readonly summarizer: BranchSummarizer | null,
  ) {}

  @Get("tickets/:id/summary")
  async read(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<GroupTextResponse> {
    this.requireEnabled();
    const { ticket } = await this.findVisibleTicket(tx, actor, id);
    this.requireGroup(ticket);
    return this.view(tx, id);
  }

  @Put("tickets/:id/summary")
  async write(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(groupTextBodySchema)) body: z.output<typeof groupTextBodySchema>,
  ): Promise<GroupTextResponse> {
    this.requireEnabled();
    const { project, ticket } = await this.requireEditableGroup(tx, principal, id);
    await this.store(tx, principal, { projectId: project.id, ticketId: id, key: `${project.key}-${ticket.number}`, text: body.text, source: "person" });
    return this.view(tx, id);
  }

  /** A IA reescreve a partir dos itens atuais. Leitura curta → chamada SEM transação aberta → escrita curta que confere tudo de novo. */
  @Post("tickets/:id/summary/regenerate")
  @HttpCode(200)
  @OwnTransactions()
  async regenerate(
    @Tenant() tenant: TenantRunner,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<GroupTextResponse> {
    const summarizer = this.requireEnabled().summarizer;
    const input = await tenant.run(async (tx, principal) => {
      const { ticket } = await this.requireEditableGroup(tx, principal, id);
      const children = await tx.ticket.findMany({
        where: { parentId: id },
        orderBy: { number: "asc" },
        select: { id: true, kind: true, title: true },
      });
      if (children.length === 0) {
        throw new ConflictException({ code: "group_empty", message: "O agrupador não tem itens para a IA resumir." });
      }
      // O filho agrupador entra com o texto guardado dele, se houver; sem texto, só com o título (nada é escrito em cadeia).
      const texts = await tx.branchSummary.findMany({
        where: { ticketId: { in: children.filter((child) => child.kind === "group").map((child) => child.id) } },
        select: { ticketId: true, summary: true },
      });
      const byId = new Map(texts.map((text) => [text.ticketId, text.summary]));
      return {
        title: ticket.title,
        descriptionExcerpt: descriptionExcerpt(ticket.description),
        children: children.map((child) => ({ title: child.title, summary: byId.get(child.id) ?? null })),
      } satisfies BranchSummaryInput;
    });

    let result: { summary: string; model: string };
    try {
      result = await summarizer.summarize(input);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }

    return tenant.run(async (tx, principal) => {
      const { project, ticket } = await this.requireEditableGroup(tx, principal, id);
      await this.store(tx, principal, {
        projectId: project.id,
        ticketId: id,
        key: `${project.key}-${ticket.number}`,
        text: result.summary,
        source: "assistant",
        model: result.model,
        contentMark: branchContentMark(input),
      });
      return this.view(tx, id);
    });
  }

  // ---- regras ---------------------------------------------------------------------------------------------

  private requireEnabled(): { summarizer: BranchSummarizer } {
    if (!assistantEnabled(this.config) || !this.summarizer) {
      throw new ServiceUnavailableException({
        code: "assistant_not_configured",
        message: "O assistente não está configurado neste ambiente.",
      });
    }
    return { summarizer: this.summarizer };
  }

  /** Inexistente, de outra organização (RLS) ou de projeto que a pessoa não vê: o mesmo 404. */
  private async findVisibleTicket(tx: TenantClient, actor: Principal["actor"], id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  private requireGroup(ticket: { kind: string }): void {
    if (ticket.kind !== "group") {
      throw new ConflictException({ code: "not_a_group", message: "Só um agrupador tem esse texto." });
    }
  }

  /** Visível (404), pode editar o ticket (403), projeto não arquivado (409) e agrupador (409). */
  private async requireEditableGroup(tx: TenantClient, principal: Principal, id: string) {
    const found = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, found.project.id);
    if (found.project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
    this.requireGroup(found.ticket);
    return found;
  }

  private async store(
    tx: TenantClient,
    principal: Principal,
    input: { projectId: string; ticketId: string; key: string; text: string; source: Source; model?: string; contentMark?: string },
  ): Promise<void> {
    const { orgId } = principal.organization;
    const data =
      input.source === "person"
        ? { summary: input.text, contentMark: "", source: "person", model: null, editedByPersonId: principal.person.id }
        : { summary: input.text, contentMark: input.contentMark ?? "", source: "assistant", model: input.model ?? null, editedByPersonId: null };
    await tx.branchSummary.upsert({
      where: { orgId_ticketId: { orgId, ticketId: input.ticketId } },
      create: { orgId, projectId: input.projectId, ticketId: input.ticketId, ...data },
      update: data,
    });
    // Só a origem: o texto não entra no registro de atividade.
    await this.activity.record(tx, principal, {
      kind: "ticket.summary_updated",
      subjectType: "ticket",
      subjectId: input.ticketId,
      payload: { key: input.key, source: input.source },
    });
  }

  private async view(tx: TenantClient, id: string): Promise<GroupTextResponse> {
    const row = await tx.branchSummary.findFirst({ where: { ticketId: id } });
    return parseOutput(groupTextResponseSchema, {
      summary: row ? { text: row.summary, source: row.source, updatedAt: row.updatedAt.toISOString() } : null,
    });
  }
}
