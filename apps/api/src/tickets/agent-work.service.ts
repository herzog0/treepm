import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { agentWorkEnd, agentWorkIsValid, agentWorkNoteOf, agentWorkRefusal, agentWorkWindow } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { ActivityService } from "../activity/activity.service.js";
import { ideaRootOfTicket } from "./idea-root.js";
import type { AgentWork } from "./tickets.schema.js";
import { ticketStatusSchema } from "./tickets.schema.js";

/** Por que o marcador acabou (ADR 0043): o agente, uma pessoa na tela, o ticket foi concluído ou cancelado, virou ideia (ou entrou numa). */
export type AgentWorkEndReason = "agent" | "person" | "finished" | "idea";

export type AgentWorkInput = { working: boolean; minutes?: number | undefined; note?: string | undefined };

type MarkerRow = { id: string; number: number; started: Date | null; until: Date | null; note: string | null };

/**
 * Marcador de trabalho pela IA (ADR 0043): ligar, renovar, desligar e desligar junto com o ticket. Um relógio só (o injetável,
 * `ACCESS_TOKEN_CLOCK`) grava o fim e decide a validade: nada compara com o `now()` do banco. O marcador que venceu sozinho
 * não grava evento; ligar de novo, pela mesma pessoa, sobre um que vale é renovação e também não grava evento. Outra pessoa sobre
 * um marcador que vale encerra o anterior (motivo `agent`) e inicia um novo.
 */
@Injectable()
export class AgentWorkService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {}

  now(): number {
    return this.clock.now();
  }

  /**
   * Liga, renova ou desliga o marcador de um ticket (`set_agent_work` do MCP). Devolve o estado de agora (`null` = não vale).
   * Quem pode: quem pode editar o ticket, em projeto não arquivado.
   */
  async set(tx: TenantClient, principal: Principal, ticketId: string, input: AgentWorkInput): Promise<AgentWork | null> {
    const { project, ticket } = await this.visible(tx, principal, ticketId);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    if (!input.working) {
      await this.clearMarkers(tx, principal, project.key, [ticketId], "agent");
      return null;
    }
    const window = agentWorkWindow(input.minutes);
    if (!window.ok) throw new BadRequestException({ code: "validation_error", message: "A duração vai de 5 a 240 minutos." });
    const note = agentWorkNoteOf(input.note);
    if (note === null) throw new BadRequestException({ code: "validation_error", message: "A nota tem no máximo 200 caracteres, em uma linha." });

    // Trava a linha e confere de novo, como a mudança de situação: a situação e a ideia de agora, não as da leitura sem trava.
    // O pai também vem desta consulta: o da leitura anterior (sem trava) pode ter mudado por uma mudança de pai que acabou de confirmar.
    const locked = await tx.$queryRaw<{ status: string; idea_stage: string | null; parent_id: string | null; agent_work_started_at: Date | null; agent_work_until: Date | null; agent_work_person_id: string | null }[]>`
      select status, idea_stage, parent_id, agent_work_started_at, agent_work_until, agent_work_person_id from tickets where id = ${ticketId}::uuid for update`;
    const row = locked[0];
    if (!row) throw new NotFoundException("Ticket não encontrado.");
    const outside = row.idea_stage !== null || (await ideaRootOfTicket(tx, row.parent_id)) !== null;
    const refusal = agentWorkRefusal(ticketStatusSchema.parse(row.status), outside);
    if (refusal !== null) {
      throw new ConflictException({
        code: refusal === "idea" ? "agent_work_in_idea" : "agent_work_finished",
        message: refusal === "idea" ? "Uma ideia não é trabalhada antes do aceite." : "Ticket concluído ou cancelado não recebe o marcador.",
      });
    }
    const now = this.clock.now();
    // Renovar é da MESMA pessoa. Outra pessoa sobre um marcador que ainda vale o toma: encerra o anterior e inicia um novo (revisão 2).
    const valid = agentWorkIsValid(row.agent_work_until, now);
    const renewing = valid && row.agent_work_person_id === principal.person.id;
    if (valid && !renewing) {
      await this.activity.record(tx, principal, {
        kind: "ticket.agent_work_ended",
        subjectType: "ticket",
        subjectId: ticketId,
        payload: { key: `${project.key}-${ticket.number}`, reason: "agent" satisfies AgentWorkEndReason },
      });
    }
    const until = agentWorkEnd(now, window.minutes);
    const since = renewing && row.agent_work_started_at ? row.agent_work_started_at : new Date(now);
    await tx.ticket.update({
      where: { orgId_id: { orgId: project.orgId, id: ticketId } },
      data: { agentWorkStartedAt: since, agentWorkUntil: until, agentWorkPersonId: principal.person.id, agentWorkNote: note },
    });
    if (!renewing) {
      await this.activity.record(tx, principal, {
        kind: "ticket.agent_work_started",
        subjectType: "ticket",
        subjectId: ticketId,
        // A nota nunca entra no evento: só a validade.
        payload: { key: `${project.key}-${ticket.number}`, until: until.toISOString() },
      });
    }
    return { since: since.toISOString(), until: until.toISOString(), note };
  }

  /**
   * Desliga o marcador de um ticket (idempotente). `person` é o botão "Encerrar" da página (`DELETE tickets/:id/agent-work`).
   * Quem pode: quem pode editar o ticket, em projeto não arquivado.
   */
  async endByPerson(tx: TenantClient, principal: Principal, ticketId: string): Promise<void> {
    const { project } = await this.visible(tx, principal, ticketId);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.clearMarkers(tx, principal, project.key, [ticketId], "person");
  }

  /**
   * Desliga o marcador do ticket e de todos os descendentes (transformar em ideia, mover para dentro de uma). Só os marcadores que
   * ainda valiam gravam `ticket.agent_work_ended`; os vencidos só têm as colunas limpas.
   */
  async clearSubtree(tx: TenantClient, principal: Principal, projectKey: string, rootId: string, reason: AgentWorkEndReason): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      with recursive down as (
        select id, 1 as depth from tickets where id = ${rootId}::uuid
        union all
        select t.id, down.depth + 1 from tickets t join down on t.parent_id = down.id where down.depth < 1000
      )
      select id from down`;
    // Trava a subárvore inteira (em ordem de id) ANTES de olhar os marcadores: um `set` que já leu os ancestrais antigos e ainda não
    // gravou termina primeiro, e a limpeza o enxerga; um que chega depois espera e relê o pai novo. Fecha o risco residual da ADR 0042.
    const ids = rows.map((row) => row.id);
    await tx.$queryRaw`select id from tickets where id = any(${ids}::uuid[]) order by id for update`;
    await this.clearMarkers(tx, principal, projectKey, ids, reason);
  }

  /** O ticket concluído ou cancelado já não tem o que sinalizar. */
  async clearTicket(tx: TenantClient, principal: Principal, projectKey: string, ticketId: string, reason: AgentWorkEndReason): Promise<void> {
    await this.clearMarkers(tx, principal, projectKey, [ticketId], reason);
  }

  private async clearMarkers(tx: TenantClient, principal: Principal, projectKey: string, ids: readonly string[], reason: AgentWorkEndReason): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.$queryRaw<{ id: string; number: number; started: Date | null; until: Date | null }[]>`
      select id, number, agent_work_started_at as started, agent_work_until as until
      from tickets where id = any(${[...ids]}::uuid[]) and agent_work_until is not null order by id for update`;
    const now = this.clock.now();
    for (const row of rows as MarkerRow[]) {
      await tx.ticket.update({
        where: { orgId_id: { orgId: principal.organization.orgId, id: row.id } },
        data: { agentWorkStartedAt: null, agentWorkUntil: null, agentWorkPersonId: null, agentWorkNote: null },
      });
      if (agentWorkIsValid(row.until, now)) {
        await this.activity.record(tx, principal, {
          kind: "ticket.agent_work_ended",
          subjectType: "ticket",
          subjectId: row.id,
          payload: { key: `${projectKey}-${row.number}`, reason },
        });
      }
    }
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: o mesmo 404. */
  private async visible(tx: TenantClient, principal: Principal, id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id }, select: { id: true, number: true, parentId: true, projectId: true } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  private requireActive(project: { archivedAt: Date | null }): void {
    if (project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
  }
}
