import { effectivePriorities } from "./priority.js";
import { isTurn } from "./tickets.js";
import type { TicketProgress, TicketStatus } from "./tickets.js";

/**
 * A fila "próximos para trabalhar" (ADR 0047) e a base dos modelos do modo play (ADR 0048). Funções puras, sobre o resumo de ticket
 * que o mapa já tem: nenhuma consulta e nenhuma ida ao servidor.
 */

/**
 * O que a fila precisa saber de um ticket; é um subconjunto do resumo que a API devolve (`TicketSummary`), então a web passa os
 * resumos como estão. `blocked` vem calculado do servidor: o ticket depende de algum ticket ainda aberto (ADR 0037).
 */
export interface WorkTicket {
  readonly id: string;
  /** O projeto do ticket; só o alcance "projeto" usa. */
  readonly projectId?: string;
  readonly parentId: string | null;
  readonly number: number;
  readonly status: TicketStatus;
  /** A prioridade PRÓPRIA (a que vale é calculada aqui, com a herança). */
  readonly priority: number;
  readonly assigneeIds: readonly string[];
  /** Depende de algum ticket ainda aberto (nem concluído nem cancelado). */
  readonly blocked: boolean;
  readonly progress: TicketProgress | null;
  /** Não nulo: o ticket é raiz de ideia ou está dentro de uma (ADR 0042). */
  readonly idea: unknown;
  /** Marcador de trabalho pela IA (ADR 0043); `until` em ISO. Nulo quando não há marcador. */
  readonly agentWork: { readonly until: string } | null;
}

/** Até onde a fila olha: o ramo de um ticket (ele e os descendentes), um projeto, ou nada (tudo o que a pessoa enxerga). */
export interface WorkScope {
  readonly ticketId?: string | null;
  readonly projectId?: string | null;
}

/** Por que a fila está vazia, quando há um motivo único (ADR 0047); "none" é "nenhum motivo único". */
export type EmptyQueueReason = "all_blocked" | "all_others" | "none";

/** Os tickets dentro do alcance (o ramo de um ticket inclui o próprio; o projeto filtra por `projectId`). */
export function ticketsInScope<T extends Pick<WorkTicket, "id" | "parentId" | "projectId">>(tickets: readonly T[], scope: WorkScope): T[] {
  let inScope = tickets;
  if (scope.projectId) inScope = inScope.filter((ticket) => ticket.projectId === scope.projectId);
  if (scope.ticketId) {
    const children = new Map<string, string[]>();
    for (const ticket of tickets) {
      if (ticket.parentId === null) continue;
      const list = children.get(ticket.parentId);
      if (list) list.push(ticket.id);
      else children.set(ticket.parentId, [ticket.id]);
    }
    const branch = new Set<string>([scope.ticketId]);
    const stack = [scope.ticketId];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      for (const kid of children.get(id) ?? []) {
        if (!branch.has(kid)) {
          branch.add(kid);
          stack.push(kid);
        }
      }
    }
    inScope = inScope.filter((ticket) => branch.has(ticket.id));
  }
  return [...inScope];
}

/** A prioridade que vale de cada ticket, herdada pela árvore COMPLETA (o ancestral de fora do alcance também conta). */
function effectiveOf(tickets: readonly WorkTicket[]): Map<string, number> {
  const all = effectivePriorities(tickets);
  return new Map(tickets.map((ticket) => [ticket.id, all.get(ticket.id)?.value ?? 0] as const));
}

/** Pode ser trabalhado agora, sem olhar dono, dependência nem marcador: a fazer, ticket da vez, fora de ideia. */
function isReady(ticket: WorkTicket): boolean {
  return ticket.status === "todo" && isTurn(ticket.status, ticket.progress, ticket.idea !== null);
}

const isOfOthersOnly = (ticket: WorkTicket, me: string): boolean => ticket.assigneeIds.length > 0 && !ticket.assigneeIds.includes(me);

/**
 * Os ids da fila de `me` no `scope`, na ordem de trabalho (ADR 0047). Entra o ticket que: está a fazer; é o ticket da vez (sem
 * filho aberto); não é ideia nem está dentro de uma; não depende de ticket aberto; não tem o marcador de trabalho pela IA; e é da
 * pessoa ou de ninguém. Ordem: prioridade que vale (maior primeiro), os da pessoa antes dos sem responsável, o número.
 */
export function workQueue(tickets: readonly WorkTicket[], me: string, scope: WorkScope = {}): string[] {
  const eff = effectiveOf(tickets);
  const queue = ticketsInScope(tickets, scope).filter((ticket) => isReady(ticket) && !ticket.blocked && ticket.agentWork === null && !isOfOthersOnly(ticket, me));
  const priorityOf = (ticket: WorkTicket): number => eff.get(ticket.id) ?? 0;
  queue.sort(
    (a, b) =>
      priorityOf(b) - priorityOf(a) ||
      Number(b.assigneeIds.includes(me)) - Number(a.assigneeIds.includes(me)) ||
      a.number - b.number ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return queue.map((ticket) => ticket.id);
}

/**
 * Quando a fila está vazia, o motivo único se houver (ADR 0047): `null` com a fila cheia; `"all_blocked"` quando tudo o que estaria
 * pronto depende de outro ticket; `"all_others"` quando é tudo de outra pessoa; `"none"` quando não há nada a fazer no alcance ou
 * os motivos se misturam.
 */
export function emptyQueueReason(tickets: readonly WorkTicket[], me: string, scope: WorkScope = {}): EmptyQueueReason | null {
  if (workQueue(tickets, me, scope).length > 0) return null;
  const candidates = ticketsInScope(tickets, scope).filter(isReady);
  if (candidates.length === 0) return "none";
  if (candidates.every((ticket) => ticket.blocked)) return "all_blocked";
  if (candidates.every((ticket) => isOfOthersOnly(ticket, me))) return "all_others";
  return "none";
}
