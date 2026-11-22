import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { ContributionStatus } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { readContributions } from "./ticket-contributions.read.js";
import type { Contribution } from "./tickets.schema.js";
import { TicketsService } from "./tickets.service.js";
import type { ProjectRow } from "./tickets.service.js";

type Located = {
  project: ProjectRow;
  ticket: { id: string; number: number };
  contribution: { id: string; areaId: string; text: string; status: string };
};

/**
 * Contribuições por área no ticket (ADR 0041). O texto nunca vai para o evento de atividade nem para o log.
 * Nada aqui grava em `ticket_relations`, nem mexe na situação do ticket, no progresso ou em `ticket_assignees`.
 */
@Injectable()
export class TicketContributionsService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  async add(tx: TenantClient, principal: Principal, ticketId: string, areaId: string): Promise<Contribution> {
    const { project, ticket } = await this.visibleTicket(tx, principal, ticketId);
    this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    const area = await tx.area.findFirst({ where: { id: areaId }, select: { id: true } });
    if (!area) throw new NotFoundException("Área não encontrada.");
    // `skipDuplicates` (ON CONFLICT DO NOTHING) não aborta a transação: quem perde a corrida só recebe a contagem zero.
    const created = await tx.ticketContribution.createMany({
      data: [{ orgId: project.orgId, projectId: project.id, ticketId, areaId, createdByPersonId: principal.person.id }],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      throw new ConflictException({ code: "contribution_area_taken", message: "O ticket já tem uma contribuição dessa área." });
    }
    const row = await tx.ticketContribution.findFirstOrThrow({ where: { ticketId, areaId }, select: { id: true } });
    await this.activity.record(tx, principal, {
      kind: "ticket.contribution_added",
      subjectType: "ticket",
      subjectId: ticketId,
      payload: { key: `${project.key}-${ticket.number}`, contributionId: row.id, areaId },
    });
    return this.one(tx, ticketId, row.id);
  }

  async update(tx: TenantClient, principal: Principal, id: string, input: { text?: string | undefined; status?: ContributionStatus | undefined }): Promise<Contribution> {
    const { project, ticket, contribution } = await this.visibleContribution(tx, principal, id);
    this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    const data: { text?: string; status?: ContributionStatus } = {};
    const fields: string[] = [];
    const payload: Record<string, unknown> = {};
    if (input.text !== undefined && input.text !== contribution.text) {
      data.text = input.text;
      fields.push("text");
    }
    if (input.status !== undefined && input.status !== contribution.status) {
      data.status = input.status;
      fields.push("status");
      payload["status"] = { from: contribution.status, to: input.status };
    }
    if (fields.length > 0) {
      await tx.ticketContribution.update({ where: { orgId_id: { orgId: project.orgId, id } }, data });
      await this.activity.record(tx, principal, {
        kind: "ticket.contribution_updated",
        subjectType: "ticket",
        subjectId: ticket.id,
        payload: { key: `${project.key}-${ticket.number}`, contributionId: id, areaId: contribution.areaId, fields, ...payload },
      });
    }
    return this.one(tx, ticket.id, id);
  }

  /** Apaga de verdade, com o texto e as pessoas. Quem perde uma corrida de remoção não grava evento. */
  async remove(tx: TenantClient, principal: Principal, id: string): Promise<void> {
    const { project, ticket, contribution } = await this.visibleContribution(tx, principal, id);
    this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    const area = await tx.area.findFirst({ where: { id: contribution.areaId }, select: { name: true } });
    // Os comentários da contribuição ficam no ticket: o banco zera `contribution_id` e guarda o nome da área (gatilho).
    const commentsKept = await tx.ticketComment.count({ where: { contributionId: id, removedAt: null } });
    await tx.ticketContributionPerson.deleteMany({ where: { contributionId: id } });
    const gone = await tx.ticketContribution.deleteMany({ where: { id } });
    if (gone.count === 0) return;
    await this.activity.record(tx, principal, {
      kind: "ticket.contribution_removed",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, contributionId: id, areaId: contribution.areaId, areaName: area?.name ?? null, commentsKept },
    });
  }

  async addPerson(tx: TenantClient, principal: Principal, id: string, personId: string): Promise<Contribution> {
    const { project, ticket, contribution } = await this.visibleContribution(tx, principal, id);
    this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    await this.tickets.requireAssignable(tx, project, personId);
    const added = await tx.ticketContributionPerson.createMany({
      data: [{ orgId: project.orgId, contributionId: id, personId }],
      skipDuplicates: true,
    });
    if (added.count > 0) {
      await this.activity.record(tx, principal, {
        kind: "ticket.contribution_person_added",
        subjectType: "ticket",
        subjectId: ticket.id,
        payload: { key: `${project.key}-${ticket.number}`, contributionId: id, areaId: contribution.areaId, personId },
      });
    }
    return this.one(tx, ticket.id, id);
  }

  async removePerson(tx: TenantClient, principal: Principal, id: string, personId: string): Promise<void> {
    const { project, ticket, contribution } = await this.visibleContribution(tx, principal, id);
    this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    const gone = await tx.ticketContributionPerson.deleteMany({ where: { contributionId: id, personId } });
    if (gone.count === 0) return;
    await this.activity.record(tx, principal, {
      kind: "ticket.contribution_person_removed",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, contributionId: id, areaId: contribution.areaId, personId },
    });
  }

  private async one(tx: TenantClient, ticketId: string, id: string): Promise<Contribution> {
    const [contribution] = await readContributions(tx, ticketId, [id]);
    if (!contribution) throw new NotFoundException("Contribuição não encontrada.");
    return contribution;
  }

  /** Inexistente, de outra organização (RLS) ou de projeto privado sem papel: todos viram o mesmo 404. */
  private async visibleTicket(tx: TenantClient, principal: Principal, id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id }, select: { id: true, projectId: true, number: true } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  private async visibleContribution(tx: TenantClient, principal: Principal, id: string): Promise<Located> {
    const contribution = await tx.ticketContribution.findFirst({ where: { id }, select: { id: true, ticketId: true, areaId: true, text: true, status: true } });
    if (!contribution) throw new NotFoundException("Contribuição não encontrada.");
    try {
      const { project, ticket } = await this.visibleTicket(tx, principal, contribution.ticketId);
      return { project, ticket, contribution };
    } catch {
      throw new NotFoundException("Contribuição não encontrada.");
    }
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
  }
}
