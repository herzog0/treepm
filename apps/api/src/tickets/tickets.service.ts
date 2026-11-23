import { lockProjectStructure } from "./structure-lock.js";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { agentWorkIsValid, canEditContributions, canEditTicket, canMoveIntoIdea, canTriageIdea, descriptionExcerpt, ideaRootsOf, isFinished, mentionedKeys, parentWouldCreateCycle, statusChangeAllowed, ticketProgress, ticketsToReopen } from "@treepm/domain";
import type { Actor, IdeaStage, TicketNode, TicketStatus } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { AgentWorkService } from "./agent-work.service.js";
import { ideaRootOfTicket } from "./idea-root.js";
import { ideaStageSchema, ticketDetailSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { AgentWork, TicketDetail, TicketIdea, TicketPage, TicketSummary, updateTicketSchema } from "./tickets.schema.js";
import { readContributions } from "./ticket-contributions.read.js";

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
  /** Estágio de ideia (ADR 0042): só a raiz de uma ideia tem. */
  ideaStage: string | null;
  assignees: { personId: string }[];
  /** Marcador de trabalho pela IA (ADR 0043); ausente = sem marcador. */
  agentWorkStartedAt?: Date | null;
  agentWorkUntil?: Date | null;
  agentWorkNote?: string | null;
};
export type TicketDetailRow = TicketRow & {
  agentWorkPersonId?: string | null;
  createdByPersonId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Quanto a chave do projeto é seguida de "-" no texto: filtro grosso do banco; quem decide é `mentionedKeys`. */
const MANY = 20;

export type MentionSource = { id: string; number: number; description: string };
export type MentionCounts = { created: number; removed: number };

export type Progress = ReturnType<typeof ticketProgress>;

/** O que mudar num ticket (corpo do `PATCH tickets/:id`, já validado). */
export type UpdateTicketInput = z.output<typeof updateTicketSchema>;

export function statusOf(row: { status: string }): TicketStatus {
  return ticketStatusSchema.parse(row.status);
}

/** Os nós do projeto no formato do cálculo de progresso. */
export function toNodes(rows: readonly { id: string; parentId: string | null; status: string; ideaStage?: string | null }[]): TicketNode[] {
  return rows.map((row): TicketNode => ({ id: row.id, parentId: row.parentId, status: statusOf(row), ideaStage: row.ideaStage ? ideaStageSchema.parse(row.ideaStage) : null }));
}

/**
 * Como cada ticket aparece em relação às ideias (ADR 0042), sem consulta por ticket: a raiz com o estágio; quem está dentro
 * com a raiz mais próxima; ticket comum não entra no mapa (`null`).
 */
export function ideaViews(
  project: Pick<ProjectRow, "key">,
  rows: readonly { id: string; number: number; parentId: string | null; status: string; ideaStage?: string | null }[],
): Map<string, TicketIdea> {
  const nodes = toNodes(rows);
  const numberOf = new Map(rows.map((row) => [row.id, row.number] as const));
  const stageOf = new Map(nodes.map((node) => [node.id, node.ideaStage ?? null] as const));
  const views = new Map<string, TicketIdea>();
  for (const [id, rootId] of ideaRootsOf(nodes)) {
    const stage = stageOf.get(id);
    if (id === rootId && stage) views.set(id, { root: true, stage });
    else views.set(id, { root: false, rootId, rootKey: `${project.key}-${numberOf.get(rootId) ?? 0}` });
  }
  return views;
}

/** O marcador como a API o mostra: só enquanto o fim é futuro (relógio de quem chama); vencido ou ausente é `null`. */
export function toAgentWork(row: Pick<TicketRow, "agentWorkStartedAt" | "agentWorkUntil" | "agentWorkNote">, now: number): AgentWork | null {
  if (!row.agentWorkStartedAt || !agentWorkIsValid(row.agentWorkUntil ?? null, now) || !row.agentWorkUntil) return null;
  return { since: row.agentWorkStartedAt.toISOString(), until: row.agentWorkUntil.toISOString(), note: row.agentWorkNote ?? "" };
}

export function toSummary(project: Pick<ProjectRow, "key">, row: TicketRow, progress: Progress, idea: TicketIdea = null, now: number = Date.now()): TicketSummary {
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
    idea,
    agentWork: toAgentWork(row, now),
  };
}

export type MentionedByRow = { number: number; id: string; title: string; status: string };

export function toDetail(project: Pick<ProjectRow, "key">, row: TicketDetailRow, progress: Progress,
  idea: TicketIdea = null,
  mentionedBy: readonly MentionedByRow[] = [],
  dependsOn: readonly MentionedByRow[] = [],
  blocks: readonly MentionedByRow[] = [],
  now: number = Date.now(),
  agentWorkBy: { id: string; displayName: string; avatarUrl: string | null } | null = null,
): TicketDetail {
  const link = (from: MentionedByRow) => ({ id: from.id, key: `${project.key}-${from.number}`, title: from.title, status: from.status });
  return parseOutput(ticketDetailSchema, {
    ...toSummary(project, row, progress, idea, now),
    agentWork: toAgentWork(row, now) && agentWorkBy ? { ...(toAgentWork(row, now) as AgentWork), by: agentWorkBy } : null,
    description: row.description,
    mentionedBy: mentionedBy.map(link),
    dependsOn: dependsOn.map(link),
    blocks: blocks.map(link),
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
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {}

  /** O instante de agora, do relógio injetável: o mesmo que grava e decide a validade do marcador. */
  now(): number {
    return this.clock.now();
  }

  /**
   * Alterar um ticket (título, descrição, situação, pai): o caminho ÚNICO de regras, chamado pela rota HTTP
   * (`PATCH tickets/:id`) e pelo MCP (ADR 0043). Faz tudo na ordem de sempre: visibilidade (404), permissão (403),
   * projeto arquivado (409), pai e ciclo, ideias, reabertura dos ancestrais (de baixo para cima, antes de qualquer
   * outro bloqueio), a regra 5 das ideias com a linha travada, concluir com filho aberto e, por fim, a gravação e o evento.
   */
  async updateTicket(tx: TenantClient, principal: Principal, id: string, body: UpdateTicketInput): Promise<TicketPage> {
    const found = await this.findVisibleTicket(tx, principal.actor, id);
    const { project } = found;
    let { ticket } = found;
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    if (body.parentId !== undefined) {
      // Mudança de estrutura (ADR 0045): a trava vem antes de qualquer conferência que leia a árvore, e o ticket é lido de novo
      // com ela (o pai atual pode ter mudado enquanto esperávamos).
      await this.lockStructure(tx, project.id);
      ticket = (await this.findVisibleTicket(tx, principal.actor, id)).ticket;
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
    const finalStatus = (data.status ?? ticket.status) as TicketStatus;
    const finalParent = body.parentId !== undefined ? body.parentId : ticket.parentId;
    // Ideias (ADR 0042): a raiz, ou um ticket dentro de uma, está fora do processo. A posição que vale é a final: quem sai da
    // ideia no mesmo pedido já muda de situação como ticket comum, e quem entra não muda.
    const parentIdea = data.parentId !== undefined || data.status !== undefined ? await this.ideaRootFor(tx, finalParent) : null;
    const outside = ticket.ideaStage !== null || parentIdea !== null;
    if (data.parentId !== undefined && parentIdea !== null) {
      // Trabalho em andamento não vira ideia por arrasto: o ticket e os descendentes `todo` ou `cancelled`. A subárvore é
      // travada (`for update`) antes de ler as situações: uma mudança de situação ainda não confirmada de um descendente
      // faz esta espera e, ao confirmar, é vista (risco residual da ADR 0042, fechado pela ADR 0045).
      await this.lockSubtree(tx, id);
      if (!canMoveIntoIdea(ticket.status as TicketStatus, await this.descendantStatuses(tx, id))) {
        throw new ConflictException({
          code: "move_into_idea_blocked",
          message: "Trabalho em andamento, em revisão ou concluído não entra numa ideia; mova só o que ainda está a fazer.",
        });
      }
    }
    // Reabertura (ADR 0034): ticket aberto que entra num pai (mudou de pai ou voltou a ficar aberto) reabre o pai `done`.
    // Antes de qualquer outro bloqueio da transação, de baixo para cima. Fora do processo, nada reabre (ADR 0042).
    if (finalParent && !outside && !isFinished(finalStatus) && (data.parentId !== undefined || data.status !== undefined)) {
      await this.reopenAncestors(tx, principal, project, finalParent, `${project.key}-${ticket.number}`);
    }
    if (data.status !== undefined) {
      // Regra 5 (ADR 0042). Trava a linha e confere de novo: uma transformação em ideia que acabou de confirmar vale a partir daqui.
      const locked = await tx.$queryRaw<{ idea_stage: string | null }[]>`select idea_stage from tickets where id = ${id}::uuid for update`;
      const inside = locked[0]?.idea_stage != null || (await this.ideaRootFor(tx, finalParent)) !== null;
      if (!statusChangeAllowed(inside, ticket.status as TicketStatus, data.status as TicketStatus)) this.throwInIdea();
    }
    if (data.status === "done") await this.requireNoOpenChildren(tx, id);
    // O marcador de trabalho pela IA (ADR 0043) acaba ANTES da gravação da situação: o banco recusa concluído ou cancelado com marcador.
    if (data.status === "done" || data.status === "cancelled") await this.agentWork.clearTicket(tx, principal, project.key, id, "finished");
    if (fields.length > 0) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, fields, ...changes },
      });
    }
    // Entrando numa ideia, o marcador acaba junto, com a subárvore.
    if (data.parentId !== undefined && parentIdea !== null) await this.agentWork.clearSubtree(tx, principal, project.key, id, "idea");
    if (data.description !== undefined) await this.syncMentions(tx, project, ticket, data.description);
    return this.detailFor(tx, project, id, principal);
  }

  /** Pega a trava de estrutura do projeto (ADR 0045); os controladores a alcançam por aqui, nunca direto. */
  lockStructure(tx: TenantClient, projectId: string): Promise<void> {
    return lockProjectStructure(tx, projectId);
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async findVisibleTicket(tx: TenantClient, actor: Actor, id: string) {
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
    // A ideia (a raiz de ideia filha) não conta como filho aberto (ADR 0042).
    const open = await tx.ticket.count({ where: { parentId: id, status: { notIn: ["done", "cancelled"] }, ideaStage: null } });
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

  private throwInIdea(): never {
    throw new ConflictException({ code: "ticket_in_idea", message: "Dentro de uma ideia a situação fica em a fazer; aceite a ideia antes." });
  }

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

  /** O ticket como a página o lê: o detalhe mais as contribuições e se quem lê pode mexer nelas (ADR 0041). */
  async detailFor(tx: TenantClient, project: ProjectRow, id: string, viewer: { actor: Actor }): Promise<TicketPage> {
    const [detail, contributions] = await Promise.all([this.detail(tx, project, id), readContributions(tx, id)]);
    return {
      ...detail,
      contributions,
      canEditContributions: this.canEditContributionsOf(viewer.actor, project),
      canTriageIdea: this.canTriageIdeaOf(viewer.actor, project, detail.idea),
      canEndAgentWork: detail.agentWork !== null && project.archivedAt === null && canEditTicket(viewer.actor, project.id),
    };
  }

  /** Aceitar e descartar: gestor, em raiz de ideia, em projeto que não está arquivado (ADR 0042). */
  canTriageIdeaOf(actor: Actor, project: Pick<ProjectRow, "id" | "archivedAt">, idea: TicketIdea): boolean {
    return idea?.root === true && project.archivedAt === null && canTriageIdea(actor, project.id);
  }

  /**
   * A raiz de ideia mais próxima de `startId`, ele incluído (ADR 0042): uma consulta recursiva, qualquer que seja a
   * profundidade. `null` quando `startId` é nulo ou não está dentro de nenhuma ideia.
   */
  async ideaRootFor(tx: TenantClient, startId: string | null): Promise<{ id: string; number: number; stage: IdeaStage } | null> {
    return ideaRootOfTicket(tx, startId);
  }

  /** As situações de todos os descendentes de um ticket (ele não entra), qualquer que seja a profundidade. */
  async descendantStatuses(tx: TenantClient, id: string): Promise<TicketStatus[]> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      with recursive down as (
        select id, status, 1 as depth from tickets where parent_id = ${id}::uuid
        union all
        select t.id, t.status, down.depth + 1 from tickets t join down on t.parent_id = down.id where down.depth < 1000
      )
      select status from down`;
    return rows.map((row) => ticketStatusSchema.parse(row.status));
  }

  /** Trava o ticket e todos os descendentes (`for update`) até o fim da transação: ninguém muda a situação deles no meio de uma conferência. */
  async lockSubtree(tx: TenantClient, id: string): Promise<void> {
    await tx.$queryRaw`
      select id from tickets where id in (
        with recursive down as (
          select id, 1 as depth from tickets where id = ${id}::uuid
          union all
          select t.id, down.depth + 1 from tickets t join down on t.parent_id = down.id where down.depth < 1000
        )
        select id from down
      ) order by id for update`;
  }

  canEditContributionsOf(actor: Actor, project: Pick<ProjectRow, "id" | "archivedAt">): boolean {
    return project.archivedAt === null && canEditContributions(actor, project.id);
  }

  async detail(tx: TenantClient, project: ProjectRow, id: string): Promise<TicketDetail> {
    const [row, nodes, mentions, dependencies] = await Promise.all([
      tx.ticket.findFirstOrThrow({ where: { id }, include: { assignees: { select: { personId: true } } } }),
      tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, number: true, parentId: true, status: true, ideaStage: true } }),
      tx.ticketRelation.findMany({
        where: { toTicketId: id, kind: "mentions" },
        select: { from: { select: { id: true, number: true, title: true, status: true } } },
      }),
      tx.ticketRelation.findMany({
        where: { kind: "depends_on", OR: [{ fromTicketId: id }, { toTicketId: id }] },
        select: {
          fromTicketId: true,
          from: { select: { id: true, number: true, title: true, status: true } },
          to: { select: { id: true, number: true, title: true, status: true } },
        },
      }),
    ]);
    const progress = ticketProgress(toNodes(nodes));
    const mentionedBy = mentions.map((relation) => relation.from).sort((a, b) => a.number - b.number);
    const byNumber = (a: MentionedByRow, b: MentionedByRow) => a.number - b.number;
    const dependsOn = dependencies.filter((relation) => relation.fromTicketId === id).map((relation) => relation.to).sort(byNumber);
    const blocks = dependencies.filter((relation) => relation.fromTicketId !== id).map((relation) => relation.from).sort(byNumber);
    const now = this.clock.now();
    const by = toAgentWork(row, now) && row.agentWorkPersonId
      ? await tx.person.findFirst({ where: { id: row.agentWorkPersonId }, select: { id: true, displayName: true, avatarUrl: true } })
      : null;
    return toDetail(project, row, progress, ideaViews(project, nodes).get(id) ?? null, mentionedBy, dependsOn, blocks, now, by);
  }

  /**
   * A regra única de "menciona" (ADR 0037): os números de ticket do projeto que a descrição cita (pela mesma `mentionedKeys`
   * que a web usa), sem o próprio ticket. Não sabe se o número existe.
   */
  private mentionedNumbers(project: Pick<ProjectRow, "key">, source: MentionSource): number[] {
    const prefix = `${project.key}-`;
    const numbers = mentionedKeys(source.description)
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)))
      .filter((number) => Number.isSafeInteger(number) && number !== source.number);
    return [...new Set(numbers)];
  }

  /**
   * Faz as ligações `mentions` que saem de cada fonte serem exatamente as da sua descrição (ADR 0037): apaga as que sobraram
   * e cria as que faltam, sem recriar as que continuam. Só lê e mexe em `kind = 'mentions'`; `depends_on` nunca é tocada.
   * Faz uma consulta por etapa, não uma por ticket.
   */
  async reconcileMentions(tx: TenantClient, project: ProjectRow, sources: readonly MentionSource[]): Promise<MentionCounts> {
    if (sources.length === 0) return { created: 0, removed: 0 };
    const wanted = new Map(sources.map((source) => [source.id, this.mentionedNumbers(project, source)]));
    const allNumbers = [...new Set([...wanted.values()].flat())];
    const idOf = new Map<number, string>();
    if (allNumbers.length > 0) {
      const found = await tx.ticket.findMany({ where: { projectId: project.id, number: { in: allNumbers } }, select: { id: true, number: true } });
      for (const row of found) idOf.set(row.number, row.id);
    }
    const existing = await tx.ticketRelation.findMany({
      where: { fromTicketId: { in: sources.map((source) => source.id) }, kind: "mentions" },
      select: { id: true, fromTicketId: true, toTicketId: true },
    });
    const wantedPairs = new Set<string>();
    for (const [from, numbers] of wanted) for (const number of numbers) if (idOf.has(number)) wantedPairs.add(`${from}>${idOf.get(number)}`);
    const have = new Set(existing.map((row) => `${row.fromTicketId}>${row.toTicketId}`));
    const stale = existing.filter((row) => !wantedPairs.has(`${row.fromTicketId}>${row.toTicketId}`)).map((row) => row.id);
    const missing = [...wantedPairs].filter((pair) => !have.has(pair)).map((pair) => pair.split(">") as [string, string]);
    if (stale.length > 0) await tx.ticketRelation.deleteMany({ where: { id: { in: stale } } });
    let created = 0;
    if (missing.length > 0) {
      // As ligações das candidatas não estão travadas: outra transação pode ter criado a mesma entre a leitura e aqui.
      const result = await tx.ticketRelation.createMany({
        data: missing.map(([fromTicketId, toTicketId]) => ({ orgId: project.orgId, projectId: project.id, fromTicketId, toTicketId, kind: "mentions" })),
        skipDuplicates: true,
      });
      created = result.count;
    }
    return { created, removed: stale.length };
  }

  /** Uma descrição acaba de ser gravada (criação ou alteração): refaz as ligações que saem deste ticket. */
  async syncMentions(tx: TenantClient, project: ProjectRow, ticket: { id: string; number: number }, description: string): Promise<void> {
    await this.reconcileMentions(tx, project, [{ id: ticket.id, number: ticket.number, description }]);
  }

  /**
   * Tickets com os números `numbers` acabam de ser criados (um ou vários, ainda sem as ligações deles): as descrições do
   * projeto escritas antes que já citam essas chaves passam a ter a ligação. O banco só acha candidatas (texto que contém a
   * chave, ou, para muitos números de uma vez, que contém a chave do projeto com hífen); quem decide é `mentionedKeys`.
   * Uma consulta só, não uma por ticket novo.
   */
  async backfillMentionsTo(tx: TenantClient, project: ProjectRow, created: readonly { id: string; number: number }[]): Promise<void> {
    if (created.length === 0) return;
    const newIds = new Set(created.map((row) => row.id));
    const prefix = `${project.key}-`;
    const candidates = await tx.ticket.findMany({
      where: {
        projectId: project.id,
        id: { notIn: [...newIds] },
        ...(created.length <= MANY
          ? { OR: created.map((row) => ({ description: { contains: `${prefix}${row.number}` } })) }
          : { description: { contains: prefix } }),
      },
      select: { id: true, number: true, description: true },
    });
    const newNumbers = new Set(created.map((row) => row.number));
    const sources = candidates.filter((candidate) => this.mentionedNumbers(project, candidate).some((number) => newNumbers.has(number)));
    await this.reconcileMentions(tx, project, sources);
  }

  /** Refaz as ligações `mentions` de todos os tickets do projeto (ferramenta local) e devolve as contagens. */
  async rebuildMentions(tx: TenantClient, project: ProjectRow): Promise<{ read: number } & MentionCounts> {
    const sources = await tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, number: true, description: true } });
    return { read: sources.length, ...(await this.reconcileMentions(tx, project, sources)) };
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
      /** Registra a ideia (ADR 0042): estágio `new`, situação sempre `todo`. */
      idea?: boolean;
    },
    extraPayload: Record<string, string> = {},
  ): Promise<TicketDetail> {
    if (input.parentId) {
      await this.lockStructure(tx, project.id); // ADR 0045: antes de conferir que o pai existe e de ler a ideia que o contém.
      await this.requireParent(tx, project.id, input.parentId);
    }
    // Ideia, ou ticket dentro de uma: fora do processo (ADR 0042). A situação fica em `todo` e o pai concluído não é reaberto.
    const parentIdea = await this.ideaRootFor(tx, input.parentId);
    const outside = input.idea === true || parentIdea !== null;
    if (outside && input.status !== "todo") {
      throw new ConflictException({ code: "ticket_in_idea", message: "Dentro de uma ideia a situação fica em a fazer; aceite a ideia antes." });
    }
    const assigneeIds = [...new Set(input.assigneeIds)];
    for (const personId of assigneeIds) await this.requireAssignable(tx, project, personId);

    const number = await this.allocateNumbers(tx, project, 1);
    if (input.parentId && !isFinished(input.status) && !outside) {
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
        ...(input.idea ? { ideaStage: "new" } : {}),
        createdByPersonId: principal.person.id,
      },
    });
    await this.syncMentions(tx, project, created, created.description);
    await this.backfillMentionsTo(tx, project, [created]);
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
    if (input.idea) {
      await this.activity.record(tx, principal, {
        kind: "ticket.idea_registered",
        subjectType: "ticket",
        subjectId: created.id,
        payload: { key: `${project.key}-${number}`, source: "created" },
      });
    }
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
    await this.lockStructure(tx, project.id); // ADR 0045: o lugar, os tickets e o agrupamento são conferidos já com a trava.
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
