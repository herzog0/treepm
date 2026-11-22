import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { agentWorkIsValid, descriptionExcerpt, ideaRootsOf, searchTickets, ticketProgress } from "@treepm/domain";
import type { TicketStatus } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { ideaStageSchema, ticketStatusSchema } from "../tickets/tickets.schema.js";
import { queryOverviewSchema, queryTicketPageSchema, queryTicketSchema, queryListSchema } from "./query.schema.js";
import type { QueryIdea, QueryOverview, QueryTicket, QueryTicketList, QueryTicketPage, QueryTicketSummary } from "./query.schema.js";

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 50;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
/** Teto de filhos, de cada lista de ligações de um ticket e dos tickets do topo no resumo. */
export const RELATED_MAX = 200;

export type SearchOptions = { limit?: number };
export type ListOptions = {
  /** Uma ou mais situações; vazio ou ausente = todas. */
  status?: readonly TicketStatus[];
  /** Número do ticket: só os descendentes dele, em todos os níveis (o próprio ticket não entra). */
  under?: number;
  limit?: number;
  /** Cursor: devolve só tickets de número maior que este (o `after` da página anterior). */
  after?: number;
};

type Row = { id: string; number: number; title: string; description: string; status: string; parentId: string | null; agentWorkUntil?: Date | null };
const SUMMARY_SELECT = { id: true, number: true, title: true, description: true, status: true, parentId: true, agentWorkUntil: true } as const;
/** Como cada ticket do projeto aparece em relação às ideias, por id (uma consulta para o projeto todo, nunca uma por ticket). */
type IdeaMap = ReadonlyMap<string, QueryIdea>;
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

  /** `idea` de todos os tickets do projeto: a raiz (com o estágio) e o que está dentro (com o número da raiz). Ticket comum não entra. */
  private async ideas(tx: TenantClient, projectId: string): Promise<IdeaMap> {
    const rows = await tx.ticket.findMany({ where: { projectId }, select: { id: true, number: true, parentId: true, status: true, ideaStage: true } });
    return this.ideaMap(rows);
  }

  private ideaMap(rows: readonly { id: string; number: number; parentId: string | null; status: string; ideaStage: string | null }[]): IdeaMap {
    const nodes = rows.map((row) => ({ id: row.id, parentId: row.parentId, status: ticketStatusSchema.parse(row.status), ideaStage: ideaStageSchema.nullable().parse(row.ideaStage) }));
    const numberOf = new Map(rows.map((row) => [row.id, row.number] as const));
    const stageOf = new Map(nodes.map((node) => [node.id, node.ideaStage] as const));
    const out = new Map<string, QueryIdea>();
    for (const [id, rootId] of ideaRootsOf(nodes)) {
      const stage = stageOf.get(id);
      out.set(id, id === rootId && stage ? { kind: "root", stage } : { kind: "inside", rootNumber: numberOf.get(rootId) ?? 0 });
    }
    return out;
  }

  /** Busca da barra (ADR 0036) sobre os tickets do projeto. Padrão 8, máximo 50. 2 consultas. */
  async search(tx: TenantClient, principal: Principal, projectId: string, text: string, options: SearchOptions = {}): Promise<QueryTicketList> {
    const project = await this.requireProject(tx, principal, projectId);
    const limit = clamp(options.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const rows = await tx.ticket.findMany({ where: { projectId }, select: SUMMARY_SELECT, orderBy: { number: "asc" } });
    const ideas = await this.ideas(tx, projectId);
    const found = cut(searchTickets(text, rows.map((row) => this.summary(project.key, row, ideas)), limit + 1), limit);
    return parseOutput(queryListSchema, { tickets: found.rows, truncated: found.truncated });
  }

  /**
   * Um ticket inteiro: descrição, pai, filhos, caminho do topo até o pai e as ligações nos dois sentidos, por tipo.
   * 8 consultas (projeto, ticket, filhos, quatro de ligações, ancestrais), nenhuma por ticket.
   */
  async ticket(tx: TenantClient, principal: Principal, projectId: string, number: number): Promise<QueryTicket> {
    const project = await this.requireProject(tx, principal, projectId);
    const row = await tx.ticket.findFirst({ where: { projectId, number }, select: SUMMARY_SELECT });
    if (!row) throw new NotFoundException("Ticket não encontrado.");
    const ideas = await this.ideas(tx, projectId);
    const summary = (entry: Row): QueryTicketSummary => this.summary(project.key, entry, ideas);
    const list = (rows: readonly Row[]): QueryTicketList => {
      const part = cut(rows, RELATED_MAX);
      return { tickets: part.rows.map(summary), truncated: part.truncated };
    };

    const children = await tx.ticket.findMany({
      where: { projectId, parentId: row.id },
      select: SUMMARY_SELECT,
      orderBy: RELATED_ORDER,
      take: RELATED_MAX + 1,
    });
    const outgoing = async (kind: "mentions" | "depends_on"): Promise<Row[]> =>
      (await tx.ticketRelation.findMany({
        where: { projectId, fromTicketId: row.id, kind },
        select: { to: { select: SUMMARY_SELECT } },
        orderBy: { to: RELATED_ORDER },
        take: RELATED_MAX + 1,
      })).map((relation) => relation.to);
    const incoming = async (kind: "mentions" | "depends_on"): Promise<Row[]> =>
      (await tx.ticketRelation.findMany({
        where: { projectId, toTicketId: row.id, kind },
        select: { from: { select: SUMMARY_SELECT } },
        orderBy: { from: RELATED_ORDER },
        take: RELATED_MAX + 1,
      })).map((relation) => relation.from);
    const relations = {
      mentions: { outgoing: list(await outgoing("mentions")), incoming: list(await incoming("mentions")) },
      dependsOn: { outgoing: list(await outgoing("depends_on")), incoming: list(await incoming("depends_on")) },
    };
    const path = (await this.ancestors(tx, row.parentId)).map(summary);

    return parseOutput(queryTicketSchema, {
      ...summary(row),
      description: row.description,
      parent: path.at(-1) ?? null,
      path,
      children: list(children),
      relations,
    });
  }

  /** Resumos em ordem de número, com filtro de situação e de ramo. Padrão 50, máximo 200. 2 consultas (3 com `under`). */
  async list(tx: TenantClient, principal: Principal, projectId: string, options: ListOptions = {}): Promise<QueryTicketPage> {
    const project = await this.requireProject(tx, principal, projectId);
    const limit = clamp(options.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const statuses = (options.status ?? []).map((status) => ticketStatusSchema.parse(status));
    let ids: string[] | undefined;
    if (options.under !== undefined) {
      const tree = await tx.ticket.findMany({ where: { projectId }, select: { id: true, number: true, parentId: true } });
      const start = tree.find((node) => node.number === options.under);
      if (!start) throw new NotFoundException("Ticket não encontrado.");
      const kids = new Map<string, string[]>();
      for (const node of tree) {
        if (node.parentId === null) continue;
        const siblings = kids.get(node.parentId);
        if (siblings) siblings.push(node.id);
        else kids.set(node.parentId, [node.id]);
      }
      ids = [];
      for (const queue = [start.id]; queue.length > 0; ) {
        for (const kid of kids.get(queue.shift() ?? "") ?? []) {
          ids.push(kid);
          queue.push(kid);
        }
      }
    }
    const rows = await tx.ticket.findMany({
      where: {
        projectId,
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...(options.after !== undefined ? { number: { gt: options.after } } : {}),
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: SUMMARY_SELECT,
      orderBy: { number: "asc" },
      take: limit + 1,
    });
    const page = cut(rows, limit);
    const ideas = await this.ideas(tx, projectId);
    return parseOutput(queryTicketPageSchema, {
      tickets: page.rows.map((row) => this.summary(project.key, row, ideas)),
      truncated: page.truncated,
      after: page.truncated ? (page.rows.at(-1)?.number ?? null) : null,
    });
  }

  /** Total por situação e os tickets do topo com situação e progresso (`ticketProgress`). 3 consultas. */
  async overview(tx: TenantClient, principal: Principal, projectId: string): Promise<QueryOverview> {
    const project = await this.requireProject(tx, principal, projectId);
    const nodes = (await tx.ticket.findMany({ where: { projectId }, select: { id: true, number: true, parentId: true, status: true, ideaStage: true } })).map((row) => ({
      id: row.id,
      number: row.number,
      parentId: row.parentId,
      status: ticketStatusSchema.parse(row.status),
      ideaStage: ideaStageSchema.nullable().parse(row.ideaStage),
    }));
    const ideas = this.ideaMap(nodes);
    const top = await tx.ticket.findMany({ where: { projectId, parentId: null }, select: SUMMARY_SELECT, orderBy: RELATED_ORDER, take: RELATED_MAX + 1 });
    const byStatus: Record<TicketStatus, number> = { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 };
    const ideaCounts = { new: 0, refining: 0, ready: 0, discarded: 0 };
    let work = 0;
    for (const node of nodes) {
      const idea = ideas.get(node.id);
      if (idea?.kind === "root" && node.ideaStage) ideaCounts[node.ideaStage] += 1;
      if (idea) continue; // ideia não é trabalho aceito: fica fora do total e da contagem por situação
      work += 1;
      byStatus[node.status] += 1;
    }
    const progress = ticketProgress(nodes);
    const part = cut(top, RELATED_MAX);
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

  /** Projeto inexistente, de outra organização (RLS) ou que a pessoa não enxerga: o mesmo 404 das rotas. Arquivado pode ser lido. */
  async requireProject(tx: TenantClient, principal: Principal, projectId: string): Promise<{ id: string; key: string }> {
    const project = await tx.project.findFirst({ where: { id: projectId }, select: { id: true, key: true, visibility: true } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  /** Do topo até o pai: uma consulta recursiva, qualquer que seja a profundidade. */
  private async ancestors(tx: TenantClient, parentId: string | null): Promise<Row[]> {
    if (parentId === null) return [];
    return tx.$queryRaw<Row[]>`
      with recursive up as (
        select id, number, title, description, status, parent_id, 1 as depth from tickets where id = ${parentId}::uuid
        union all
        select t.id, t.number, t.title, t.description, t.status, t.parent_id, up.depth + 1
        from tickets t join up on t.id = up.parent_id where up.depth < 1000
      )
      select id, number, title, description, status, parent_id as "parentId" from up order by depth desc`;
  }

  private summary(projectKey: string, row: Row, ideas: IdeaMap): QueryTicketSummary {
    const now = this.clock.now();
    const marker = row.agentWorkUntil && agentWorkIsValid(row.agentWorkUntil, now) ? { until: row.agentWorkUntil.toISOString() } : null;
    return {
      idea: ideas.get(row.id) ?? null,
      agentWork: marker,
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
