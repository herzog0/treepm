import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { canBecomeIdea, canChangeIdeaStage } from "@treepm/domain";
import type { IdeaStage } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { ideaStageSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { IdeaListItem, TicketPage } from "./tickets.schema.js";
import { AgentWorkService } from "./agent-work.service.js";
import { TicketsService } from "./tickets.service.js";
import type { ProjectRow } from "./tickets.service.js";

/** Ordem da lista de ideias: da mais adiantada para a descartada. */
const STAGE_ORDER: Record<IdeaStage, number> = { ready: 0, refining: 1, new: 2, discarded: 3 };

type IdeaRow = { id: string; number: number; parentId: string | null; status: string; ideaStage: IdeaStage | null };

/** Ideias na árvore (ADR 0042): estágio, aceitar, descartar, transformar um ticket comum em ideia e a lista de ideias do projeto. */
@Injectable()
export class IdeasService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
  ) {}

  /** Inexistente, de outra organização (RLS) ou privado sem papel: o mesmo 404. */
  private async visibleProject(tx: TenantClient, actor: Principal["actor"], projectId: string): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  private async visibleTicket(tx: TenantClient, actor: Principal["actor"], id: string): Promise<{ project: ProjectRow; ticket: IdeaRow & { title: string } }> {
    const found = await tx.ticket.findFirst({ where: { id }, select: { id: true, number: true, parentId: true, status: true, ideaStage: true, title: true, projectId: true } });
    if (!found) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: found.projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket: { ...found, ideaStage: found.ideaStage ? ideaStageSchema.parse(found.ideaStage) : null } };
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
  }

  private notRoot(): ConflictException {
    return new ConflictException({ code: "ticket_not_idea_root", message: "Este ticket não é a raiz de uma ideia." });
  }

  /** Relê a raiz já travada (`for update`): o estágio de agora, não o da leitura sem trava. */
  private async lockedStage(tx: TenantClient, id: string): Promise<IdeaStage | null> {
    const rows = await tx.$queryRaw<{ idea_stage: string | null }[]>`select idea_stage from tickets where id = ${id}::uuid for update`;
    const stage = rows[0]?.idea_stage ?? null;
    return stage === null ? null : ideaStageSchema.parse(stage);
  }

  private async setStage(tx: TenantClient, project: ProjectRow, id: string, stage: IdeaStage | null): Promise<void> {
    await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data: { ideaStage: stage } });
  }

  /** `PUT tickets/:id/idea-stage`: entre `new`, `refining` e `ready`; de `discarded` só para `refining` (reabrir). */
  async changeStage(tx: TenantClient, principal: Principal, id: string, to: "new" | "refining" | "ready"): Promise<TicketPage> {
    const { project, ticket } = await this.visibleTicket(tx, principal.actor, id);
    this.authorization.refineIdea(principal.actor, project.id);
    this.requireActive(project);
    if (ticket.ideaStage === null) throw this.notRoot();
    const from = await this.lockedStage(tx, id);
    if (from === null) throw this.notRoot();
    if (from !== to) {
      if (!canChangeIdeaStage(from, to)) {
        throw new ConflictException({ code: "idea_stage_transition", message: "Uma ideia descartada só pode ser reaberta, voltando para refinamento." });
      }
      await this.setStage(tx, project, id, to);
      await this.activity.record(tx, principal, {
        kind: from === "discarded" ? "ticket.idea_reopened" : "ticket.idea_stage_changed",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, from, to },
      });
    }
    return this.tickets.detailFor(tx, project, id, principal);
  }

  /**
   * `POST tickets/:id/idea/accept`: tira o estágio; a subárvore passa a ser de tickets comuns. Valem as regras de sempre: o pai de
   * fora concluído (e os ancestrais) é reaberto, com o evento automático, a menos que esta ideia esteja dentro de outra (então
   * continua fora do processo). A reabertura vem antes de gravar a raiz, como nos outros pontos de entrada (ordem das travas).
   */
  async accept(tx: TenantClient, principal: Principal, id: string): Promise<TicketPage> {
    const { project, ticket } = await this.visibleTicket(tx, principal.actor, id);
    this.authorization.triageIdea(principal.actor, project.id);
    this.requireActive(project);
    this.requireTriageable(ticket.ideaStage);
    const key = `${project.key}-${ticket.number}`;
    if (ticket.parentId !== null && (await this.tickets.ideaRootFor(tx, ticket.parentId)) === null) {
      await this.tickets.reopenAncestors(tx, principal, project, ticket.parentId, key);
    }
    const from = await this.lockedStage(tx, id);
    this.requireTriageable(from);
    await this.setStage(tx, project, id, null);
    await this.activity.record(tx, principal, { kind: "ticket.idea_accepted", subjectType: "ticket", subjectId: id, payload: { key, from } });
    return this.tickets.detailFor(tx, project, id, principal);
  }

  /** `POST tickets/:id/idea/discard`: estágio `discarded`; nada mais muda. */
  async discard(tx: TenantClient, principal: Principal, id: string): Promise<TicketPage> {
    const { project, ticket } = await this.visibleTicket(tx, principal.actor, id);
    this.authorization.triageIdea(principal.actor, project.id);
    this.requireActive(project);
    this.requireTriageable(ticket.ideaStage);
    const from = await this.lockedStage(tx, id);
    this.requireTriageable(from);
    await this.setStage(tx, project, id, "discarded");
    await this.activity.record(tx, principal, {
      kind: "ticket.idea_discarded",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, from },
    });
    return this.tickets.detailFor(tx, project, id, principal);
  }

  /** Aceitar e descartar: só raiz de ideia ainda não descartada. */
  private requireTriageable(stage: IdeaStage | null): void {
    if (stage === null) throw this.notRoot();
    if (stage === "discarded") throw new ConflictException({ code: "idea_discarded", message: "A ideia já foi descartada; reabra-a antes." });
  }

  /**
   * `POST tickets/:id/idea`: transforma um ticket comum em ideia (estágio `new`). O ticket tem de estar `todo` e nenhum
   * descendente `in_progress`, `in_review` ou `done`; os descendentes `todo` ou `cancelled` ficam como estão (o cancelado
   * continua cancelado) e passam a fazer parte da ideia. Trava a subárvore para ninguém mudar uma situação no meio.
   */
  async transform(tx: TenantClient, principal: Principal, id: string): Promise<TicketPage> {
    const { project, ticket } = await this.visibleTicket(tx, principal.actor, id);
    this.authorization.refineIdea(principal.actor, project.id);
    this.requireActive(project);
    if (ticket.ideaStage !== null) throw new ConflictException({ code: "ticket_already_idea", message: "Este ticket já é a raiz de uma ideia." });
    await this.tickets.lockSubtree(tx, id);
    const fresh = await tx.ticket.findFirstOrThrow({ where: { id }, select: { status: true, ideaStage: true } });
    if (fresh.ideaStage !== null) throw new ConflictException({ code: "ticket_already_idea", message: "Este ticket já é a raiz de uma ideia." });
    const descendants = await this.tickets.descendantStatuses(tx, id);
    if (!canBecomeIdea(ticketStatusSchema.parse(fresh.status), descendants)) {
      throw new ConflictException({
        code: "idea_has_work",
        message: "Só um ticket a fazer, sem nenhum descendente em andamento, em revisão ou concluído, pode virar ideia.",
      });
    }
    await this.setStage(tx, project, id, "new");
    // Uma ideia não é trabalhada antes do aceite: o marcador do ticket e dos descendentes acaba (ADR 0043).
    await this.agentWork.clearSubtree(tx, principal, project.key, id, "idea");
    await this.activity.record(tx, principal, {
      kind: "ticket.idea_registered",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, source: "transformed" },
    });
    return this.tickets.detailFor(tx, project, id, principal);
  }

  /**
   * `GET projects/:projectId/ideas`: as raízes de ideia do projeto, por estágio (`ready`, `refining`, `new`, `discarded`) e,
   * dentro do estágio, da mais antiga para a mais nova. Duas consultas: as raízes (pelo índice parcial) e os títulos para os caminhos.
   */
  async list(tx: TenantClient, principal: Principal, projectId: string): Promise<IdeaListItem[]> {
    const project = await this.visibleProject(tx, principal.actor, projectId);
    const [roots, titles] = await Promise.all([
      tx.ticket.findMany({
        where: { projectId, ideaStage: { not: null } },
        select: { id: true, number: true, parentId: true, title: true, ideaStage: true, createdAt: true },
      }),
      tx.ticket.findMany({ where: { projectId }, select: { id: true, parentId: true, title: true } }),
    ]);
    const byId = new Map(titles.map((row) => [row.id, row] as const));
    const pathOf = (parentId: string | null): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      for (let cursor = parentId; cursor !== null && !seen.has(cursor); ) {
        seen.add(cursor);
        const row = byId.get(cursor);
        if (!row) break;
        path.unshift(row.title);
        cursor = row.parentId;
      }
      return path;
    };
    return roots
      .map((row) => ({ row, stage: ideaStageSchema.parse(row.ideaStage) }))
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.row.createdAt.getTime() - b.row.createdAt.getTime() || a.row.number - b.row.number)
      .map(({ row, stage }) => ({
        id: row.id,
        number: row.number,
        key: `${project.key}-${row.number}`,
        title: row.title,
        stage,
        path: pathOf(row.parentId),
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
