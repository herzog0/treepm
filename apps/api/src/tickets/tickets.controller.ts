import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { isFinished, parentWouldCreateCycle, ticketProgress } from "@treepm/domain";
import type { TicketStatus } from "@treepm/domain";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import {
  createTicketSchema,
  importTicketsSchema,
  ticketSummarySchema,
  updateTicketSchema,
} from "./tickets.schema.js";
import type { ImportItem, TicketDetail, TicketSummary } from "./tickets.schema.js";
import { TicketsService, toNodes, toSummary } from "./tickets.service.js";
import type { ProjectRow, TicketRow } from "./tickets.service.js";

const summarySelect = {
  id: true,
  projectId: true,
  number: true,
  parentId: true,
  title: true,
  description: true,
  status: true,
  assignees: { select: { personId: true } },
} as const;

@Controller()
export class TicketsController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  @Get("projects/:projectId/tickets")
  async list(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<TicketSummary[]> {
    const project = await this.findVisibleProject(tx, actor, projectId);
    const rows = await tx.ticket.findMany({
      where: { projectId },
      select: summarySelect,
      orderBy: { number: "asc" },
    });
    const progress = ticketProgress(toNodes(rows));
    return rows.map((row) => parseOutput(ticketSummarySchema, toSummary(project, row, progress)));
  }

  @Post("projects/:projectId/tickets")
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(createTicketSchema)) body: z.output<typeof createTicketSchema>,
  ): Promise<TicketDetail> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.createTicket(principal.actor, projectId);
    this.requireActive(project);
    return this.tickets.create(tx, principal, project, {
      title: body.title,
      description: body.description ?? "",
      parentId: body.parentId ?? null,
      status: body.status ?? "todo",
      assigneeIds: body.assigneeIds ?? [],
    });
  }

  @Post("projects/:projectId/tickets/import")
  async import(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(importTicketsSchema)) body: z.output<typeof importTicketsSchema>,
  ): Promise<TicketSummary[]> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.importTickets(principal.actor, projectId);
    this.requireActive(project);
    if (body.parentId) await this.tickets.requireParent(tx, projectId, body.parentId);

    // Pré-ordem: o pai antes dos filhos, irmãos na ordem recebida. Item com filhos é só um ticket com filhos.
    const flat: { item: ImportItem; parentIndex: number | null }[] = [];
    const walk = (items: readonly ImportItem[], parentIndex: number | null): void => {
      for (const item of items) {
        const index = flat.push({ item, parentIndex }) - 1;
        if (item.children) walk(item.children, index);
      }
    };
    walk(body.items, null);

    // Nenhum `done` com filho direto aberto (ADR 0034): item concluído que traz filho aberto na própria lista nasce `todo`.
    const hasOpenChild = new Set<number>();
    flat.forEach(({ item, parentIndex }) => {
      if (parentIndex !== null && !isFinished(item.status ?? "todo")) hasOpenChild.add(parentIndex);
    });
    const first = await this.tickets.allocateNumbers(tx, project, flat.length);
    if (body.parentId && flat.some(({ item, parentIndex }) => parentIndex === null && !isFinished(item.status ?? "todo"))) {
      await this.tickets.reopenAncestors(tx, principal, project, body.parentId, `${project.key}-${first}`);
    }
    // IDs gerados pelo banco (`app_uuid_v7()`, o mesmo padrão da coluna) em UMA consulta; com eles, pais e filhos
    // entram na mesma inserção em lote (a FK do pai é verificada no fim do comando). Total de idas ao banco
    // da importação: constante, independente da quantidade de itens.
    const generated = await tx.$queryRaw<{ id: string }[]>`select app_uuid_v7() as id from generate_series(1, ${flat.length}::int)`;
    const ids = generated.map((row) => row.id);
    const rows: TicketRow[] = flat.map(({ item, parentIndex }, index) => ({
      id: ids[index] as string,
      projectId,
      number: first + index,
      parentId: parentIndex === null ? (body.parentId ?? null) : (ids[parentIndex] ?? null),
      title: item.title,
      description: item.description ?? "",
      status: item.status === "done" && hasOpenChild.has(index) ? "todo" : (item.status ?? "todo"),
      assignees: [],
    }));
    await tx.ticket.createMany({
      data: flat.map((_, index) => {
        const row = rows[index] as TicketRow;
        return {
          id: row.id,
          orgId: project.orgId,
          projectId,
          number: row.number,
          parentId: row.parentId,
          title: row.title,
          description: row.description,
          status: row.status,
          createdByPersonId: principal.person.id,
        };
      }),
    });
    await this.activity.record(tx, principal, {
      kind: "ticket.imported",
      subjectType: "project",
      subjectId: projectId,
      payload: { count: flat.length, firstNumber: first, lastNumber: first + flat.length - 1 },
    });
    await this.tickets.reconcileMentions(tx, project, rows);
    await this.tickets.backfillMentionsTo(tx, project, rows);
    const progress = ticketProgress(toNodes(rows));
    return rows.map((row) => parseOutput(ticketSummarySchema, toSummary(project, row, progress)));
  }

  /** Refaz as ligações "menciona" de todo o projeto a partir das descrições (ADR 0037); usada pela ferramenta local. */
  @Post("projects/:projectId/tickets/mentions/rebuild")
  @HttpCode(200)
  async rebuildMentions(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<{ read: number; created: number; removed: number }> {
    const project = await this.findVisibleProject(tx, actor, projectId);
    this.authorization.editTicket(actor, projectId);
    this.requireActive(project);
    return this.tickets.rebuildMentions(tx, project);
  }

  @Get("tickets/:id")
  async get(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<TicketDetail> {
    const { project } = await this.findVisibleTicket(tx, actor, id);
    return this.tickets.detail(tx, project, id);
  }

  @Patch("tickets/:id")
  async update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTicketSchema)) body: z.output<typeof updateTicketSchema>,
  ): Promise<TicketDetail> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);

    if (body.parentId !== undefined && body.parentId !== null) {
      await this.tickets.requireParent(tx, project.id, body.parentId);
    }
    if (body.parentId !== undefined && body.parentId !== ticket.parentId) {
      const all = await tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, parentId: true } });
      const parents = new Map(all.map((row) => [row.id, row.parentId]));
      if (parentWouldCreateCycle(parents, id, body.parentId)) {
        throw new ConflictException({ code: "ticket_cycle", message: "O pai escolhido é o próprio ticket ou um descendente." });
      }
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const data: {
      title?: string;
      description?: string;
      status?: string;
      parentId?: string | null;
    } = {};
    if (body.title !== undefined && body.title !== ticket.title) {
      data.title = body.title;
      changes["title"] = { from: ticket.title, to: body.title };
    }
    if (body.description !== undefined && body.description !== ticket.description) {
      data.description = body.description;
    }
    if (body.status !== undefined && body.status !== ticket.status) {
      data.status = body.status;
      changes["status"] = { from: ticket.status, to: body.status };
    }
    if (body.parentId !== undefined && body.parentId !== ticket.parentId) {
      data.parentId = body.parentId;
      changes["parentId"] = { from: ticket.parentId, to: body.parentId };
    }
    const fields = Object.keys(data);
    const finalStatus = (data.status ?? ticket.status) as TicketStatus;
    const finalParent = body.parentId !== undefined ? body.parentId : ticket.parentId;
    // Reabertura (ADR 0034): ticket aberto que entra num pai (mudou de pai ou voltou a ficar aberto) reabre o pai `done`.
    // Antes de qualquer outro bloqueio da transação, de baixo para cima.
    if (finalParent && !isFinished(finalStatus) && (data.parentId !== undefined || data.status !== undefined)) {
      await this.tickets.reopenAncestors(tx, principal, project, finalParent, `${project.key}-${ticket.number}`);
    }
    if (data.status === "done") await this.requireNoOpenChildren(tx, id);
    if (fields.length > 0) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, fields, ...changes },
      });
    }
    if (data.description !== undefined) await this.tickets.syncMentions(tx, project, ticket, data.description);
    return this.tickets.detail(tx, project, id);
  }

  @Delete("tickets/:id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.removeTicket(principal.actor, project.id);
    this.requireActive(project);
    if (await this.hasChildren(tx, id)) {
      throw new ConflictException({ code: "ticket_has_children", message: "Remova ou mova os filhos antes." });
    }
    await tx.ticket.delete({ where: { orgId_id: { orgId: project.orgId, id } } });
    await this.activity.record(tx, principal, {
      kind: "ticket.deleted",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, title: ticket.title },
    });
  }

  @Put("tickets/:id/assignees/:personId")
  async assign(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<TicketDetail> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.tickets.requireAssignable(tx, project, personId);
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: id, personId } };
    if (!(await tx.ticketAssignee.findUnique({ where: key }))) {
      await tx.ticketAssignee.create({ data: { orgId: project.orgId, ticketId: id, personId } });
      await this.activity.record(tx, principal, {
        kind: "ticket.assignee_added",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, personId },
      });
    }
    return this.tickets.detail(tx, project, id);
  }

  @Delete("tickets/:id/assignees/:personId")
  @HttpCode(204)
  async unassign(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: id, personId } };
    if (!(await tx.ticketAssignee.findUnique({ where: key }))) {
      throw new NotFoundException("Pessoa não atribuída ao ticket.");
    }
    await tx.ticketAssignee.delete({ where: key });
    await this.activity.record(tx, principal, {
      kind: "ticket.assignee_removed",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, personId },
    });
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async findVisibleProject(tx: TenantClient, actor: Principal["actor"], projectId: string): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) {
      throw new NotFoundException("Projeto não encontrado.");
    }
    return project;
  }

  private async findVisibleTicket(tx: TenantClient, actor: Principal["actor"], id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(actor, project)) {
      throw new NotFoundException("Ticket não encontrado.");
    }
    return { project, ticket };
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
  }



  /**
   * Concluir exige todos os filhos diretos finalizados (ADR 0034): 409 `ticket_has_open_children` com a contagem em
   * `details.openChildCount`. A conferência e a escrita acontecem na mesma transação, depois de travar a linha do
   * ticket (`for update`), o mesmo bloqueio de que a chave estrangeira do pai precisa para gravar um filho: um filho
   * novo ainda não confirmado faz a conclusão esperar e, ao confirmar, ser vista e recusada.
   */
  private async requireNoOpenChildren(tx: TenantClient, id: string): Promise<void> {
    await tx.$queryRaw`select id from tickets where id = ${id}::uuid for update`;
    const open = await tx.ticket.count({ where: { parentId: id, status: { notIn: ["done", "cancelled"] } } });
    if (open > 0) {
      throw new ConflictException({
        code: "ticket_has_open_children",
        message:
          open === 1
            ? "Conclua ou cancele o item aberto antes de concluir este ticket."
            : `Conclua ou cancele os ${open} itens abertos antes de concluir este ticket.`,
        details: { openChildCount: open },
      });
    }
  }

  private async hasChildren(tx: TenantClient, id: string): Promise<boolean> {
    return (await this.childCount(tx, id)) > 0;
  }

  private childCount(tx: TenantClient, id: string): Promise<number> {
    return tx.ticket.count({ where: { parentId: id } });
  }
}
