import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { descriptionExcerpt, isFinished, ticketProgress, ticketsToReopen } from "@treepm/domain";
import type { TicketNode, TicketStatus } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { ticketDetailSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { TicketDetail, TicketSummary } from "./tickets.schema.js";

export type ProjectRow = {
  orgId: string;
  id: string;
  key: string;
  visibility: "organization" | "private";
  archivedAt: Date | null;
};

export type TicketRow = {
  id: string;
  projectId: string;
  number: number;
  parentId: string | null;
  title: string;
  description: string;
  status: string;
  assignees: { personId: string }[];
};
export type TicketDetailRow = TicketRow & {
  createdByPersonId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Progress = ReturnType<typeof ticketProgress>;

export function statusOf(row: { status: string }): TicketStatus {
  return ticketStatusSchema.parse(row.status);
}

/** Os nós do projeto no formato do cálculo de progresso. */
export function toNodes(rows: readonly { id: string; parentId: string | null; status: string }[]): TicketNode[] {
  return rows.map((row): TicketNode => ({ id: row.id, parentId: row.parentId, status: statusOf(row) }));
}

export function toSummary(project: Pick<ProjectRow, "key">, row: TicketRow, progress: Progress): TicketSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    key: `${project.key}-${row.number}`,
    parentId: row.parentId,
    title: row.title,
    descriptionExcerpt: descriptionExcerpt(row.description),
    status: statusOf(row),
    // Ticket com filhos: progresso sobre todos os descendentes (ADR 0034); sem filhos: null.
    progress: progress.get(row.id) ?? null,
    assigneeIds: row.assignees.map((assignee) => assignee.personId).sort(),
  };
}

export function toDetail(project: Pick<ProjectRow, "key">, row: TicketDetailRow, progress: Progress): TicketDetail {
  return parseOutput(ticketDetailSchema, {
    ...toSummary(project, row, progress),
    description: row.description,
    createdByPersonId: row.createdByPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Regras de ticket compartilhadas pelo controlador de tickets e pela criação vinda da conversa com a IA (ADR 0029). */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Pai de outro projeto, de outra organização ou inexistente: 404. Qualquer ticket do projeto pode ser pai (ADR 0034). */
  async requireParent(tx: TenantClient, projectId: string, parentId: string): Promise<void> {
    const parent = await tx.ticket.findFirst({ where: { id: parentId, projectId }, select: { id: true } });
    if (!parent) throw new NotFoundException("Ticket pai não encontrado.");
  }

  /**
   * Reabertura do pai concluído (ADR 0034): `parentId` acaba de ganhar (ou vai ganhar, nesta transação) um filho direto
   * aberto. Trava de baixo para cima (`for update`, um ancestral por vez, parando no primeiro que não está `done`) e
   * reabre para `todo` os que a função pura `ticketsToReopen` indicar, gravando um evento por ticket reaberto com
   * `automatic: true` e `causedBy` (a chave do ticket que causou). Deve rodar ANTES de gravar o filho: a chave estrangeira
   * do pai trava a linha do pai, e travar na ordem contrária daria impasse com "concluir".
   */
  async reopenAncestors(tx: TenantClient, principal: Principal, project: ProjectRow, parentId: string | null, causedBy: string): Promise<void> {
    const parents = new Map<string, string | null>();
    const statuses = new Map<string, TicketStatus>();
    const numbers = new Map<string, number>();
    for (let cursor = parentId; cursor !== null && !parents.has(cursor); ) {
      const rows = await tx.$queryRaw<{ id: string; parent_id: string | null; status: string; number: number }[]>`
        select id, parent_id, status, number from tickets where id = ${cursor}::uuid for update`;
      const row = rows[0];
      if (!row) break;
      parents.set(row.id, row.parent_id);
      statuses.set(row.id, ticketStatusSchema.parse(row.status));
      numbers.set(row.id, row.number);
      if (row.status !== "done") break;
      cursor = row.parent_id;
    }
    for (const id of ticketsToReopen(parents, statuses, parentId)) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data: { status: "todo" } });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: {
          key: `${project.key}-${numbers.get(id)}`,
          fields: ["status"],
          status: { from: "done", to: "todo" },
          automatic: true,
          causedBy,
        },
      });
    }
  }

  /** A pessoa precisa existir, estar ativa e já enxergar o projeto; atribuir nunca concede acesso. */
  async requireAssignable(tx: TenantClient, project: ProjectRow, personId: string): Promise<void> {
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

  /**
   * Reserva `count` números consecutivos e devolve o primeiro. O UPDATE trava a linha do projeto até o fim da
   * transação, o que serializa criações simultâneas; números nunca são reutilizados.
   */
  async allocateNumbers(tx: TenantClient, project: ProjectRow, count: number): Promise<number> {
    const updated = await tx.project.update({
      where: { orgId_id: { orgId: project.orgId, id: project.id } },
      data: { nextTicketNumber: { increment: count } },
      select: { nextTicketNumber: true },
    });
    return updated.nextTicketNumber - count;
  }

  async detail(tx: TenantClient, project: ProjectRow, id: string): Promise<TicketDetail> {
    const [row, nodes] = await Promise.all([
      tx.ticket.findFirstOrThrow({ where: { id }, include: { assignees: { select: { personId: true } } } }),
      tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, parentId: true, status: true } }),
    ]);
    const progress = ticketProgress(toNodes(nodes));
    return toDetail(project, row, progress);
  }

  /**
   * Cria um ticket depois de as permissões e o projeto terem sido conferidos por quem chama: confere o pai e
   * os responsáveis, reserva o número, grava o ticket e o `ticket.created`. `extraPayload` acrescenta campos ao
   * evento (por exemplo, a origem "assistente").
   */
  async create(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    input: {
      title: string;
      description: string;
      parentId: string | null;
      status: TicketStatus;
      assigneeIds: string[];
    },
    extraPayload: Record<string, string> = {},
  ): Promise<TicketDetail> {
    if (input.parentId) await this.requireParent(tx, project.id, input.parentId);
    const assigneeIds = [...new Set(input.assigneeIds)];
    for (const personId of assigneeIds) await this.requireAssignable(tx, project, personId);

    const number = await this.allocateNumbers(tx, project, 1);
    if (input.parentId && !isFinished(input.status)) {
      await this.reopenAncestors(tx, principal, project, input.parentId, `${project.key}-${number}`);
    }
    const created = await tx.ticket.create({
      data: {
        orgId: project.orgId,
        projectId: project.id,
        number,
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        status: input.status,
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
        ...extraPayload,
      },
    });
    return this.detail(tx, project, created.id);
  }

  /**
   * Confirmar uma proposta de pai novo (ADR 0031, 0034), dentro da transação da rota: confere de novo que cada ticket
   * ainda é filho de `parentId` e continua sem filhos (409 `grouping_changed`, sem criar nem mover nada), cria o
   * ticket pai (um ticket comum, situação `todo`) e move os tickets para ele. Devolve o id do pai novo, que passa a
   * ser o pai do ticket novo.
   */
  async createParentAndMove(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    parentId: string | null,
    group: { title: string; description: string; ticketIds: string[] },
    origin: Record<string, string>,
  ): Promise<string> {
    if (parentId) await this.requireParent(tx, project.id, parentId);
    // Trava os tickets até o fim da transação: ninguém os move nem os remove entre a conferência e a mudança.
    await tx.$queryRaw`select id from tickets where id = any(${group.ticketIds}::uuid[]) order by id for update`;
    const found = await tx.ticket.findMany({
      where: { id: { in: group.ticketIds }, projectId: project.id, parentId },
      select: { id: true, number: true, parentId: true },
    });
    const withChildren = found.length === 0 ? 0 : await tx.ticket.count({ where: { parentId: { in: found.map((row) => row.id) } } });
    if (found.length !== group.ticketIds.length || withChildren > 0) {
      throw new ConflictException({
        code: "grouping_changed",
        message: "Algum desses tickets mudou de lugar. Procure de novo.",
      });
    }
    const created = await this.create(
      tx,
      principal,
      project,
      { title: group.title, description: group.description, parentId, status: "todo", assigneeIds: [] },
      origin,
    );
    for (const moved of [...found].sort((a, b) => a.number - b.number)) {
      await tx.ticket.update({
        where: { orgId_id: { orgId: project.orgId, id: moved.id } },
        data: { parentId: created.id },
      });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: moved.id,
        payload: {
          key: `${project.key}-${moved.number}`,
          fields: ["parentId"],
          parentId: { from: parentId, to: created.id },
          ...origin,
        },
      });
    }
    return created.id;
  }
}
