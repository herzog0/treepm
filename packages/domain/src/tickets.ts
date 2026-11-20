import type { Actor, ProjectAccess } from "./index.js";
import { canViewProject } from "./index.js";

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Tipo do nó (ADR 0031): ticket (tem situação, nunca tem filhos) ou agrupador (tem filhos e progresso). */
export type TicketKind = "ticket" | "group";

/** Minimal ticket shape needed to compute progress. */
export interface TicketNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: TicketKind;
  readonly status: TicketStatus;
}

/** Só agrupador pode ser pai de um nó. */
export function canHaveChildren(kind: TicketKind): boolean {
  return kind === "group";
}

/**
 * Transformar um nó em outro tipo: ticket em agrupador é sempre permitido; agrupador em ticket só quando não tem
 * filhos. Manter o tipo é sempre permitido.
 */
export function kindChangeAllowed(from: TicketKind, to: TicketKind, childCount: number): boolean {
  return from === "ticket" || to === "group" || childCount === 0;
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
 * Progress for every group, keyed by ID (ADR 0031). Tickets have no entry; an empty group is zero of zero.
 * Only descendant tickets count, at any depth; groups are not items and their stored status is ignored.
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
  const visit = (group: TicketNode): TicketProgress => {
    let done = 0;
    let total = 0;
    let excluded = 0;
    for (const kid of children.get(group.id) ?? []) {
      if (kid.kind === "group") {
        const nested = visit(kid);
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
    result.set(group.id, progress);
    return progress;
  };
  for (const ticket of tickets) {
    if (ticket.kind === "group" && !result.has(ticket.id)) visit(ticket);
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

const EXCERPT_LENGTH = 600;

/** First 600 code points of a description, ending in "…" when it is longer. Never splits a surrogate pair. */
export function descriptionExcerpt(description: string): string {
  if (description.length <= EXCERPT_LENGTH) return description;
  const points = Array.from(description);
  if (points.length <= EXCERPT_LENGTH) return description;
  return `${points.slice(0, EXCERPT_LENGTH).join("")}…`;
}
