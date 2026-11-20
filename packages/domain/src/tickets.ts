import type { Actor, ProjectAccess } from "./index.js";
import { canViewProject } from "./index.js";

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Minimal ticket shape needed to compute progress. */
export interface TicketNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: TicketStatus;
}

/** Progress over descendant leaves: `excluded` counts cancelled, `total` the rest, `done` the finished ones. */
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

/**
 * Progress for every ticket that has children, keyed by ticket ID. Leaves have no entry.
 * Only descendant leaves count; the stored status of a ticket with children is ignored.
 */
export function ticketProgress(tickets: readonly TicketNode[]): Map<string, TicketProgress> {
  const children = new Map<string, TicketNode[]>();
  for (const ticket of tickets) {
    if (ticket.parentId === null) continue;
    const siblings = children.get(ticket.parentId);
    if (siblings) siblings.push(ticket);
    else children.set(ticket.parentId, [ticket]);
  }
  const result = new Map<string, TicketProgress>();
  const visit = (ticket: TicketNode): TicketProgress | null => {
    const kids = children.get(ticket.id);
    if (!kids) return null;
    let done = 0;
    let total = 0;
    let excluded = 0;
    for (const kid of kids) {
      const nested = visit(kid);
      if (nested) {
        done += nested.done;
        total += nested.total;
        excluded += nested.excluded;
      } else if (kid.status === "cancelled") {
        excluded += 1;
      } else {
        total += 1;
        if (kid.status === "done") done += 1;
      }
    }
    const progress = { done, total, excluded };
    result.set(ticket.id, progress);
    return progress;
  };
  for (const ticket of tickets) {
    if (ticket.parentId === null) visit(ticket);
  }
  return result;
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
