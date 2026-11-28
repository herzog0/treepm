import { lockProjectStructure } from "./structure-lock.js";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { agentWorkIsValid, canEditContributions, canEditTicket, canMoveIntoIdea, canTriageIdea, createsDependencyCycle, DependencyGraph, deriveParentStatuses, descriptionExcerpt, relatedPair, mentionsPersonRaw, ideaRootsOf, isFinished, mentionedKeys, parentWouldCreateCycle, safeLinearKey, safeLinearUrl, statusChangeAllowed } from "@treepm/domain";
import type { Actor, DependencyNeed, IdeaStage, QueuePlace, TicketNode, TicketStatus, ticketProgress } from "@treepm/domain";
import { buildActor } from "../access/actor.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { AgentWorkService } from "./agent-work.service.js";
import { ideaRootOfTicket } from "./idea-root.js";
import { MAX_TREE_DEPTH, scopeOf } from "./ticket-scope.js";
import { dependencyNeedSchema, ideaStageSchema, ticketDetailSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { AgentWork, EffectivePriorityView, ExternalSourceView, ImpedimentView, TicketDetail, TicketIdea, TicketPage, TicketSummary, updateTicketSchema } from "./tickets.schema.js";
import { readContributions } from "./ticket-contributions.read.js";
import { readBranchOf } from "./ticket-reads.js";
import { ticketLabelsOf } from "./labels.service.js";
import type { LabelView } from "./labels.schema.js";
import { dueDateText, dueDateValue } from "./due-date.js";
import { touchProjectVersion } from "./project-version.js";
import { forgetRelationOrigins, linearRelationIds } from "../linear/linear-relation-origins.js";

/** `n` ids novos (`app_uuid_v7()`) numa consulta só (a importação cria centenas de ligações por página). */
async function newIds(tx: TenantClient, n: number): Promise<string[]> {
  if (n === 0) return [];
  return (await tx.$queryRaw<{ id: string }[]>`select app_uuid_v7() as id from generate_series(1, ${n}::int)`).map((row) => row.id);
}

/** Teto de "relacionado a" na página do ticket: o mesmo do MCP (`RELATED_MAX` da consulta do projeto), os de menor número primeiro. */
const RELATED_PAGE_MAX = 200;

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
  /** Prioridade própria (ADR 0047); ausente = 0. */
  priority?: number;
  /** Prazo (ADR 0064), `AAAA-MM-DD`; ausente = sem prazo. A linha do Prisma passa por `dueDateText`. */
  dueDate?: string | null;
  /** Bloqueado (ADR 0068): aberto e com impedimento marcado; ausente = não (quem monta a linha sem ler o impedimento, como a criação). */
  blocked?: boolean;
  /** Lugar na fila (ADR 0068, seção 4), lido por `readSummaryRows` ou `readBranchOf`; ausente = nulo (quem monta a linha sem ler as dependências). */
  place?: QueuePlace | null;
  /** Etiquetas (ADR 0065), já na ordem de saída; ausente = nenhuma (o ticket recém-criado ou importado nasce sem etiqueta). */
  labels?: LabelView[];
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

/** Janela em que o mesmo `requestId` do mesmo token vale como repetição (ADR 0043) e quantos tickets recentes o projeto olha. */
const REQUEST_REPEAT_WINDOW_MS = 10 * 60_000;
/** Teto da busca: 10 lotes de 500 = os 5 000 tickets mais novos do projeto. */
const REQUEST_LOOKBACK_BATCH_SIZE = 500;
const REQUEST_LOOKBACK_BATCHES = 10;

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
    priority: row.priority ?? 0,
    dueDate: row.dueDate ?? null,
    blocked: row.blocked ?? false,
    // Ideia (raiz ou dentro) não tem lugar na fila (ADR 0068, seção 4); o SQL (`QUEUE_PLACE_SQL`) já a tira, e aqui fica a mesma regra.
    place: idea === null ? (row.place ?? null) : null,
    labels: row.labels ?? [],
  };
}

/** O outro lado de uma ligação na página do ticket; `dueDate` como o Prisma lê (passa por `dueDateText`). */
export type MentionedByRow = { number: number; id: string; title: string; status: string; dueDate?: Date | null };
/** Uma ligação mostrada na página do ticket, com a marca de que veio do Linear (ADR 0061, fatia 3). */
export type LinkRow = MentionedByRow & { fromLinear?: boolean };
/** Uma dependência mostrada na página do ticket, com o tipo (ADR 0068). */
export type DependencyRow = LinkRow & { need: DependencyNeed };

/** Bloqueado (ADR 0068, seção 5): o ticket aberto com impedimento marcado. Um impedimento que sobrou num ticket finalizado não conta. */
export function isBlocked(row: { status: string; impedimentReason?: string | null }): boolean {
  return (row.impedimentReason ?? null) !== null && !isFinished(statusOf(row));
}

export function toDetail(project: Pick<ProjectRow, "key">, row: TicketDetailRow, progress: Progress,
  idea: TicketIdea = null,
  mentionedBy: readonly MentionedByRow[] = [],
  dependsOn: readonly DependencyRow[] = [],
  blocks: readonly DependencyRow[] = [],
  now: number = Date.now(),
  agentWorkBy: { id: string; displayName: string; avatarUrl: string | null } | null = null,
  effectivePriority: EffectivePriorityView = { value: row.priority ?? 0, from: null },
  externalSource: ExternalSourceView | null = null,
  related: readonly LinkRow[] = [],
  impediment: ImpedimentView = null,
): TicketDetail {
  const mention = (from: MentionedByRow) => ({ id: from.id, key: `${project.key}-${from.number}`, title: from.title, status: from.status, dueDate: dueDateText(from.dueDate) });
  const link = (from: LinkRow) => ({ ...mention(from), fromLinear: from.fromLinear === true });
  const dependency = (from: DependencyRow) => ({ ...link(from), need: from.need });
  return parseOutput(ticketDetailSchema, {
    ...toSummary(project, { ...row, blocked: impediment !== null }, progress, idea, now),
    effectivePriority,
    externalSource,
    agentWork: toAgentWork(row, now) && agentWorkBy ? { ...(toAgentWork(row, now) as AgentWork), by: agentWorkBy } : null,
    description: row.description,
    mentionedBy: mentionedBy.map(mention),
    dependsOn: dependsOn.map(dependency),
    blocks: blocks.map(dependency),
    related: related.map(link),
    impediment,
    createdByPersonId: row.createdByPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Uma linha travada por `lockTicketSet`, como o banco a devolve. */
export type AncestorRow = { id: string; parent_id: string | null; status: string; idea_stage: string | null; number: number };

/** Os ids da floresta `parents` (id → pai), do mais fundo para a raiz; na mesma profundidade, por id. */
function deepestFirst(parents: ReadonlyMap<string, string | null>): string[] {
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const path: string[] = [];
    let cursor: string | null = id;
    let base = 0;
    while (cursor !== null && parents.has(cursor) && !path.includes(cursor)) {
      const cached = depth.get(cursor);
      if (cached !== undefined) {
        base = cached + 1;
        break;
      }
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    path.reverse().forEach((node, index) => depth.set(node, base + index));
    return depth.get(id) as number;
  };
  return [...parents.keys()].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : a > b ? 1 : 0));
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
   * projeto arquivado (409), pai e ciclo, ideias, a regra 5 das ideias com a linha travada, a situação calculada de um pai
   * (409 `status_is_derived`, ADR 0068), a gravação e o evento e, por fim, a situação refeita dos pais (antigo e novo) até a raiz.
   * `options.event` acrescenta campos ao evento (um processo automático marca `automatic` e a origem; nunca muda as regras acima).
   */
  async updateTicket(tx: TenantClient, principal: Principal, id: string, body: UpdateTicketInput, options: { event?: Record<string, unknown> } = {}): Promise<TicketPage> {
    const found = await this.findVisibleTicket(tx, principal.actor, id);
    const { project } = found;
    let { ticket } = found;
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    this.requireNoPersonMention(body.description, body.title);
    if (body.parentId !== undefined) {
      // Mudança de estrutura (ADR 0045): a trava vem antes de qualquer conferência que leia a árvore, e o ticket é lido de novo
      // com ela (o pai atual pode ter mudado enquanto esperávamos).
      await this.lockStructure(tx, project.id);
      ticket = (await this.findVisibleTicket(tx, principal.actor, id)).ticket;
    }
    // Concluir confere as dependências "para entregar" (ADR 0068): a trava de dependências vem antes de qualquer trava de linha (ADR 0046).
    if (body.status === "done" && ticket.status !== "done") await this.lockDependencies(tx, project.id);

    if (body.parentId !== undefined && body.parentId !== null) {
      await this.requireParent(tx, project.id, body.parentId);
    }
    if (body.parentId !== undefined && body.parentId !== ticket.parentId) {
      // Só a cadeia do pai novo para cima (uma consulta recursiva), não o projeto inteiro: a conferência só anda por ela.
      const parents = await this.ancestorLinks(tx, project, body.parentId);
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
      priority?: number;
      dueDate?: Date | null;
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
    // Prioridade (ADR 0047): não é mudança de estrutura (sem a trava da ADR 0045) e o `updated_at` anda com a gravação.
    if (body.priority !== undefined && body.priority !== ticket.priority) {
      data.priority = body.priority;
      changes["priority"] = { from: ticket.priority, to: body.priority };
    }
    // Prazo (ADR 0064): como a prioridade, sem trava de estrutura. O evento guarda o texto `AAAA-MM-DD` (ou nulo), nunca a data com hora.
    const currentDue = dueDateText(ticket.dueDate);
    if (body.dueDate !== undefined && body.dueDate !== currentDue) {
      data.dueDate = dueDateValue(body.dueDate);
      changes["dueDate"] = { from: currentDue, to: body.dueDate };
    }
    const fields = Object.keys(data);
    // Versão do projeto (ADR 0046): só marca; o toque sai no fim da transação. Tudo o que muda o resumo passa por `fields`
    // (refazer a situação dos pais, encerrar marcador e limpar a subárvore só acontecem quando `data.status` ou `data.parentId` existem).
    if (fields.length > 0) await touchProjectVersion(tx, project.id);
    // A situação ou o pai mudam (ADR 0068, revisão 1): antes de qualquer outra trava de linha, a ordem única (`lockTicketSet`) trava
    // num comando só o ticket com a subida dele, a subida do pai novo e, se a mudança cruza a borda de uma ideia, a subárvore. O pai
    // atual é o lido COM a trava: uma mudança só de situação que leu o ticket antes de um movimento confirmar sobe pelo pai novo.
    let currentParent = ticket.parentId;
    if (data.status !== undefined || data.parentId !== undefined) {
      // Mudança de pai: com a trava de estrutura, as ideias em volta não mudam até o fim, então a leitura sem trava de linha vale.
      const crossing = data.parentId !== undefined && ticket.ideaStage === null && ((await this.ideaRootFor(tx, project, data.parentId)) !== null || (await this.ideaRootFor(tx, project, ticket.parentId)) !== null);
      const locked = await this.lockTicketSet(tx, project, { ids: [id], ancestorsOf: [id, data.parentId], subtreeOf: crossing ? [id] : [] });
      currentParent = locked.get(id)?.parent_id ?? ticket.parentId;
    }
    const finalParent = body.parentId !== undefined ? body.parentId : currentParent;
    // Ideias (ADR 0042): a raiz, ou um ticket dentro de uma, está fora do processo. A posição que vale é a final: quem sai da
    // ideia no mesmo pedido já muda de situação como ticket comum, e quem entra não muda.
    const parentIdea = data.parentId !== undefined || data.status !== undefined ? await this.ideaRootFor(tx, project, finalParent) : null;
    if (data.parentId !== undefined && parentIdea !== null) {
      // Trabalho em andamento não vira ideia por arrasto: o ticket e os descendentes `todo` ou `cancelled`. A subárvore já está
      // travada (`for update`, acima) antes de ler as situações: uma mudança de situação ainda não confirmada de um descendente
      // faz esta espera e, ao confirmar, é vista (risco residual da ADR 0042, fechado pela ADR 0045).
      // O próprio ticket também é relido depois da trava de linha: a situação da leitura de antes pode já não valer.
      const fresh = await tx.ticket.findFirstOrThrow({ where: { id }, select: { status: true } });
      if (!canMoveIntoIdea(fresh.status as TicketStatus, await this.descendantStatuses(tx, project, id))) {
        throw new ConflictException({
          code: "move_into_idea_blocked",
          message: "Trabalho em andamento, em revisão ou concluído não entra numa ideia; mova só o que ainda está a fazer.",
        });
      }
    }
    if (data.status !== undefined) {
      // Regra 5 (ADR 0042). Trava a linha e confere de novo: uma transformação em ideia que acabou de confirmar vale a partir daqui.
      // O pai e a situação também vêm da linha travada: um movimento para dentro de uma ideia que acabou de confirmar vale a partir daqui.
      const locked = await tx.$queryRaw<{ idea_stage: string | null; parent_id: string | null; status: string }[]>`select idea_stage, parent_id, status from tickets where id = ${id}::uuid for update`;
      const lockedParent = body.parentId !== undefined ? body.parentId : (locked[0]?.parent_id ?? null);
      const inside = locked[0]?.idea_stage != null || (await this.ideaRootFor(tx, project, lockedParent)) !== null;
      if (!statusChangeAllowed(inside, (locked[0]?.status ?? ticket.status) as TicketStatus, data.status as TicketStatus)) this.throwInIdea();
      // ADR 0068: a situação de um pai sai dos filhos. Contados já com a linha travada: a chave estrangeira de um filho novo ainda
      // não confirmado trava esta linha, então a mudança espera e, ao confirmar, o vê.
      if (!inside) await this.requireNotDerived(tx, id);
    }
    // Concluir exige as dependências "para entregar" finalizadas (ADR 0068, seção 3); a trava de dependências já foi pega no começo.
    if (data.status === "done") await this.requireNoOpenDeliveryDependencies(tx, project, id);
    // O marcador de trabalho pela IA (ADR 0043) acaba ANTES da gravação da situação: o banco recusa concluído ou cancelado com marcador.
    if (data.status === "done" || data.status === "cancelled") await this.agentWork.clearTicket(tx, principal, project.key, id, "finished");
    // Concluir ou cancelar limpa o impedimento (ADR 0068, seção 5), com o evento automático.
    if (data.status === "done" || data.status === "cancelled") await this.clearImpedimentOf(tx, principal, project, ticket, { automatic: true, cause: "finished" });
    if (fields.length > 0) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, fields, ...changes, ...(options.event ?? {}) },
      });
    }
    // A situação calculada (ADR 0068): o pai de agora (e o antigo, numa mudança de pai) e os ancestrais, até a raiz. Quem sai de
    // uma ideia volta ao processo com a subárvore: os pais de dentro dela, parados até aqui, são refeitos também.
    if (data.status !== undefined || data.parentId !== undefined) {
      const leftIdea = data.parentId !== undefined && ticket.ideaStage === null && parentIdea === null && (await this.ideaRootFor(tx, project, currentParent)) !== null;
      const starts = [finalParent, ...(data.parentId !== undefined ? [currentParent] : []), ...(leftIdea ? await this.subtreeParents(tx, project, id) : [])];
      await this.deriveStatuses(tx, principal, project, starts, { causedBy: `${project.key}-${ticket.number}`, ...(options.event ?? {}) });
    }
    // Entrando numa ideia, o marcador acaba junto, com a subárvore.
    if (data.parentId !== undefined && parentIdea !== null) await this.agentWork.clearSubtree(tx, principal, project, id, "idea");
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
   * Situação calculada (ADR 0068): o ticket tem pelo menos um filho que não é ideia, e então a situação dele sai dos filhos e não
   * é marcada à mão (409 `status_is_derived`). Quem chama já travou a linha do ticket e sabe que ele não está dentro de uma ideia.
   */
  private async requireNotDerived(tx: TenantClient, id: string): Promise<void> {
    if ((await tx.ticket.count({ where: { parentId: id, ideaStage: null } })) > 0) {
      throw new ConflictException({ code: "status_is_derived", message: "A situação deste ticket vem dos itens dele; mude a situação dos itens." });
    }
  }

  /**
   * Concluir exige as dependências "para entregar" finalizadas (ADR 0068, seção 3): 409 `ticket_has_open_delivery_dependencies` com as
   * chaves que faltam em `details.keys`, em ordem de número. Cancelar não passa por aqui. Quem chama já pegou a trava de dependências
   * (antes das travas de linha): uma ligação nova ainda não confirmada faz a conclusão esperar.
   */
  private async requireNoOpenDeliveryDependencies(tx: TenantClient, project: ProjectRow, id: string): Promise<void> {
    const open = await tx.ticketRelation.findMany({
      where: { fromTicketId: id, kind: "depends_on", need: "deliver", to: { status: { notIn: ["done", "cancelled"] } } },
      select: { to: { select: { number: true } } },
    });
    if (open.length === 0) return;
    const keys = open.map((relation) => relation.to.number).sort((a, b) => a - b).map((number) => `${project.key}-${number}`);
    throw new ConflictException({
      code: "ticket_has_open_delivery_dependencies",
      message: `Este ticket só pode ser concluído quando ${keys.join(", ")} ficar pronto.`,
      details: { keys },
    });
  }

  /**
   * Marca o impedimento (ADR 0068, seção 5): o ticket fica bloqueado, com o motivo, quem marcou e quando. Mesmas conferências de editar
   * o ticket (404, 403, projeto arquivado 409); ticket concluído ou cancelado: 409 `ticket_finished`. Marcar de novo troca o motivo.
   * O evento não leva o motivo (texto novo da pessoa, fora do que vai à IA até o `TREEPM-580`); o detalhe o mostra.
   */
  async markImpediment(tx: TenantClient, principal: Principal, id: string, reason: string): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    // A linha travada pela ordem única (`lockTicketSet`) decide a situação: uma conclusão que acabou de confirmar vale a partir daqui.
    await this.lockTicketSet(tx, project, { ids: [id] });
    const locked = await tx.$queryRaw<{ status: string; impediment_reason: string | null }[]>`select status, impediment_reason from tickets where id = ${id}::uuid`;
    if (isFinished(statusOf({ status: locked[0]?.status ?? ticket.status }))) {
      throw new ConflictException({ code: "ticket_finished", message: "Ticket concluído ou cancelado não recebe impedimento." });
    }
    if (locked[0]?.impediment_reason !== reason) {
      await touchProjectVersion(tx, project.id); // ADR 0046: `blocked` do resumo muda.
      await tx.ticket.update({
        where: { orgId_id: { orgId: project.orgId, id } },
        data: { impedimentReason: reason, impedimentPersonId: principal.person.id, impedimentAt: new Date(this.clock.now()) },
      });
      await this.activity.record(tx, principal, {
        kind: "ticket.impediment_marked",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}` },
      });
    }
    return this.detailFor(tx, project, id, principal);
  }

  /** Limpa o impedimento (ADR 0068, seção 5): mesmas conferências de `markImpediment`; sem impedimento, nada muda (sem evento). */
  async clearImpediment(tx: TenantClient, principal: Principal, id: string): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    // A linha pela ordem única (`lockTicketSet`), antes da gravação.
    await this.lockTicketSet(tx, project, { ids: [id] });
    await this.clearImpedimentOf(tx, principal, project, ticket);
    return this.detailFor(tx, project, id, principal);
  }

  /** Apaga o impedimento do ticket, se houver, com o evento (`extra` marca o automático, ao concluir ou cancelar). */
  private async clearImpedimentOf(tx: TenantClient, principal: Principal, project: ProjectRow, ticket: { id: string; number: number }, extra: Record<string, unknown> = {}): Promise<void> {
    await this.clearImpediments(tx, principal, project, [ticket.id], extra);
  }

  /**
   * Limpa o impedimento (ADR 0068, seção 5) de cada ticket de `ticketIds` que tiver um, dentro da transação de quem chama, com um evento
   * `ticket.impediment_cleared` por ticket limpo (`extra` vai no evento: quem conclui ou cancela passa `{ automatic: true, cause:
   * "finished" }` e a origem). É o caminho ÚNICO para limpar: todo lugar que leva um ticket a concluído ou cancelado o chama (a tela,
   * a sincronização com o Linear e a situação calculada do pai). Ticket sem impedimento não muda nem ganha evento. Devolve os ids limpos.
   */
  async clearImpediments(tx: TenantClient, principal: Principal, project: Pick<ProjectRow, "id" | "key">, ticketIds: readonly string[], extra: Record<string, unknown> = {}): Promise<string[]> {
    if (ticketIds.length === 0) return [];
    const cleared = await tx.$queryRaw<{ id: string; number: number }[]>`
      update tickets set impediment_reason = null, impediment_person_id = null, impediment_at = null
       where project_id = ${project.id}::uuid and id = any(${[...new Set(ticketIds)]}::uuid[]) and impediment_reason is not null
      returning id, number`;
    if (cleared.length === 0) return [];
    await touchProjectVersion(tx, project.id); // ADR 0046: `blocked` do resumo muda.
    for (const row of [...cleared].sort((a, b) => a.number - b.number)) {
      await this.activity.record(tx, principal, {
        kind: "ticket.impediment_cleared",
        subjectType: "ticket",
        subjectId: row.id,
        payload: { key: `${project.key}-${row.number}`, ...extra },
      });
    }
    return cleared.map((row) => row.id);
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
   * A ORDEM ÚNICA das travas de linhas de tickets (ADR 0068, revisão 1): todo caminho que trava várias linhas de tickets de um
   * projeto pega o conjunto inteiro de que precisa NUM comando só, `for update`, em ordem crescente de `id`. O conjunto é: `ids`, mais
   * cada ticket de `ancestorsOf` com todos os ancestrais, mais cada ticket de `subtreeOf` com todos os descendentes. Como todos usam a
   * mesma ordem, nenhum caminho trava A e depois B enquanto outro trava B e depois A.
   *
   * Depois da trava, os pais são relidos: se um movimento que confirmou entre a leitura e a trava deu outro pai a algum ticket da
   * subida (a mudança só de situação não pega a trava de estrutura), o pai novo e os ancestrais dele são travados num segundo comando.
   * Só esse passo sai da ordem; no pior caso o PostgreSQL desfaz o impasse e a API responde 409 `concurrent_update` (dá para repetir).
   * Deve rodar antes da reserva de números (a linha do projeto fica por último, ADR 0046). Devolve as linhas, lidas já com a trava.
   */
  async lockTicketSet(
    tx: TenantClient,
    project: Pick<ProjectRow, "orgId" | "id">,
    spec: { ids?: readonly (string | null | undefined)[]; ancestorsOf?: readonly (string | null | undefined)[]; subtreeOf?: readonly (string | null | undefined)[] },
  ): Promise<Map<string, AncestorRow>> {
    const clean = (list: readonly (string | null | undefined)[] | undefined): string[] => [...new Set((list ?? []).filter((id): id is string => typeof id === "string"))];
    const up = clean(spec.ancestorsOf);
    const locked = new Map<string, AncestorRow>();
    const tried = new Set<string>();
    let wanted = await this.ticketSetIds(tx, project, clean(spec.ids), up, clean(spec.subtreeOf));
    for (;;) {
      const fresh = wanted.filter((id) => !tried.has(id)).sort();
      for (const id of fresh) tried.add(id);
      if (fresh.length > 0) {
        // `order by` com `for update`: as linhas são travadas na ordem em que saem.
        const rows = await tx.$queryRaw<AncestorRow[]>`
          select id, parent_id, status, idea_stage, number from tickets
          where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = any(${fresh}::uuid[])
          order by id for update`;
        for (const row of rows) locked.set(row.id, row);
      }
      // A subida de cada ticket de `ancestorsOf` tem de estar inteira, pelos pais relidos com a trava.
      const missing = new Set<string>();
      for (const start of up) {
        const seen = new Set<string>();
        for (let cursor: string | null = start; cursor !== null && !seen.has(cursor); ) {
          seen.add(cursor);
          const row = locked.get(cursor);
          if (!row) {
            if (!tried.has(cursor)) missing.add(cursor); // pai novo, de um movimento que confirmou no meio
            break; // tentado e não achado: o ticket foi removido
          }
          cursor = row.parent_id;
        }
      }
      if (missing.size === 0) return locked;
      wanted = await this.ticketSetIds(tx, project, [], [...missing], []);
    }
  }

  /** Os ids do conjunto de `lockTicketSet`, lidos sem trava numa consulta só: `ids`, as subidas de `up` e as descidas de `down`. */
  private async ticketSetIds(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, ids: readonly string[], up: readonly string[], down: readonly string[]): Promise<string[]> {
    if (up.length === 0 && down.length === 0) return [...ids];
    const rows = await tx.$queryRaw<{ id: string }[]>`
      with recursive up as (
        select org_id, project_id, id, parent_id, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = any(${[...up]}::uuid[])
        union all
        select t.org_id, t.project_id, t.id, t.parent_id, up.depth + 1
        from tickets t join up on t.org_id = up.org_id and t.project_id = up.project_id and t.id = up.parent_id
        where up.depth < ${MAX_TREE_DEPTH}::int
      ), down as (
        select org_id, project_id, id, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = any(${[...down]}::uuid[])
        union all
        select t.org_id, t.project_id, t.id, down.depth + 1
        from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
        where down.depth < ${MAX_TREE_DEPTH}::int
      )
      select id from up union select id from down`;
    return [...new Set([...ids, ...rows.map((row) => row.id)])];
  }

  /**
   * Refaz a situação calculada (ADR 0068) dos tickets `starts` e de todos os ancestrais, até a raiz, na transação de quem escreveu:
   * trava a cadeia (`lockTicketSet`), lê os filhos DEPOIS da trava e grava, de baixo para cima, só o que mudou. Cada mudança tem o
   * evento automático (`automatic`, `causedBy` e os campos de `event`), marca a versão do projeto e, ao concluir ou cancelar, encerra
   * antes o marcador de trabalho pela IA (como numa conclusão à mão). Quem tem a situação marcada à mão (sem filho que não é ideia,
   * ou dentro de uma ideia) fica como está.
   */
  async deriveStatuses(tx: TenantClient, principal: Principal, project: ProjectRow, starts: readonly (string | null | undefined)[], event: Record<string, unknown> = {}): Promise<void> {
    const ids = [...new Set(starts.filter((id): id is string => typeof id === "string"))];
    if (ids.length === 0) return;
    // A cadeia de cada ponto de partida até a raiz, travada pela ordem única (quase sempre já travada por quem chamou).
    const locked = await this.lockTicketSet(tx, project, { ancestorsOf: ids });
    const links = new Map<string, string | null>();
    for (const start of ids) {
      for (let row = locked.get(start); row && !links.has(row.id); row = row.parent_id === null ? undefined : locked.get(row.parent_id)) links.set(row.id, row.parent_id);
    }
    const chain = deepestFirst(links).map((id) => locked.get(id) as AncestorRow);
    if (chain.length === 0) return;
    // Os filhos fora da cadeia (sem contar ideias) chegam contados por situação, não um por um: um pai largo não pesa na leitura.
    // Os da cadeia entram pela própria linha travada, com a situação que a conta refaz de baixo para cima.
    const chainIds = chain.map((row) => row.id);
    const counts = await tx.$queryRaw<{ parent_id: string; status: string; n: number }[]>`
      select parent_id, status, count(*)::int as n from tickets
      where org_id = ${project.orgId} and project_id = ${project.id}::uuid and parent_id = any(${chainIds}::uuid[])
        and idea_stage is null and id <> all(${chainIds}::uuid[])
      group by parent_id, status`;
    const others = counts.flatMap((row) => Array.from({ length: row.n }, (_, i) => ({ id: `${row.parent_id}/${row.status}/${i}`, parentId: row.parent_id, status: row.status, ideaStage: null })));
    const nodes = toNodes([...chain.map((row) => ({ id: row.id, parentId: row.parent_id, status: row.status, ideaStage: row.idea_stage })), ...others]);
    const derived = deriveParentStatuses(nodes, chainIds);
    for (const row of chain) {
      const to = derived.get(row.id);
      if (to === undefined || to === row.status) continue;
      await touchProjectVersion(tx, project.id);
      if (isFinished(to)) await this.finishedByDerivation(tx, principal, project, row.id, event);
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id: row.id } }, data: { status: to } });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: row.id,
        payload: { key: `${project.key}-${row.number}`, fields: ["status"], status: { from: row.status, to }, automatic: true, ...event },
      });
    }
  }

  /**
   * O LUGAR ÚNICO dos efeitos de "este ticket acaba de ser concluído ou cancelado pela conta" (ADR 0068), chamado por
   * `deriveStatuses` ANTES de gravar a situação, com o mesmo efeito da conclusão à mão: encerra o marcador de trabalho pela IA (o banco
   * recusa concluído ou cancelado com marcador, ADR 0043) e limpa o impedimento (ADR 0068, seção 5), com o evento automático e a
   * origem da conta (`event`: `causedBy` e, vindo do Linear, `source` e `runId`).
   */
  private async finishedByDerivation(tx: TenantClient, principal: Principal, project: ProjectRow, ticketId: string, event: Record<string, unknown> = {}): Promise<void> {
    await this.agentWork.clearTicket(tx, principal, project.key, ticketId, "finished");
    await this.clearImpediments(tx, principal, project, [ticketId], { ...event, automatic: true, cause: "finished" });
  }

  /** O ticket e os descendentes que têm filhos, qualquer que seja a profundidade: os que podem ter a situação calculada. */
  async subtreeParents(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, id: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      with recursive down as (
        select org_id, project_id, id, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = ${id}::uuid
        union all
        select t.org_id, t.project_id, t.id, down.depth + 1
        from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
        where down.depth < ${MAX_TREE_DEPTH}::int
      )
      select distinct d.id from down d join tickets c on c.org_id = d.org_id and c.project_id = d.project_id and c.parent_id = d.id`;
    return rows.map((row) => row.id);
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
    await touchProjectVersion(tx, project.id); // ADR 0046: criar e importar sempre passam por aqui; o toque sai no fim da transação.
    return updated.nextTicketNumber - count;
  }

  /**
   * ADR 0046, ordem das travas: tudo o que a criação/importação trava em linhas de tickets (o pai, os tickets mencionados e os que
   * citam as chaves novas, pelas chaves estrangeiras de `tickets` e `ticket_relations`), mais a subida do pai e os `extraIds`, é
   * travado AQUI, `for update` pela ordem única (`lockTicketSet`), ANTES da reserva de número, que segura a linha do projeto até o
   * fim. Quem tem `for update` num desses tickets e espera a linha do projeto no toque final não cruza mais com quem cria. Os "que citam" são procurados pelos números que a reserva vai
   * devolver (lidos sem trava, `peekNextNumber`): numa corrida com uma criação sem pai (a única sem a trava de estrutura) o número
   * pode diferir e um ticket citante ficar sem a trava antecipada; o caso restante é aceito (só vira 409 `concurrent_update`
   * retentável, nunca dado errado).
   */
  async lockLinkedTickets(tx: TenantClient, project: ProjectRow, parentId: string | null, descriptions: readonly string[], extraIds: readonly string[] = []): Promise<void> {
    const first = await this.peekNextNumber(tx, project);
    const fresh = new Set(descriptions.map((_d, at) => first + at));
    const ids = new Set<string>([...(parentId === null ? [] : [parentId]), ...extraIds]);
    const mentioned = new Set<number>();
    for (const description of descriptions) for (const number of this.mentionedNumbers(project, { id: "", number: -1, description })) mentioned.add(number);
    if (mentioned.size > 0) {
      for (const row of await tx.ticket.findMany({ where: { projectId: project.id, number: { in: [...mentioned] } }, select: { id: true } })) ids.add(row.id);
    }
    const prefix = `${project.key}-`;
    const candidates = await tx.ticket.findMany({
      where: {
        projectId: project.id,
        ...(fresh.size <= MANY ? { OR: [...fresh].map((number) => ({ description: { contains: `${prefix}${number}` } })) } : { description: { contains: prefix } }),
      },
      select: { id: true, number: true, description: true },
    });
    for (const candidate of candidates) if (this.mentionedNumbers(project, candidate).some((number) => fresh.has(number))) ids.add(candidate.id);
    // A ordem única (`lockTicketSet`): estes, mais a subida do pai (a situação dele sai dos filhos, ADR 0068), num comando só.
    await this.lockTicketSet(tx, project, { ids: [...ids], ancestorsOf: [parentId] });
  }

  /** O próximo número do projeto, lido SEM trava: só para o texto de um evento escrito antes da reserva (ver `create`). */
  async peekNextNumber(tx: TenantClient, project: ProjectRow): Promise<number> {
    const row = await tx.project.findFirstOrThrow({ where: { id: project.id }, select: { nextTicketNumber: true } });
    return row.nextTicketNumber;
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
  async ideaRootFor(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, startId: string | null): Promise<{ id: string; number: number; stage: IdeaStage } | null> {
    return ideaRootOfTicket(tx, scopeOf(project), startId);
  }

  /** O pai de cada ticket da cadeia de `startId` até a raiz (ele incluído), para conferir ciclo subindo de pai em pai. Vazio para `null`. */
  async ancestorLinks(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, startId: string | null): Promise<Map<string, string | null>> {
    const links = new Map<string, string | null>();
    if (startId === null) return links;
    const rows = await tx.$queryRaw<{ id: string; parent_id: string | null }[]>`
      with recursive up as (
        select org_id, project_id, id, parent_id, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = ${startId}::uuid
        union all
        select t.org_id, t.project_id, t.id, t.parent_id, up.depth + 1
        from tickets t join up on t.org_id = up.org_id and t.project_id = up.project_id and t.id = up.parent_id
        where up.depth < ${MAX_TREE_DEPTH}::int
      )
      select id, parent_id from up`;
    for (const row of rows) links.set(row.id, row.parent_id);
    return links;
  }

  /** As situações de todos os descendentes de um ticket (ele não entra), qualquer que seja a profundidade. */
  async descendantStatuses(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, id: string): Promise<TicketStatus[]> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      with recursive down as (
        select org_id, project_id, id, status, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and parent_id = ${id}::uuid
        union all
        select t.org_id, t.project_id, t.id, t.status, down.depth + 1
        from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
        where down.depth < ${MAX_TREE_DEPTH}::int
      )
      select status from down`;
    return rows.map((row) => ticketStatusSchema.parse(row.status));
  }

  canEditContributionsOf(actor: Actor, project: Pick<ProjectRow, "id" | "archivedAt">): boolean {
    return project.archivedAt === null && canEditContributions(actor, project.id);
  }

  async detail(tx: TenantClient, project: ProjectRow, id: string): Promise<TicketDetail> {
    // Progresso e situação de ideia vêm só do ramo do ticket (descendentes e ancestrais), não do projeto inteiro.
    // Progresso e ideia vêm da MESMA consulta (`readBranchOf`): um instantâneo só, então uma escrita concorrente não faz um discordar do outro.
    const [row, branches, labels, mentions, dependencies, origin, related] = await Promise.all([
      tx.ticket.findFirstOrThrow({ where: { id }, include: { assignees: { select: { personId: true } } } }),
      readBranchOf(tx, scopeOf(project), [id]),
      ticketLabelsOf(tx, id),
      tx.ticketRelation.findMany({
        where: { toTicketId: id, kind: "mentions" },
        select: { from: { select: { id: true, number: true, title: true, status: true, dueDate: true } } },
      }),
      tx.ticketRelation.findMany({
        where: { kind: "depends_on", OR: [{ fromTicketId: id }, { toTicketId: id }] },
        select: {
          id: true,
          fromTicketId: true,
          need: true,
          from: { select: { id: true, number: true, title: true, status: true, dueDate: true } },
          to: { select: { id: true, number: true, title: true, status: true, dueDate: true } },
        },
      }),
      tx.ticketExternalRef.findFirst({ where: { ticketId: id }, select: { provider: true, externalKey: true, externalUrl: true, missingSince: true, externalCreatedAt: true, externalStartedAt: true, externalCompletedAt: true, externalCanceledAt: true, creatorPersonId: true, externalCreatorName: true } }),
      // "Relacionado a" (ADR 0061, fatia 3): uma linha por par, mostrada nos dois tickets; até `RELATED_PAGE_MAX` de cada lado, cortados abaixo.
      Promise.all([
        tx.ticketRelation.findMany({ where: { kind: "related", fromTicketId: id }, orderBy: { to: { number: "asc" } }, take: RELATED_PAGE_MAX, select: { id: true, fromTicketId: true, from: { select: { id: true, number: true, title: true, status: true, dueDate: true } }, to: { select: { id: true, number: true, title: true, status: true, dueDate: true } } } }),
        tx.ticketRelation.findMany({ where: { kind: "related", toTicketId: id }, orderBy: { from: { number: "asc" } }, take: RELATED_PAGE_MAX, select: { id: true, fromTicketId: true, from: { select: { id: true, number: true, title: true, status: true, dueDate: true } }, to: { select: { id: true, number: true, title: true, status: true, dueDate: true } } } }),
      ]).then(([outgoing, incoming]) => [...outgoing, ...incoming].sort((a, b) => (a.fromTicketId === id ? a.to : a.from).number - (b.fromTicketId === id ? b.to : b.from).number).slice(0, RELATED_PAGE_MAX)),
    ]);
    const fromLinear = await linearRelationIds(tx, [...dependencies, ...related].map((relation) => relation.id));
    const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);
    const externalSource: ExternalSourceView | null = origin
      ? {
          provider: "linear",
          // Só com forma validada (TREEPM-496): valor antigo fora da forma não é regravado, só deixa de sair.
          key: safeLinearKey(origin.externalKey),
          url: safeLinearUrl(origin.externalUrl),
          missingSince: iso(origin.missingSince),
          createdAt: iso(origin.externalCreatedAt),
          startedAt: iso(origin.externalStartedAt),
          completedAt: iso(origin.externalCompletedAt),
          canceledAt: iso(origin.externalCanceledAt),
          creator: origin.creatorPersonId !== null ? { personId: origin.creatorPersonId } : origin.externalCreatorName !== null ? { name: origin.externalCreatorName } : null,
        }
      : null;
    const branchProgress = branches.get(id)?.progress ?? null;
    const progress = new Map(branchProgress ? [[id, branchProgress] as const] : []);
    const ideaRoot = branches.get(id)?.ideaRoot ?? null;
    const idea: TicketIdea = ideaRoot === null ? null : ideaRoot.id === id ? { root: true, stage: ideaRoot.stage } : { root: false, rootId: ideaRoot.id, rootKey: `${project.key}-${ideaRoot.number}` };
    const mentionedBy = mentions.map((relation) => relation.from).sort((a, b) => a.number - b.number);
    const byNumber = (a: MentionedByRow, b: MentionedByRow) => a.number - b.number;
    const marked = (relation: { id: string }, ticket: MentionedByRow): LinkRow => ({ ...ticket, fromLinear: fromLinear.has(relation.id) });
    const withNeed = (relation: { id: string; need: string | null }, ticket: MentionedByRow): DependencyRow => ({ ...marked(relation, ticket), need: dependencyNeedSchema.parse(relation.need) });
    const dependsOn = dependencies.filter((relation) => relation.fromTicketId === id).map((relation) => withNeed(relation, relation.to)).sort(byNumber);
    const blocks = dependencies.filter((relation) => relation.fromTicketId !== id).map((relation) => withNeed(relation, relation.from)).sort(byNumber);
    const relatedTo = related.map((relation) => marked(relation, relation.fromTicketId === id ? relation.to : relation.from)).sort(byNumber);
    const now = this.clock.now();
    const by = toAgentWork(row, now) && row.agentWorkPersonId
      ? await tx.person.findFirst({ where: { id: row.agentWorkPersonId }, select: { id: true, displayName: true, avatarUrl: true } })
      : null;
    // A prioridade que vale sai da MESMA consulta recursiva do ramo (a subida pelos ancestrais já está nela): um instantâneo só.
    const source = branches.get(id)?.prioritySource ?? null;
    const effective = source ? { value: source.value, from: { id: source.id, key: `${project.key}-${source.number}` } } : { value: 0, from: null };
    const impededBy = isBlocked(row) && row.impedimentPersonId
      ? await tx.person.findFirst({ where: { id: row.impedimentPersonId }, select: { id: true, displayName: true, avatarUrl: true } })
      : null;
    const impediment: ImpedimentView = impededBy && row.impedimentReason !== null && row.impedimentAt !== null ? { reason: row.impedimentReason, by: impededBy, at: row.impedimentAt.toISOString() } : null;
    const place = branches.get(id)?.place ?? null;
    return toDetail(project, { ...row, dueDate: dueDateText(row.dueDate), labels, place }, progress, idea, mentionedBy, dependsOn, blocks, now, by, effective, externalSource, relatedTo, impediment);
  }

  /**
   * Grava, em lote, as dependências que a sincronização com o Linear trouxe (ADR 0061, fatia 3), pelas MESMAS regras de `linkDependency`:
   * a trava de dependências do projeto, a ligação a si mesmo e o ciclo recusados, a que já existe devolvida como `exists` (com o id, para a
   * origem adotá-la). Sem evento por ligação: quem chama grava um por ticket. As ligações são conferidas em ordem, cada uma contra as
   * anteriores já aceitas, num grafo montado UMA vez (`DependencyGraph`) e ids gerados num lance só.
   *
   * `remove`: linhas de `ticket_relations` (de qualquer tipo) que a sincronização substitui (relação editada no Linear), apagadas JÁ sob a
   * trava e antes de ler as ligações: a forma antiga não conta para o ciclo da nova.
   */
  async importDependencies(tx: TenantClient, project: ProjectRow, pairs: readonly { from: string; to: string }[], remove: readonly string[] = []): Promise<({ outcome: "created" | "exists"; id: string } | { outcome: "cycle" | "self" })[]> {
    if (pairs.length === 0 && remove.length === 0) return [];
    await this.lockDependencies(tx, project.id);
    if (remove.length > 0) {
      const removed = await tx.ticketRelation.deleteMany({ where: { projectId: project.id, id: { in: [...remove] }, kind: { in: ["depends_on", "related"] } } });
      if (removed.count > 0) await touchProjectVersion(tx, project.id);
    }
    if (pairs.length === 0) return [];
    const rows = await tx.ticketRelation.findMany({ where: { projectId: project.id, kind: "depends_on" }, select: { id: true, fromTicketId: true, toTicketId: true } });
    const graph = new DependencyGraph(rows.map((row) => [row.fromTicketId, row.toTicketId] as const));
    const existing = new Map(rows.map((row) => [`${row.fromTicketId}>${row.toTicketId}`, row.id] as const));
    const results: ({ outcome: "created" | "exists"; id: string } | { outcome: "cycle" | "self" })[] = [];
    const toCreate: { index: number; from: string; to: string }[] = [];
    for (const { from, to } of pairs) {
      if (from === to) {
        results.push({ outcome: "self" });
        continue;
      }
      const found = existing.get(`${from}>${to}`);
      if (found !== undefined) {
        results.push({ outcome: "exists", id: found });
        continue;
      }
      if (graph.wouldCycle(from, to)) {
        results.push({ outcome: "cycle" });
        continue;
      }
      graph.add(from, to);
      existing.set(`${from}>${to}`, "");
      toCreate.push({ index: results.length, from, to });
      results.push({ outcome: "created", id: "" });
    }
    if (toCreate.length > 0) {
      const ids = await newIds(tx, toCreate.length);
      toCreate.forEach((edge, i) => {
        results[edge.index] = { outcome: "created", id: ids[i] as string };
        existing.set(`${edge.from}>${edge.to}`, ids[i] as string);
      });
      // Repetida na mesma página (duas relações do Linear que dão a mesma ligação): a segunda é `exists` com o id da primeira.
      pairs.forEach(({ from, to }, i) => {
        const result = results[i];
        if (result?.outcome === "exists" && result.id === "") results[i] = { outcome: "exists", id: existing.get(`${from}>${to}`) as string };
      });
      await touchProjectVersion(tx, project.id); // ADR 0046 (rev. 3): o lugar na fila dos dependentes muda.
      // `blocks` do Linear vira "para começar" (ADR 0068, seção 3); escolher o tipo na importação é da ADR da importação (`TREEPM-575`).
      await tx.ticketRelation.createMany({ data: toCreate.map((edge, i) => ({ id: ids[i] as string, orgId: project.orgId, projectId: project.id, fromTicketId: edge.from, toTicketId: edge.to, kind: "depends_on", need: "start" })) });
    }
    return results;
  }

  /**
   * "Relacionado a" trazido do Linear, em lote: uma linha por par (o menor id primeiro); a que já existe (ou repetida na mesma página) é
   * devolvida como `exists` para a origem adotá-la.
   */
  async importRelatedMany(tx: TenantClient, project: ProjectRow, pairs: readonly { a: string; b: string }[]): Promise<({ outcome: "created" | "exists"; id: string } | { outcome: "self" })[]> {
    if (pairs.length === 0) return [];
    const ordered = pairs.map(({ a, b }) => (a === b ? null : relatedPair(a, b)));
    const wanted = ordered.flatMap((pair) => (pair === null ? [] : [pair]));
    const found = wanted.length === 0 ? [] : await tx.ticketRelation.findMany({ where: { kind: "related", OR: wanted.map(([from, to]) => ({ fromTicketId: from, toTicketId: to })) }, select: { id: true, fromTicketId: true, toTicketId: true } });
    const existing = new Map<string, string>(found.map((row) => [`${row.fromTicketId}~${row.toTicketId}`, row.id]));
    const fresh = [...new Set(wanted.map(([from, to]) => `${from}~${to}`).filter((key) => !existing.has(key)))];
    const ids = await newIds(tx, fresh.length);
    const created = new Map(fresh.map((key, i) => [key, ids[i] as string] as const));
    if (fresh.length > 0) {
      await tx.ticketRelation.createMany({ data: fresh.map((key) => { const [from, to] = key.split("~") as [string, string]; return { id: created.get(key) as string, orgId: project.orgId, projectId: project.id, fromTicketId: from, toTicketId: to, kind: "related" }; }) });
    }
    const first = new Set<string>();
    return ordered.map((pair) => {
      if (pair === null) return { outcome: "self" };
      const key = `${pair[0]}~${pair[1]}`;
      const id = created.get(key);
      if (id !== undefined && !first.has(key)) {
        first.add(key);
        return { outcome: "created", id };
      }
      return { outcome: "exists", id: (id ?? existing.get(key)) as string };
    });
  }

  /**
   * Tira "relacionado a" entre dois tickets (rota `DELETE tickets/:id/related/:otherId`): as conferências de `removeDependency`;
   * inexistente é 404. Por ora não se cria `related` pela tela: só vem do Linear (ADR 0061, fatia 3).
   */
  async removeRelated(tx: TenantClient, principal: Principal, id: string, otherId: string): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    const other = await this.requireSameProjectTicket(tx, project.id, otherId);
    // A trava de dependências, a mesma da importação do Linear: um passo da sincronização não desfaz esta remoção (ADR 0061, fatia 3).
    await this.lockDependencies(tx, project.id);
    // O par sai dos ids CANÔNICOS (o do banco), não do parâmetro: um id em maiúsculas ordenaria diferente e não acharia a linha.
    const [from, to] = relatedPair(ticket.id, other.id);
    const row = await tx.ticketRelation.findFirst({ where: { fromTicketId: from, toTicketId: to, kind: "related" }, select: { id: true } });
    if (!row) throw new NotFoundException({ code: "related_not_found", message: "Relação não encontrada." });
    await tx.ticketRelation.delete({ where: { orgId_id: { orgId: project.orgId, id: row.id } } });
    await forgetRelationOrigins(tx, [row.id]);
    await touchProjectVersion(tx, project.id);
    await this.activity.record(tx, principal, {
      kind: "ticket.related_removed",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, relatedKey: `${project.key}-${other.number}`, relatedTicketId: other.id },
    });
    return this.detailFor(tx, project, id, principal);
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
   * Criar um ticket como a tela cria (`POST projects/:projectId/tickets`) e como o MCP cria (ADR 0043): projeto visível (404),
   * permissão de criar ou de registrar ideia (403), projeto arquivado (409) e então `create`. O caminho ÚNICO dessas conferências.
   */
  async createChecked(
    tx: TenantClient,
    principal: Principal,
    projectId: string,
    body: { title: string; description?: string | undefined; parentId?: string | null | undefined; status?: TicketStatus | undefined; assigneeIds?: string[] | undefined; idea?: boolean | undefined; dueDate?: string | null | undefined },
    extraPayload: Record<string, string> = {},
    /** Só MCP (ADR 0043): repetir com o mesmo `requestId`, do mesmo token, em até 10 minutos, devolve o ticket já criado. */
    request?: { id: string; digest: string },
  ): Promise<{ project: ProjectRow; created: TicketDetail; repeated: boolean }> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    if (body.idea) this.authorization.registerIdea(principal.actor, projectId);
    else this.authorization.createTicket(principal.actor, projectId);
    this.requireActive(project);
    const tokenId = principal.via?.kind === "mcp" ? principal.via.tokenId : undefined;
    if (request !== undefined && tokenId !== undefined) {
      // Serializa as chamadas com o mesmo pedido (a trava dura até o fim da transação); sem migration, a marca fica no evento de criação.
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`ticket-request:${projectId}:${tokenId}:${request.id}`}, 0))`;
      const again = await this.findCreatedByRequest(tx, project, principal.person.id, tokenId, request.id);
      if (again) {
        // O mesmo requestId com outros argumentos não é repetição: erro claro, nada devolvido nem gravado.
        if (again.digest !== request.digest) throw new ConflictException({ code: "request_id_reused", message: "O requestId já foi usado com outro pedido." });
        return { project, created: await this.detail(tx, project, again.id), repeated: true };
      }
      extraPayload = { ...extraPayload, requestId: request.id, requestDigest: request.digest };
    }
    const created = await this.create(
      tx,
      principal,
      project,
      {
        title: body.title,
        description: body.description ?? "",
        parentId: body.parentId ?? null,
        status: body.status ?? "todo",
        assigneeIds: body.assigneeIds ?? [],
        ...(body.idea ? { idea: true } : {}),
        ...(body.dueDate ? { dueDate: body.dueDate } : {}),
      },
      extraPayload,
    );
    return { project, created, repeated: false };
  }

  /**
   * O ticket que este token já criou com este `requestId` nos últimos 10 minutos, se ainda existir, com o resumo dos argumentos da
   * criação. Sem índice novo: anda pelos tickets do projeto do maior número para o menor (índice `org, projeto, número`; o número
   * cresce com o tempo), em lotes, e para no primeiro lote que já chega a tickets mais velhos que a janela, ou no teto de
   * `REQUEST_LOOKBACK_BATCHES` lotes. Só então lê os eventos de criação dos tickets da pessoa dentro da janela (índice de assunto).
   */
  private async findCreatedByRequest(tx: TenantClient, project: ProjectRow, personId: string, tokenId: string, requestId: string): Promise<{ id: string; digest: string | null } | null> {
    const cutoff = new Date(this.now() - REQUEST_REPEAT_WINDOW_MS);
    const mine: string[] = [];
    let below = 2_147_483_647; // o maior `integer` do banco
    for (let batch = 0; batch < REQUEST_LOOKBACK_BATCHES; batch += 1) {
      const rows = await tx.ticket.findMany({
        where: { projectId: project.id, number: { lt: below } },
        orderBy: { number: "desc" },
        take: REQUEST_LOOKBACK_BATCH_SIZE,
        select: { id: true, number: true, createdAt: true, createdByPersonId: true },
      });
      for (const row of rows) if (row.createdByPersonId === personId && row.createdAt >= cutoff) mine.push(row.id);
      const last = rows.at(-1);
      if (rows.length < REQUEST_LOOKBACK_BATCH_SIZE || !last || last.createdAt < cutoff) break;
      below = last.number;
    }
    if (mine.length === 0) return null;
    const events = await tx.activityEvent.findMany({
      where: { subjectType: "ticket", subjectId: { in: mine }, kind: "ticket.created" },
      select: { subjectId: true, payload: true },
    });
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | null;
      if (payload?.["requestId"] !== requestId || payload["tokenId"] !== tokenId) continue;
      return { id: event.subjectId, digest: typeof payload["requestDigest"] === "string" ? payload["requestDigest"] : null };
    }
    return null;
  }

  /**
   * Cria um ticket depois de as permissões e o projeto terem sido conferidos por quem chama: confere o pai e
   * os responsáveis, reserva o número, grava o ticket e o `ticket.created`. `extraPayload` acrescenta campos ao
   * evento (por exemplo, a origem "assistente").
   */
  /** A descrição vai ao provedor de IA e às leituras do MCP, e nome de pessoa não vai a nenhum dos dois (ADR 0058): texto com menção de pessoa é recusado. */
  private requireNoPersonMention(...texts: Array<string | undefined>): void {
    if (texts.some((text) => text !== undefined && mentionsPersonRaw(text))) {
      throw new UnprocessableEntityException({ code: "person_mention_not_allowed", message: "A descrição do ticket não aceita menção de pessoa." });
    }
  }

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
      /** Prazo (ADR 0064), já validado; ausente = sem prazo. */
      dueDate?: string;
    },
    extraPayload: Record<string, string> = {},
  ): Promise<TicketDetail> {
    this.requireNoPersonMention(input.description, input.title);
    if (input.parentId) {
      await this.lockStructure(tx, project.id); // ADR 0045: antes de conferir que o pai existe e de ler a ideia que o contém.
      await this.requireParent(tx, project.id, input.parentId);
    }
    // Ideia, ou ticket dentro de uma: fora do processo (ADR 0042). A situação fica em `todo`.
    const parentIdea = await this.ideaRootFor(tx, project, input.parentId);
    const outside = input.idea === true || parentIdea !== null;
    if (outside && input.status !== "todo") {
      throw new ConflictException({ code: "ticket_in_idea", message: "Dentro de uma ideia a situação fica em a fazer; aceite a ideia antes." });
    }
    const assigneeIds = [...new Set(input.assigneeIds)];
    for (const personId of assigneeIds) await this.requireAssignable(tx, project, personId);

    // Ordem das travas (ADR 0046): as linhas de tickets (pai, mencionados, citantes, ancestrais do pai) antes da linha do
    // projeto (reserva de números), que é a última trava das outras escritas. O número só entra no texto do evento (`peekNextNumber`).
    // Inclui a subida do pai, cuja situação sai dos filhos (ADR 0068): tudo pela ordem única, antes da linha do projeto.
    await this.lockLinkedTickets(tx, project, input.parentId, [input.description]);
    const number = await this.allocateNumbers(tx, project, 1);
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
        ...(input.dueDate ? { dueDate: dueDateValue(input.dueDate) } : {}),
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
    await this.deriveStatuses(tx, principal, project, [input.parentId], { causedBy: `${project.key}-${number}` });
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
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
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
   * A trava de aviso das dependências do projeto (`ticket-dependencies:`). Ordem das travas (ADR 0046): consultivas do projeto
   * (estrutura, depois dependências) → linhas de ticket → linha do projeto por último. Quem vai ligar dependências pega esta
   * logo depois da de estrutura, antes de qualquer escrita que reserve número (linha do projeto).
   */
  async lockDependencies(tx: TenantClient, projectId: string): Promise<void> {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`ticket-dependencies:${projectId}`}, 0))`;
  }

  /**
   * "`fromId` depende de `toId`" (ADR 0037), do tipo `need` (ADR 0068), dentro da transação de quem chama; as permissões e o projeto
   * já foram conferidos. Serializa por projeto (trava de aviso, só entre quem altera dependências), recusa a ligação a si mesmo e o
   * ciclo (os dois tipos juntos), e é idempotente (`exists`, sem novo evento). Entre dois tickets há no máximo uma dependência: o mesmo
   * par com outro tipo troca o tipo (`changed`, com o evento da troca). Os dois tickets são do projeto: confira antes.
   */
  async linkDependency(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    from: { id: string; number: number },
    to: { id: string; number: number },
    need: DependencyNeed = "start",
  ): Promise<"created" | "changed" | "exists" | "cycle" | "self"> {
    if (from.id === to.id) return "self";
    await this.lockDependencies(tx, project.id);
    const edges = await tx.ticketRelation.findMany({ where: { projectId: project.id, kind: "depends_on" }, select: { id: true, fromTicketId: true, toTicketId: true, need: true } });
    const keys = { key: `${project.key}-${from.number}`, dependsOnKey: `${project.key}-${to.number}`, dependsOnTicketId: to.id };
    const existing = edges.find((edge) => edge.fromTicketId === from.id && edge.toTicketId === to.id);
    if (existing) {
      if (existing.need === need) return "exists";
      await touchProjectVersion(tx, project.id); // ADR 0046: o lugar na fila do dependente muda com o tipo.
      await tx.ticketRelation.update({ where: { orgId_id: { orgId: project.orgId, id: existing.id } }, data: { need } });
      await this.activity.record(tx, principal, {
        kind: "ticket.dependency_need_changed",
        subjectType: "ticket",
        subjectId: from.id,
        payload: { ...keys, need: { from: existing.need, to: need } },
      });
      return "changed";
    }
    if (createsDependencyCycle(edges.map((edge) => [edge.fromTicketId, edge.toTicketId] as const), from.id, to.id)) return "cycle";
    await touchProjectVersion(tx, project.id); // ADR 0046 (rev. 3): o lugar na fila do dependente muda; decidido depois da trava e da leitura das ligações.
    await tx.ticketRelation.create({ data: { orgId: project.orgId, projectId: project.id, fromTicketId: from.id, toTicketId: to.id, kind: "depends_on", need } });
    await this.activity.record(tx, principal, {
      kind: "ticket.dependency_added",
      subjectType: "ticket",
      subjectId: from.id,
      payload: { ...keys, need },
    });
    return "created";
  }

  /**
   * "Este ticket depende de `otherId`" (ADR 0037): o caminho ÚNICO de regras, da rota HTTP e do MCP (ADR 0062). Visibilidade (404),
   * permissão de editar (403), projeto arquivado (409), o outro ticket do MESMO projeto (404, igual a inexistente), "não depende de
   * si mesmo" (409 `dependency_self`) e ciclo (409 `dependency_cycle`). Idempotente: ligação que já existe não gera novo evento. Com
   * outro `need`, troca o tipo da que existe (ADR 0068).
   */
  async addDependency(tx: TenantClient, principal: Principal, id: string, otherId: string, need: DependencyNeed = "start"): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    const other = await this.requireSameProjectTicket(tx, project.id, otherId);
    if (other.id === id) {
      throw new ConflictException({ code: "dependency_self", message: "Um ticket não pode depender de si mesmo." });
    }
    const outcome = await this.linkDependency(tx, principal, project, ticket, other, need);
    if (outcome === "cycle") {
      throw new ConflictException({ code: "dependency_cycle", message: "Isso fecharia um ciclo de dependências.", details: { key: `${project.key}-${other.number}` } });
    }
    return this.detailFor(tx, project, id, principal);
  }

  /**
   * Pôr uma pessoa como responsável (rota `PUT tickets/:id/assignees/:personId`, ADR 0062: a mesma regra serve ao MCP). Conferências, na ordem:
   * ticket visível (404), permissão de atribuir (403), projeto ativo (409), pessoa que pode ser responsável (`requireAssignable`).
   * Idempotente: quem já é responsável não gera evento nem toque na versão do projeto.
   */
  async assign(tx: TenantClient, principal: Principal, id: string, rawPersonId: string): Promise<TicketPage> {
    const personId = rawPersonId.toLowerCase(); // uma vez, na entrada: o id sai do banco em minúsculas e vai assim para o evento
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.lockAssignees(tx, project, id);
    await this.requireAssignable(tx, project, personId);
    await this.addAssignee(tx, principal, project, ticket, personId);
    return this.detailFor(tx, project, id, principal);
  }

  /** Tirar um responsável (rota `DELETE tickets/:id/assignees/:personId`): quem não é responsável é 404. */
  async unassign(tx: TenantClient, principal: Principal, id: string, rawPersonId: string): Promise<void> {
    const personId = rawPersonId.toLowerCase();
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.lockAssignees(tx, project, id);
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: id, personId } };
    if (!(await tx.ticketAssignee.findUnique({ where: key }))) {
      throw new NotFoundException("Pessoa não atribuída ao ticket.");
    }
    await this.removeAssignee(tx, principal, project, ticket, personId);
  }

  /**
   * Define a lista COMPLETA de responsáveis (ferramenta `set_ticket_assignees` do MCP, ADR 0062): as mesmas conferências de `assign`, a
   * mesma validação de cada pessoa NOVA e os mesmos eventos de `assign`/`unassign`, um por mudança. Lista igual à atual: nada muda.
   * Pessoa nova que não pode ser responsável: a mesma recusa de `assign` (404/409), antes de qualquer escrita.
   */
  async setAssignees(tx: TenantClient, principal: Principal, id: string, personIds: readonly string[]): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.lockAssignees(tx, project, id);
    const wanted = [...new Set(personIds.map((personId) => personId.toLowerCase()))];
    const current = (await tx.ticketAssignee.findMany({ where: { ticketId: id }, select: { personId: true } })).map((row) => row.personId);
    const toAdd = wanted.filter((personId) => !current.includes(personId));
    const toRemove = current.filter((personId) => !wanted.includes(personId));
    for (const personId of toAdd) await this.requireAssignable(tx, project, personId);
    for (const personId of toRemove) await this.removeAssignee(tx, principal, project, ticket, personId);
    for (const personId of toAdd) await this.addAssignee(tx, principal, project, ticket, personId);
  }

  /**
   * Serializa por ticket tudo o que muda os responsáveis (tela e MCP): trava a linha do ticket até o fim da transação. Quem chega
   * depois espera, lê o estado já gravado e decide em cima dele; assim "lista completa" vale (duas definições simultâneas terminam
   * com exatamente uma das listas), os eventos batem com o estado e a corrida da mesma pessoa não vira violação de unicidade.
   */
  private async lockAssignees(tx: TenantClient, project: ProjectRow, ticketId: string): Promise<void> {
    await tx.$queryRaw`select 1 from tickets where org_id = ${project.orgId} and id = ${ticketId}::uuid for update`;
  }

  private async addAssignee(tx: TenantClient, principal: Principal, project: ProjectRow, ticket: { id: string; number: number }, personId: string): Promise<void> {
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: ticket.id, personId } };
    if (await tx.ticketAssignee.findUnique({ where: key })) return;
    await touchProjectVersion(tx, project.id); // ADR 0046: as pessoas aparecem no resumo.
    await tx.ticketAssignee.create({ data: { orgId: project.orgId, ticketId: ticket.id, personId } });
    await this.activity.record(tx, principal, {
      kind: "ticket.assignee_added",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, personId },
    });
  }

  private async removeAssignee(tx: TenantClient, principal: Principal, project: ProjectRow, ticket: { id: string; number: number }, personId: string): Promise<void> {
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: ticket.id, personId } };
    await touchProjectVersion(tx, project.id); // ADR 0046
    await tx.ticketAssignee.delete({ where: key });
    await this.activity.record(tx, principal, {
      kind: "ticket.assignee_removed",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, personId },
    });
  }

  /**
   * As pessoas que a tela pode oferecer como responsável no projeto: ativas e que já enxergam o projeto, a mesma regra de
   * `requireAssignable` (`canView` sobre o papel da pessoa e os papéis que ela tem NO projeto), em nome e identificador (ADR 0062).
   */
  async assignablePeople(tx: TenantClient, projectId: string): Promise<{ id: string; displayName: string; email: string; clerkUserId: string }[]> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project) return [];
    const people = await tx.person.findMany({ where: { active: true }, select: { id: true, displayName: true, email: true, clerkUserId: true, clerkRole: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }] });
    const memberships = await tx.projectMembership.findMany({ where: { projectId }, select: { personId: true, role: true } });
    const roles = new Map(memberships.map((row) => [row.personId, row.role] as const));
    return people
      .filter((person) => {
        const role = roles.get(person.id);
        return this.authorization.canView(buildActor(person.clerkRole, [], role === undefined ? [] : [{ projectId, role }]), project);
      })
      .map(({ id, displayName, email, clerkUserId }) => ({ id, displayName, email, clerkUserId }));
  }

  /** Remove "este ticket depende de `otherId`": mesmas conferências de `addDependency`; ligação inexistente é 404. */
  async removeDependency(tx: TenantClient, principal: Principal, id: string, otherId: string): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    const other = await this.requireSameProjectTicket(tx, project.id, otherId);
    // A trava de dependências, antes de ler a linha: a mesma de `linkDependency` e da importação do Linear (um passo da sincronização
    // não desfaz esta remoção).
    await this.lockDependencies(tx, project.id);
    const row = await tx.ticketRelation.findFirst({ where: { fromTicketId: id, toTicketId: other.id, kind: "depends_on" }, select: { id: true } });
    const removed = row ? await tx.ticketRelation.deleteMany({ where: { id: row.id } }) : { count: 0 };
    if (removed.count === 0) throw new NotFoundException({ code: "dependency_not_found", message: "Dependência não encontrada." });
    // Trazida do Linear: removida aqui, não volta na próxima sincronização (ADR 0061, seção 3).
    await forgetRelationOrigins(tx, [(row as { id: string }).id]);
    await touchProjectVersion(tx, project.id); // ADR 0046 (rev. 3): marca porque a linha foi de fato apagada (`removed.count > 0`).
    await this.activity.record(tx, principal, {
      kind: "ticket.dependency_removed",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, dependsOnKey: `${project.key}-${other.number}`, dependsOnTicketId: other.id },
    });
    return this.detailFor(tx, project, id, principal);
  }

  /** Inexistente, de outra organização (RLS) ou de outro projeto: o mesmo 404 de "ticket não encontrado". */
  private async requireSameProjectTicket(tx: TenantClient, projectId: string, ticketId: string): Promise<{ id: string; number: number }> {
    const other = await tx.ticket.findFirst({ where: { id: ticketId, projectId }, select: { id: true, number: true } });
    if (!other) throw new NotFoundException("Ticket não encontrado.");
    return other;
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
    await touchProjectVersion(tx, project.id); // ADR 0046: só marca (create também marca).
    if (parentId) await this.requireParent(tx, project.id, parentId);
    // Trava os tickets até o fim da transação (ninguém os move nem os remove entre a conferência e a mudança), junto com o que a
    // criação do pai novo trava, pela ordem única: a criação logo abaixo encontra tudo já travado.
    await this.lockLinkedTickets(tx, project, parentId, [group.description], group.ticketIds);
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
    // O pai novo ganhou os tickets: a situação dele (e a do lugar, até a raiz) sai deles (ADR 0068).
    await this.deriveStatuses(tx, principal, project, [created.id], { causedBy: created.key, ...origin });
    return created.id;
  }
}
