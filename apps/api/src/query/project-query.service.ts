import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { agentWorkIsValid, descriptionExcerpt, effectivePriorities, emptyQueueReason, searchTickets, ticketProgress, utcToday, workQueue } from "@treepm/domain";
import type { EmptyQueueReason, TicketStatus, WorkTicket } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { readEffectivePriorities } from "../tickets/ticket-priority.read.js";
import { EXCERPT_SOURCE_LENGTH, readProgressOf, readSummaryRows } from "../tickets/ticket-reads.js";
import { MAX_TREE_DEPTH } from "../tickets/ticket-scope.js";
import { dueDateText } from "../tickets/due-date.js";
import { scopeOf } from "../tickets/ticket-scope.js";
import type { TicketScope } from "../tickets/ticket-scope.js";
import { ideaStageSchema, ticketStatusSchema } from "../tickets/tickets.schema.js";
import { ideaViews, toNodes } from "../tickets/tickets.service.js";
import { queryOverviewSchema, queryTicketPageSchema, queryTicketSchema, queryListSchema } from "./query.schema.js";
import type { QueryIdea, QueryOverview, QueryTicket, QueryTicketList, QueryTicketPage, QueryTicketSummary } from "./query.schema.js";

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 50;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
/** Teto de filhos, de cada lista de ligações de um ticket e dos tickets do topo no resumo. */
export const RELATED_MAX = 200;

export const WORK_QUEUE_DEFAULT_LIMIT = 20;
export const WORK_QUEUE_MAX_LIMIT = 50;

/** Um ticket da fila: o resumo de sempre mais o caminho (do topo até o pai, só chave e título). */
export type QueueTicket = QueryTicketSummary & { path: { key: string; title: string }[] };
export type QueryWorkQueue = { tickets: QueueTicket[]; total: number; truncated: boolean; emptyReason: EmptyQueueReason | null };

/** `assignedTo`: só os tickets atribuídos a esta pessoa (o servidor aplica o filtro; nenhum dado de pessoa sai na resposta). */
export type SearchOptions = { limit?: number; assignedTo?: string };
export type ListOptions = {
  /** Uma ou mais situações; vazio ou ausente = todas. */
  status?: readonly TicketStatus[];
  /** Número do ticket: só os descendentes dele, em todos os níveis (o próprio ticket não entra). */
  under?: number;
  limit?: number;
  /** Cursor: devolve só tickets de número maior que este (o `after` da página anterior). */
  after?: number;
  /** Só os tickets atribuídos a esta pessoa. */
  assignedTo?: string;
};

/** `dueDate`: `Date` (meia-noite UTC) quando lido pelo Prisma, `AAAA-MM-DD` quando lido em SQL cru (`to_char`); ver `dueDateText`. */
type Row = { id: string; number: number; title: string; description: string; status: string; parentId: string | null; agentWorkUntil?: Date | null; priority?: number; dueDate?: Date | string | null };
const SUMMARY_SELECT = { id: true, number: true, title: true, description: true, status: true, parentId: true, agentWorkUntil: true, priority: true, dueDate: true } as const;
/** Como cada ticket do projeto aparece em relação às ideias, por id (uma consulta para o projeto todo, nunca uma por ticket). */
type IdeaMap = ReadonlyMap<string, QueryIdea>;
/** O que cada resumo precisa além da própria linha: a situação de ideia e a prioridade que vale (ADR 0047), ambas por id. */
type Annex = { ideas: IdeaMap; effective: ReadonlyMap<string, number> };
const RELATED_ORDER = { number: "asc" } as const;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** Corta em `limit` e diz se havia mais (a consulta pede `limit + 1`). */
function cut<T>(rows: readonly T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Camada de consulta do projeto (ADR 0037): só leitura, sobre um projeto por vez, dentro da transação de quem chama
 * (`TenantClient`, com o isolamento por organização). Sem rota HTTP; os consumidores são a pergunta sobre o projeto e,
 * depois, o servidor MCP (ADR 0038). Nenhuma saída traz dado de pessoa. Nenhuma operação faz uma consulta por ticket.
 */
@Injectable()
export class ProjectQueryService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {}

  /**
   * `idea` só dos tickets de `ids`: a raiz de ideia mais próxima de cada um, ele incluído, por uma consulta recursiva que sobe de pai em
   * pai. Ticket comum não entra. Não lê o projeto inteiro: o custo é a profundidade dos tickets pedidos.
   */
  private async annexOf(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<Annex> {
    const [ideas, effective] = await Promise.all([this.ideasOf(tx, scope, ids), readEffectivePriorities(tx, scope, ids)]);
    return { ideas, effective };
  }

  private async ideasOf(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<IdeaMap> {
    const out = new Map<string, QueryIdea>();
    if (ids.length === 0) return out;
    const rows = await tx.$queryRaw<{ origin: string; root_id: string; root_number: number; idea_stage: string }[]>`
      with recursive up as (
        select t.id as origin, t.org_id, t.project_id, t.id, t.parent_id, t.number, t.idea_stage, 1 as depth
        from tickets t where t.org_id = ${scope.orgId} and t.project_id = ${scope.projectId}::uuid and t.id = any(${[...new Set(ids)]}::uuid[])
        union all
        select up.origin, p.org_id, p.project_id, p.id, p.parent_id, p.number, p.idea_stage, up.depth + 1
        from tickets p join up on p.org_id = up.org_id and p.project_id = up.project_id and p.id = up.parent_id
        where up.idea_stage is null and up.depth < ${MAX_TREE_DEPTH}::int
      )
      select distinct on (origin) origin, id as root_id, number as root_number, idea_stage from up where idea_stage is not null order by origin, depth`;
    for (const row of rows) {
      const stage = ideaStageSchema.parse(row.idea_stage);
      out.set(row.origin, row.origin === row.root_id ? { kind: "root", stage } : { kind: "inside", rootNumber: row.root_number });
    }
    return out;
  }

  /**
   * Busca da barra (ADR 0036) sobre os tickets do projeto. Padrão 8, máximo 50. 2 consultas além do projeto: os tickets (só o trecho da
   * descrição, que é o que a regra de busca lê) e a situação de ideia dos que voltam, não dos 20 000.
   */
  async search(tx: TenantClient, principal: Principal, projectId: string, text: string, options: SearchOptions = {}): Promise<QueryTicketList> {
    const project = await this.requireProject(tx, principal, projectId);
    const limit = clamp(options.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const rows = await tx.$queryRaw<Row[]>`
      select id, number, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, parent_id as "parentId", agent_work_until as "agentWorkUntil", priority, to_char(due_date, 'YYYY-MM-DD') as "dueDate"
      from tickets
      where project_id = ${projectId}::uuid
        and (${options.assignedTo ?? null}::uuid is null or id in (select ticket_id from ticket_assignees where person_id = ${options.assignedTo ?? null}::uuid))
      order by number asc`;
    const searchable = rows.map((row) => ({ key: `${project.key}-${row.number}`, number: row.number, title: row.title, descriptionExcerpt: descriptionExcerpt(row.description), row }));
    const found = cut(searchTickets(text, searchable, limit + 1), limit);
    const ideas = await this.annexOf(tx, scopeOf(project), found.rows.map((entry) => entry.row.id));
    return parseOutput(queryListSchema, { tickets: found.rows.map((entry) => this.summary(project.key, entry.row, ideas)), truncated: found.truncated });
  }

  /**
   * Um ticket inteiro: descrição, pai, filhos, caminho do topo até o pai e as ligações nos dois sentidos, por tipo.
   * 12 consultas fixas (projeto, ticket, filhos, seis de ligações, ancestrais, ideias, prioridade), nenhuma por ticket. `related` (ADR 0061) é simétrica, uma
   * linha por par com o menor id em `from`: os dois lados são lidos e juntados numa lista só, sem direção.
   */
  async ticket(tx: TenantClient, principal: Principal, projectId: string, number: number): Promise<QueryTicket> {
    const project = await this.requireProject(tx, principal, projectId);
    const row = await tx.ticket.findFirst({ where: { projectId, number }, select: SUMMARY_SELECT });
    if (!row) throw new NotFoundException("Ticket não encontrado.");
    const children = await tx.ticket.findMany({
      where: { projectId, parentId: row.id },
      select: SUMMARY_SELECT,
      orderBy: RELATED_ORDER,
      take: RELATED_MAX + 1,
    });
    const outgoing = async (kind: "mentions" | "depends_on" | "related"): Promise<Row[]> =>
      (await tx.ticketRelation.findMany({
        where: { projectId, fromTicketId: row.id, kind },
        select: { to: { select: SUMMARY_SELECT } },
        orderBy: { to: RELATED_ORDER },
        take: RELATED_MAX + 1,
      })).map((relation) => relation.to);
    const incoming = async (kind: "mentions" | "depends_on" | "related"): Promise<Row[]> =>
      (await tx.ticketRelation.findMany({
        where: { projectId, toTicketId: row.id, kind },
        select: { from: { select: SUMMARY_SELECT } },
        orderBy: { from: RELATED_ORDER },
        take: RELATED_MAX + 1,
      })).map((relation) => relation.from);
    // Cada lado já vem ordenado e com teto + 1: os primeiros da união estão entre eles, e o corte da união diz se havia mais.
    const related = [...(await outgoing("related")), ...(await incoming("related"))].sort((a, b) => a.number - b.number);
    const parts = {
      children: cut(children, RELATED_MAX),
      related: cut(related, RELATED_MAX),
      mentionsOut: cut(await outgoing("mentions"), RELATED_MAX),
      mentionsIn: cut(await incoming("mentions"), RELATED_MAX),
      dependsOut: cut(await outgoing("depends_on"), RELATED_MAX),
      dependsIn: cut(await incoming("depends_on"), RELATED_MAX),
    };
    const pathRows = await this.ancestors(tx, scopeOf(project), row.parentId);
    // A situação de ideia só dos tickets que a resposta mostra (o próprio, o caminho, os filhos e as ligações), numa consulta.
    const shown = [row, ...pathRows, ...Object.values(parts).flatMap((part) => part.rows)];
    const ideas = await this.annexOf(tx, scopeOf(project), shown.map((entry) => entry.id));
    const summary = (entry: Row): QueryTicketSummary => this.summary(project.key, entry, ideas);
    const list = (part: { rows: Row[]; truncated: boolean }): QueryTicketList => ({ tickets: part.rows.map(summary), truncated: part.truncated });
    const relations = {
      mentions: { outgoing: list(parts.mentionsOut), incoming: list(parts.mentionsIn) },
      dependsOn: { outgoing: list(parts.dependsOut), incoming: list(parts.dependsIn) },
      related: list(parts.related),
    };
    const path = pathRows.map(summary);

    return parseOutput(queryTicketSchema, {
      ...summary(row),
      description: row.description,
      parent: path.at(-1) ?? null,
      path,
      children: list(parts.children),
      relations,
    });
  }

  /**
   * Resumos em ordem de número, com filtro de situação e de ramo. Padrão 50, máximo 200. O banco filtra, ordena e corta (`limit`): só a
   * página sai dele, com o trecho da descrição, e a situação de ideia vem só dos tickets da página. Um ramo (`under`) é uma consulta
   * recursiva descendo de pai em pai, não a árvore do projeto lida para filtrar em memória.
   */
  async list(tx: TenantClient, principal: Principal, projectId: string, options: ListOptions = {}): Promise<QueryTicketPage> {
    const project = await this.requireProject(tx, principal, projectId);
    const limit = clamp(options.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const statuses = (options.status ?? []).map((status) => ticketStatusSchema.parse(status));
    let under: string | null = null;
    if (options.under !== undefined) {
      const start = await tx.ticket.findFirst({ where: { projectId, number: options.under }, select: { id: true } });
      if (!start) throw new NotFoundException("Ticket não encontrado.");
      under = start.id;
    }
    const rows = await tx.$queryRaw<Row[]>`
      select id, number, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, parent_id as "parentId", agent_work_until as "agentWorkUntil", priority, to_char(due_date, 'YYYY-MM-DD') as "dueDate"
      from tickets
      where project_id = ${projectId}::uuid
        and (${statuses.length > 0 ? statuses : null}::text[] is null or status = any(${statuses.length > 0 ? statuses : null}::text[]))
        and (${options.after ?? null}::int is null or number > ${options.after ?? null}::int)
        and (${options.assignedTo ?? null}::uuid is null or id in (select ticket_id from ticket_assignees where person_id = ${options.assignedTo ?? null}::uuid))
        and (${under}::uuid is null or id in (
          with recursive down as (
            select org_id, project_id, id, 1 as depth from tickets where org_id = ${project.orgId} and project_id = ${projectId}::uuid and parent_id = ${under}::uuid
            union all
            select t.org_id, t.project_id, t.id, down.depth + 1
            from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
            where down.depth < ${MAX_TREE_DEPTH}::int
          )
          select id from down
        ))
      order by number asc
      limit ${limit + 1}::int`;
    const page = cut(rows, limit);
    const ideas = await this.annexOf(tx, scopeOf(project), page.rows.map((row) => row.id));
    return parseOutput(queryTicketPageSchema, {
      tickets: page.rows.map((row) => this.summary(project.key, row, ideas)),
      truncated: page.truncated,
      after: page.truncated ? (page.rows.at(-1)?.number ?? null) : null,
    });
  }

  /**
   * Total por situação e os tickets do topo com situação e progresso. O total e as contagens saem do banco por `group by` (uma linha por
   * situação e por estágio), o progresso dos tickets do topo vem de `readProgressOf` (só o ramo de cada um), e o projeto não é lido.
   */
  async overview(tx: TenantClient, principal: Principal, projectId: string): Promise<QueryOverview> {
    const project = await this.requireProject(tx, principal, projectId);
    // Descendo da raiz, cada ticket sabe se está dentro de uma ideia (ele mesmo ser raiz já conta): ideia não é trabalho aceito.
    const groups = await tx.$queryRaw<{ status: string; idea_stage: string | null; inside: boolean; n: bigint }[]>`
      with recursive down as (
        select org_id, project_id, id, status, idea_stage, (idea_stage is not null) as inside, 1 as depth
        from tickets where org_id = ${project.orgId} and project_id = ${projectId}::uuid and parent_id is null
        union all
        select t.org_id, t.project_id, t.id, t.status, t.idea_stage, (down.inside or t.idea_stage is not null), down.depth + 1
        from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
        where down.depth < ${MAX_TREE_DEPTH}::int
      )
      select status, idea_stage, inside, count(*) as n from down group by status, idea_stage, inside`;
    const top = await tx.$queryRaw<Row[]>`
      select id, number, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, parent_id as "parentId", agent_work_until as "agentWorkUntil", priority, to_char(due_date, 'YYYY-MM-DD') as "dueDate"
      from tickets where project_id = ${projectId}::uuid and parent_id is null order by number asc limit ${RELATED_MAX + 1}::int`;
    const byStatus: Record<TicketStatus, number> = { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 };
    const ideaCounts = { new: 0, refining: 0, ready: 0, discarded: 0 };
    let work = 0;
    for (const group of groups) {
      const count = Number(group.n);
      if (group.idea_stage !== null) ideaCounts[ideaStageSchema.parse(group.idea_stage)] += count;
      if (group.inside) continue; // ideia não é trabalho aceito: fica fora do total e da contagem por situação
      work += count;
      byStatus[ticketStatusSchema.parse(group.status)] += count;
    }
    const part = cut(top, RELATED_MAX);
    const [progress, ideas] = await Promise.all([readProgressOf(tx, scopeOf(project), part.rows.map((row) => row.id)), this.annexOf(tx, scopeOf(project), part.rows.map((row) => row.id))]);
    return parseOutput(queryOverviewSchema, {
      projectKey: project.key,
      total: work,
      byStatus,
      ideas: ideaCounts,
      top: {
        tickets: part.rows.map((row) => ({ ...this.summary(project.key, row, ideas), progress: progress.get(row.id) ?? null })),
        truncated: part.truncated,
      },
    });
  }

  /**
   * A fila "próximos para trabalhar" (ADR 0047) da pessoa do token, no projeto e, se pedido, no ramo de `under` (número). Toda a regra
   * é do domínio (`workQueue`, `emptyQueueReason`): aqui só se monta o que elas leem. Custo: as 2 consultas de `readSummaryRows`
   * (os tickets do projeto com 601 caracteres de descrição, e as pessoas), a mesma leitura que a lista do mapa faz; nenhuma consulta
   * por ticket e nenhuma outra. O que sai é cortado em `limit` depois de ordenado.
   */
  async workQueue(tx: TenantClient, principal: Principal, projectId: string, options: { under?: number; limit?: number } = {}): Promise<QueryWorkQueue> {
    const project = await this.requireProject(tx, principal, projectId);
    const rows = await readSummaryRows(tx, projectId);
    let scopeId: string | null = null;
    if (options.under !== undefined) {
      const found = rows.find((row) => row.number === options.under);
      if (!found) throw new NotFoundException("Ticket não encontrado.");
      scopeId = found.id;
    }
    const now = this.clock.now();
    const progress = ticketProgress(toNodes(rows));
    const ideas = ideaViews(project, rows);
    const tickets: WorkTicket[] = rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      parentId: row.parentId,
      number: row.number,
      status: ticketStatusSchema.parse(row.status),
      priority: row.priority ?? 0,
      assigneeIds: row.assignees.map((assignee) => assignee.personId),
      blocked: row.blocked ?? false,
      progress: progress.get(row.id) ?? null,
      idea: ideas.get(row.id) ?? null,
      agentWork: row.agentWorkUntil && agentWorkIsValid(row.agentWorkUntil, now) ? { until: row.agentWorkUntil.toISOString() } : null,
    }));
    const me = principal.person.id;
    const scope = { ticketId: scopeId };
    const ids = workQueue(tickets, me, scope);
    const limit = clamp(options.limit, WORK_QUEUE_DEFAULT_LIMIT, WORK_QUEUE_MAX_LIMIT);
    const effective = effectivePriorities(tickets);
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const queue = ids.slice(0, limit).map((id): QueueTicket => {
      const row = byId.get(id) as (typeof rows)[number];
      const path: { key: string; title: string }[] = [];
      for (let up = row.parentId === null ? undefined : byId.get(row.parentId); up && path.length < MAX_TREE_DEPTH; up = up.parentId === null ? undefined : byId.get(up.parentId)) {
        path.unshift({ key: `${project.key}-${up.number}`, title: up.title });
      }
      const idea = ideas.get(id) ?? null;
      return {
        id,
        key: `${project.key}-${row.number}`,
        number: row.number,
        title: row.title,
        descriptionExcerpt: descriptionExcerpt(row.description),
        status: ticketStatusSchema.parse(row.status),
        parentId: row.parentId,
        idea: idea === null ? null : idea.root ? { kind: "root", stage: idea.stage } : { kind: "inside", rootNumber: byId.get(idea.rootId)?.number ?? 0 },
        agentWork: null,
        priority: row.priority ?? 0,
        effectivePriority: effective.get(id)?.value ?? 0,
        dueDate: row.dueDate ?? null,
        path,
      };
    });
    return { tickets: queue, total: ids.length, truncated: ids.length > queue.length, emptyReason: ids.length === 0 ? emptyQueueReason(tickets, me, scope) : null };
  }

  /** O "hoje" do MCP (ADR 0064): o dia em UTC, do relógio injetável. A tela usa o dia do navegador. */
  utcToday(): string {
    return utcToday(this.clock.now());
  }

  /** Projeto inexistente, de outra organização (RLS) ou que a pessoa não enxerga: o mesmo 404 das rotas. Arquivado pode ser lido. */
  async requireProject(tx: TenantClient, principal: Principal, projectId: string): Promise<{ id: string; orgId: string; key: string }> {
    const project = await tx.project.findFirst({ where: { id: projectId }, select: { id: true, orgId: true, key: true, visibility: true } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  /** Do topo até o pai: uma consulta recursiva, qualquer que seja a profundidade. */
  private async ancestors(tx: TenantClient, scope: TicketScope, parentId: string | null): Promise<Row[]> {
    if (parentId === null) return [];
    return tx.$queryRaw<Row[]>`
      with recursive up as (
        select org_id, project_id, id, number, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, parent_id, priority, due_date, 1 as depth
        from tickets where org_id = ${scope.orgId} and project_id = ${scope.projectId}::uuid and id = ${parentId}::uuid
        union all
        select t.org_id, t.project_id, t.id, t.number, t.title, left(t.description, ${EXCERPT_SOURCE_LENGTH}::int), t.status, t.parent_id, t.priority, t.due_date, up.depth + 1
        from tickets t join up on t.org_id = up.org_id and t.project_id = up.project_id and t.id = up.parent_id
        where up.depth < ${MAX_TREE_DEPTH}::int
      )
      select id, number, title, description, status, parent_id as "parentId", priority, to_char(due_date, 'YYYY-MM-DD') as "dueDate" from up order by depth desc`;
  }

  private summary(projectKey: string, row: Row, annex: Annex): QueryTicketSummary {
    const now = this.clock.now();
    const marker = row.agentWorkUntil && agentWorkIsValid(row.agentWorkUntil, now) ? { until: row.agentWorkUntil.toISOString() } : null;
    return {
      idea: annex.ideas.get(row.id) ?? null,
      agentWork: marker,
      priority: row.priority ?? 0,
      effectivePriority: annex.effective.get(row.id) ?? row.priority ?? 0,
      dueDate: typeof row.dueDate === "string" ? row.dueDate : dueDateText(row.dueDate),
      id: row.id,
      key: `${projectKey}-${row.number}`,
      number: row.number,
      title: row.title,
      descriptionExcerpt: descriptionExcerpt(row.description),
      status: ticketStatusSchema.parse(row.status),
      parentId: row.parentId,
    };
  }
}
