import type { Actor, ProjectAccess } from "./index.js";
import { canViewProject } from "./index.js";

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Minimal ticket shape needed to compute progress. */
export interface TicketNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: TicketStatus;
}

/** Finalizado (ADR 0034): concluído ou cancelado. Os outros três valores são "aberto". */
export function isFinished(status: TicketStatus): boolean {
  return status === "done" || status === "cancelled";
}

/** Progress over every descendant: `excluded` counts cancelled, `total` the rest, `done` the finished ones. */
export interface TicketProgress {
  readonly done: number;
  readonly total: number;
  readonly excluded: number;
}

/** Tickets follow the visibility of their project. */
export function canViewTickets(actor: Actor, project: ProjectAccess): boolean {
  return canViewProject(actor, project);
}

function canWriteTickets(actor: Actor, projectId: string): boolean {
  if (actor.clerkRole === "admin") return true;
  const role = actor.projectRoles.get(projectId);
  return role === "manager" || role === "contributor";
}

/** Allows organization admins, managers and contributors to create tickets. */
export function canCreateTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to edit title, description, status and parent. */
export function canEditTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to assign or unassign people. */
export function canAssignTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to import a ticket list. */
export function canImportTickets(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins and project managers to remove tickets. */
export function canRemoveTicket(actor: Actor, projectId: string): boolean {
  return actor.clerkRole === "admin" || actor.projectRoles.get(projectId) === "manager";
}

function childrenByParent(tickets: readonly TicketNode[]): Map<string, TicketNode[]> {
  const children = new Map<string, TicketNode[]>();
  for (const ticket of tickets) {
    if (ticket.parentId === null) continue;
    const siblings = children.get(ticket.parentId);
    if (siblings) siblings.push(ticket);
    else children.set(ticket.parentId, [ticket]);
  }
  return children;
}

/**
 * Progress for every ticket that has children, keyed by ID (ADR 0034). A ticket without children has no entry.
 * Counts every descendant, at any level; a descendant that is itself a parent counts as one item, by its own status.
 */
export function ticketProgress(tickets: readonly TicketNode[]): Map<string, TicketProgress> {
  const children = childrenByParent(tickets);
  const result = new Map<string, TicketProgress>();
  const visit = (ticket: TicketNode): { done: number; total: number; excluded: number } => {
    let done = 0;
    let total = 0;
    let excluded = 0;
    for (const kid of children.get(ticket.id) ?? []) {
      if (kid.status === "cancelled") excluded += 1;
      else {
        total += 1;
        if (kid.status === "done") done += 1;
      }
      const nested = children.has(kid.id) ? (result.get(kid.id) ?? visit(kid)) : null;
      if (nested) {
        done += nested.done;
        total += nested.total;
        excluded += nested.excluded;
      }
    }
    const progress = { done, total, excluded };
    result.set(ticket.id, progress);
    return progress;
  };
  for (const ticket of tickets) {
    if (children.has(ticket.id) && !result.has(ticket.id)) visit(ticket);
  }
  return result;
}

/** Number of open direct children of a ticket (the rule for concluding it, ADR 0034). */
export function openChildCount(tickets: readonly TicketNode[], ticketId: string): number {
  return tickets.filter((ticket) => ticket.parentId === ticketId && !isFinished(ticket.status)).length;
}

/**
 * "Ticket da vez" (ADR 0034) from what the web has at hand: open, and no open descendant. `progress` is the ticket's
 * `progress` field (null without children); with children, no open descendant means `done === total` (the cancelled
 * ones are in `excluded`).
 */
export function isTurn(status: TicketStatus, progress: TicketProgress | null): boolean {
  return !isFinished(status) && (progress === null || progress.done === progress.total);
}

/** The ids of the tickets of the turn, computed from the tree: open tickets with no open descendant. */
export function ticketsOfTheTurn(tickets: readonly TicketNode[]): Set<string> {
  const children = childrenByParent(tickets);
  const hasOpenDescendant = new Map<string, boolean>();
  const visit = (ticket: TicketNode): boolean => {
    const known = hasOpenDescendant.get(ticket.id);
    if (known !== undefined) return known;
    let found = false;
    for (const kid of children.get(ticket.id) ?? []) {
      // Sem curto-circuito: todos os filhos são visitados, para o cache ficar completo.
      if (!isFinished(kid.status)) found = true;
      if (visit(kid)) found = true;
    }
    hasOpenDescendant.set(ticket.id, found);
    return found;
  };
  const turn = new Set<string>();
  for (const ticket of tickets) {
    if (!isFinished(ticket.status) && !visit(ticket)) turn.add(ticket.id);
  }
  return turn;
}

/** True when making `newParentId` the parent of `ticketId` would make the ticket its own ancestor. */
export function parentWouldCreateCycle(
  parentById: ReadonlyMap<string, string | null>,
  ticketId: string,
  newParentId: string | null,
): boolean {
  const seen = new Set<string>();
  let cursor = newParentId;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ticketId) return true;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
}

const EXCERPT_LENGTH = 600;

/** First 600 code points of a description, ending in "…" when it is longer. Never splits a surrogate pair. */
export function descriptionExcerpt(description: string): string {
  if (description.length <= EXCERPT_LENGTH) return description;
  const points = Array.from(description);
  if (points.length <= EXCERPT_LENGTH) return description;
  return `${points.slice(0, EXCERPT_LENGTH).join("")}…`;
}

/**
 * Reabertura do pai concluído (ADR 0034): `parentId` é o pai que acaba de ganhar um filho direto aberto. Devolve os ids
 * a reabrir, de baixo para cima: o pai, se estiver `done`, depois o pai dele, e assim por diante, até o primeiro
 * ancestral que não esteja `done` (cancelado também interrompe) ou a raiz.
 */
export function ticketsToReopen(
  parentById: ReadonlyMap<string, string | null>,
  statusById: ReadonlyMap<string, TicketStatus>,
  parentId: string | null,
): string[] {
  const reopen: string[] = [];
  const seen = new Set<string>();
  let cursor = parentId;
  while (cursor !== null && !seen.has(cursor) && statusById.get(cursor) === "done") {
    seen.add(cursor);
    reopen.push(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return reopen;
}
