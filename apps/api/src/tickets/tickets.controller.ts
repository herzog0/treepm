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
import { parentWouldCreateCycle, ticketProgress } from "@treepm/domain";
import type { TicketNode, TicketStatus } from "@treepm/domain";
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
  ticketDetailSchema,
  ticketStatusSchema,
  ticketSummarySchema,
  updateTicketSchema,
} from "./tickets.schema.js";
import type { ImportItem, TicketDetail, TicketSummary } from "./tickets.schema.js";

type ProjectRow = {
  orgId: string;
  id: string;
  key: string;
  visibility: "organization" | "private";
  archivedAt: Date | null;
};

type TicketRow = {
  id: string;
  projectId: string;
  number: number;
  parentId: string | null;
  title: string;
  status: string;
  assignees: { personId: string }[];
};
type TicketDetailRow = TicketRow & {
  description: string;
  createdByPersonId: string;
  createdAt: Date;
  updatedAt: Date;
};

type Progress = ReturnType<typeof ticketProgress>;

const summarySelect = {
  id: true,
  projectId: true,
  number: true,
  parentId: true,
  title: true,
  status: true,
  assignees: { select: { personId: true } },
} as const;

function statusOf(row: { status: string }): TicketStatus {
  return ticketStatusSchema.parse(row.status);
}

function toSummary(project: Pick<ProjectRow, "key">, row: TicketRow, progress: Progress): TicketSummary {
  const own = progress.get(row.id) ?? null;
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    key: `${project.key}-${row.number}`,
    parentId: row.parentId,
    title: row.title,
    status: own ? null : statusOf(row),
    progress: own,
    assigneeIds: row.assignees.map((assignee) => assignee.personId).sort(),
  };
}

function toDetail(project: Pick<ProjectRow, "key">, row: TicketDetailRow, progress: Progress): TicketDetail {
  return parseOutput(ticketDetailSchema, {
    ...toSummary(project, row, progress),
    description: row.description,
    createdByPersonId: row.createdByPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

@Controller()
export class TicketsController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
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
    const progress = ticketProgress(rows.map((row) => ({ id: row.id, parentId: row.parentId, status: statusOf(row) })));
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
    if (body.parentId) await this.requireParent(tx, projectId, body.parentId);
    const assigneeIds = [...new Set(body.assigneeIds ?? [])];
    for (const personId of assigneeIds) await this.requireAssignable(tx, project, personId);

    const number = await this.allocateNumbers(tx, project, 1);
    const created = await tx.ticket.create({
      data: {
        orgId: project.orgId,
        projectId,
        number,
        parentId: body.parentId ?? null,
        title: body.title,
        description: body.description ?? "",
        status: body.status ?? "todo",
        createdByPersonId: principal.person.id,
      },
    });
    if (assigneeIds.length > 0) {
      await tx.ticketAssignee.createMany({
        data: assigneeIds.map((personId) => ({ orgId: project.orgId, ticketId: created.id, personId })),
      });
    }
    await this.activity.record(tx, principal, {
      kind: "ticket.created",
      subjectType: "ticket",
      subjectId: created.id,
      payload: {
        key: `${project.key}-${number}`,
        title: created.title,
        parentId: created.parentId,
        status: created.status,
        assigneeIds: assigneeIds.sort(),
      },
    });
    return this.detail(tx, project, created.id);
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
    if (body.parentId) await this.requireParent(tx, projectId, body.parentId);

    // Pré-ordem: o pai antes dos filhos, irmãos na ordem recebida.
    const flat: { item: ImportItem; parentIndex: number | null }[] = [];
    const walk = (items: readonly ImportItem[], parentIndex: number | null): void => {
      for (const item of items) {
        const index = flat.push({ item, parentIndex }) - 1;
        if (item.children) walk(item.children, index);
      }
    };
    walk(body.items, null);

    const first = await this.allocateNumbers(tx, project, flat.length);
    const ids: string[] = [];
    const rows: TicketRow[] = [];
    for (const [index, { item, parentIndex }] of flat.entries()) {
      const created = await tx.ticket.create({
        data: {
          orgId: project.orgId,
          projectId,
          number: first + index,
          parentId: parentIndex === null ? (body.parentId ?? null) : (ids[parentIndex] ?? null),
          title: item.title,
          description: item.description ?? "",
          status: item.status ?? "todo",
          createdByPersonId: principal.person.id,
        },
        select: summarySelect,
      });
      ids.push(created.id);
      rows.push(created);
    }
    await this.activity.record(tx, principal, {
      kind: "ticket.imported",
      subjectType: "project",
      subjectId: projectId,
      payload: { count: flat.length, firstNumber: first, lastNumber: first + flat.length - 1 },
    });
    const progress = ticketProgress(rows.map((row) => ({ id: row.id, parentId: row.parentId, status: statusOf(row) })));
    return rows.map((row) => parseOutput(ticketSummarySchema, toSummary(project, row, progress)));
  }

  @Get("tickets/:id")
  async get(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<TicketDetail> {
    const { project } = await this.findVisibleTicket(tx, actor, id);
    return this.detail(tx, project, id);
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

    if (body.status !== undefined && (await this.hasChildren(tx, id))) {
      throw new ConflictException({
        code: "ticket_has_children",
        message: "Ticket com filhos não tem situação própria.",
      });
    }
    if (body.parentId !== undefined && body.parentId !== null) {
      await this.requireParent(tx, project.id, body.parentId);
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
    if (fields.length > 0) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, fields, ...changes },
      });
    }
    return this.detail(tx, project, id);
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
    await this.requireAssignable(tx, project, personId);
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
    return this.detail(tx, project, id);
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

  /** Pai de outro projeto, de outra organização ou inexistente: 404. */
  private async requireParent(tx: TenantClient, projectId: string, parentId: string): Promise<void> {
    const parent = await tx.ticket.findFirst({ where: { id: parentId, projectId }, select: { id: true } });
    if (!parent) throw new NotFoundException("Ticket pai não encontrado.");
  }

  /** A pessoa precisa existir, estar ativa e já enxergar o projeto; atribuir nunca concede acesso. */
  private async requireAssignable(tx: TenantClient, project: ProjectRow, personId: string): Promise<void> {
    const person = await tx.person.findFirst({ where: { id: personId } });
    if (!person) throw new NotFoundException("Pessoa não encontrada.");
    if (!person.active) {
      throw new ConflictException({ code: "person_inactive", message: "A pessoa não está mais na organização." });
    }
    const personActor = await this.authorization.loadActor(tx, person.id, person.clerkRole);
    if (!this.authorization.canView(personActor, project)) {
      throw new ConflictException({
        code: "person_without_project_access",
        message: "A pessoa não tem acesso ao projeto; conceda um papel antes de atribuir.",
      });
    }
  }

  private async hasChildren(tx: TenantClient, id: string): Promise<boolean> {
    return (await tx.ticket.count({ where: { parentId: id } })) > 0;
  }

  /**
   * Reserva `count` números consecutivos e devolve o primeiro. O UPDATE trava a linha do projeto até o fim da
   * transação, o que serializa criações simultâneas; números nunca são reutilizados.
   */
  private async allocateNumbers(tx: TenantClient, project: ProjectRow, count: number): Promise<number> {
    const updated = await tx.project.update({
      where: { orgId_id: { orgId: project.orgId, id: project.id } },
      data: { nextTicketNumber: { increment: count } },
      select: { nextTicketNumber: true },
    });
    return updated.nextTicketNumber - count;
  }

  private async detail(tx: TenantClient, project: ProjectRow, id: string): Promise<TicketDetail> {
    const [row, nodes] = await Promise.all([
      tx.ticket.findFirstOrThrow({ where: { id }, include: { assignees: { select: { personId: true } } } }),
      tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, parentId: true, status: true } }),
    ]);
    const progress = ticketProgress(
      nodes.map((node): TicketNode => ({ id: node.id, parentId: node.parentId, status: statusOf(node) })),
    );
    return toDetail(project, row, progress);
  }
}
