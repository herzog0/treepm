import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { groupTextBodySchema, groupTextResponseSchema } from "./branch-summary.schema.js";
import type { GroupTextResponse } from "./branch-summary.schema.js";
import { branchTexts } from "./branch-text.js";
import { loadBranchSubtree } from "./branch-tree.js";
import { AssistantGate } from "./assistant-gate.js";

/**
 * O texto do agrupador ("O que entra aqui", ADR 0033, 0052): ler, escrever a nota à mão e (sem efeito) pedir que reescreva.
 * A procura monta o texto na hora e só lê daqui a nota escrita por pessoa. Com a IA desligada (503 `assistant_not_configured`) ou sem o aceite da
 * organização (403 `assistant_consent_required`) as três respondem como as demais rotas do assistente.
 */
@Controller()
export class BranchSummaryController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AssistantGate) private readonly gate: AssistantGate,
  ) {}

  @Get("tickets/:id/summary")
  async read(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<GroupTextResponse> {
    await this.gate.openIn(tx, principal);
    await this.findVisibleTicket(tx, principal.actor, id);
    return this.view(tx, id);
  }

  @Put("tickets/:id/summary")
  async write(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(groupTextBodySchema)) body: z.output<typeof groupTextBodySchema>,
  ): Promise<GroupTextResponse> {
    await this.gate.openIn(tx, principal);
    const { project, ticket } = await this.requireEditableParent(tx, principal, id);
    await this.store(tx, principal, { projectId: project.id, ticketId: id, key: `${project.key}-${ticket.number}`, text: body.text });
    return this.view(tx, id);
  }

  /**
   * Sem efeito desde a ADR 0052: o texto do ramo é montado na hora da procura e a nota da pessoa nunca é sobrescrita. A
   * rota continua para não quebrar a tela nem a ferramenta; confere as mesmas regras de antes (ticket com filhos, pode
   * editar, projeto aberto) e devolve o que a leitura devolve. Nenhum provedor é chamado e nada é gravado.
   */
  @Post("tickets/:id/summary/regenerate")
  @HttpCode(200)
  async regenerate(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<GroupTextResponse> {
    await this.gate.openIn(tx, principal);
    await this.requireEditableParent(tx, principal, id);
    return this.view(tx, id);
  }

  // ---- regras ---------------------------------------------------------------------------------------------

  /** Inexistente, de outra organização (RLS) ou de projeto que a pessoa não vê: o mesmo 404. */
  private async findVisibleTicket(tx: TenantClient, actor: Principal["actor"], id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  /** Gravar ou regenerar o texto só faz sentido em ticket que tem filhos (ADR 0034): senão, 409 `ticket_has_no_items`. */
  private async requireItems(tx: TenantClient, ticket: { id: string }): Promise<void> {
    if ((await tx.ticket.count({ where: { parentId: ticket.id } })) === 0) {
      throw new ConflictException({ code: "ticket_has_no_items", message: "O ticket não tem itens: não há o que resumir." });
    }
  }

  /** Visível (404), pode editar o ticket (403), projeto não arquivado (409) e ticket com filhos (409). */
  private async requireEditableParent(tx: TenantClient, principal: Principal, id: string) {
    const found = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, found.project.id);
    if (found.project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
    await this.requireItems(tx, found.ticket);
    return found;
  }

  private async store(
    tx: TenantClient,
    principal: Principal,
    input: { projectId: string; ticketId: string; key: string; text: string },
  ): Promise<void> {
    const { orgId } = principal.organization;
    const data = { summary: input.text, contentMark: "", source: "person", model: null, editedByPersonId: principal.person.id };
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
      payload: { key: input.key, source: "person" },
    });
  }

  /**
   * A nota da pessoa, se houver; senão o texto montado agora da árvore (`built: true`), ou `null` em ticket sem filhos. O
   * texto de origem "assistente" já guardado não é lido (ADR 0052). O texto montado sai com `source: "built"` e sem
   * `updatedAt` (não foi escrito em momento nenhum); `built: true` continua.
   */
  private async view(tx: TenantClient, id: string): Promise<GroupTextResponse> {
    const row = await tx.branchSummary.findFirst({ where: { ticketId: id, source: "person" } });
    if (row) {
      return parseOutput(groupTextResponseSchema, { summary: { text: row.summary, source: "person", updatedAt: row.updatedAt.toISOString(), built: false } });
    }
    const ticket = await tx.ticket.findFirst({ where: { id }, select: { orgId: true, projectId: true } });
    const nodes = await loadBranchSubtree(tx, { orgId: ticket?.orgId ?? "", projectId: ticket?.projectId ?? "" }, id);
    if (!nodes.some((node) => node.parentId !== null)) return parseOutput(groupTextResponseSchema, { summary: null });
    const notes = new Map<string, string>();
    const text = branchTexts(nodes, notes).textOf(id);
    return parseOutput(groupTextResponseSchema, { summary: { text, source: "built", built: true } });
  }
}
