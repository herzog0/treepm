import type { Progress, Ticket, TicketStatus } from "./types.js";

export type LeafStatusCounts = Record<TicketStatus, number>;

export interface TreeIndex {
  readonly ticketById: ReadonlyMap<string, Ticket>;
  readonly childrenByParentId: ReadonlyMap<string | null, readonly Ticket[]>;
  readonly depthById: ReadonlyMap<string, number>;
  readonly subtreeHeightById: ReadonlyMap<string, number>;
  readonly subtreeCountById: ReadonlyMap<string, number>;
  readonly descendantCountById: ReadonlyMap<string, number>;
  readonly leafCountsById: ReadonlyMap<string, LeafStatusCounts>;
  readonly progressById: ReadonlyMap<string, Progress>;
  readonly projectProgress: Progress;
}

interface MutableAggregate {
  pendingChildren: number;
  subtreeCount: number;
  subtreeHeight: number;
  leaves: LeafStatusCounts;
}

const emptyLeaves = (): LeafStatusCounts => ({ todo: 0, in_progress: 0, done: 0 });

function addLeaves(target: LeafStatusCounts, source: LeafStatusCounts) {
  target.todo += source.todo;
  target.in_progress += source.in_progress;
  target.done += source.done;
}

function progressFromLeaves(leaves: LeafStatusCounts): Progress {
  const totalLeaves = leaves.todo + leaves.in_progress + leaves.done;
  const doneLeaves = leaves.done;
  const startedLeaves = leaves.in_progress + leaves.done;
  const percent = totalLeaves === 0 ? 0 : Math.round((doneLeaves / totalLeaves) * 100);
  const status = totalLeaves > 0 && doneLeaves === totalLeaves
    ? "done"
    : startedLeaves === 0
      ? "not_started"
      : "active";
  return Object.freeze({
    doneLeaves,
    totalLeaves,
    percent,
    status,
    label: totalLeaves === 0 ? "Sem folhas" : `${doneLeaves} de ${totalLeaves} folhas concluídas · ${percent}%`,
  });
}

export function buildTreeIndex(tickets: Ticket[]): TreeIndex {
  const ticketById = new Map<string, Ticket>();
  const mutableChildren = new Map<string | null, Ticket[]>();
  for (const ticket of tickets) {
    ticketById.set(ticket.id, ticket);
    const siblings = mutableChildren.get(ticket.parentId) ?? [];
    siblings.push(ticket);
    mutableChildren.set(ticket.parentId, siblings);
  }

  const childrenByParentId = new Map<string | null, readonly Ticket[]>();
  for (const [parentId, children] of mutableChildren) {
    children.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    childrenByParentId.set(parentId, Object.freeze(children));
  }

  const aggregates = new Map<string, MutableAggregate>();
  const ready: string[] = [];
  for (const ticket of ticketById.values()) {
    const children = childrenByParentId.get(ticket.id) ?? [];
    const leaves = emptyLeaves();
    if (children.length === 0) leaves[ticket.status] = 1;
    aggregates.set(ticket.id, {
      pendingChildren: children.length,
      subtreeCount: 1,
      subtreeHeight: 0,
      leaves,
    });
    if (children.length === 0) ready.push(ticket.id);
  }

  for (let index = 0; index < ready.length; index += 1) {
    const childId = ready[index];
    if (childId === undefined) continue;
    const child = ticketById.get(childId);
    const childAggregate = aggregates.get(childId);
    if (!child || child.parentId === null || !childAggregate) continue;
    const parent = ticketById.get(child.parentId);
    const parentAggregate = aggregates.get(child.parentId);
    if (!parent || !parentAggregate) continue;
    parentAggregate.pendingChildren -= 1;
    parentAggregate.subtreeCount += childAggregate.subtreeCount;
    parentAggregate.subtreeHeight = Math.max(parentAggregate.subtreeHeight, childAggregate.subtreeHeight + 1);
    addLeaves(parentAggregate.leaves, childAggregate.leaves);
    if (parentAggregate.pendingChildren === 0) ready.push(parent.id);
  }

  const depthById = new Map<string, number>();
  const subtreeHeightById = new Map<string, number>();
  const subtreeCountById = new Map<string, number>();
  const descendantCountById = new Map<string, number>();
  const leafCountsById = new Map<string, LeafStatusCounts>();
  const progressById = new Map<string, Progress>();
  for (const ticket of ticketById.values()) {
    const aggregate = aggregates.get(ticket.id);
    if (!aggregate) continue;
    const leaves = Object.freeze({ ...aggregate.leaves });
    subtreeHeightById.set(ticket.id, aggregate.subtreeHeight);
    subtreeCountById.set(ticket.id, aggregate.subtreeCount);
    descendantCountById.set(ticket.id, aggregate.subtreeCount - 1);
    leafCountsById.set(ticket.id, leaves);
    progressById.set(ticket.id, progressFromLeaves(leaves));
  }

  for (const ticket of ticketById.values()) {
    if (depthById.has(ticket.id)) continue;
    const path: Ticket[] = [];
    const pathIds = new Set<string>();
    let current: Ticket | undefined = ticket;
    let knownDepth: number | undefined;
    while (current) {
      const cached = depthById.get(current.id);
      if (cached !== undefined) {
        knownDepth = cached;
        break;
      }
      if (pathIds.has(current.id)) break;
      path.push(current);
      pathIds.add(current.id);
      current = current.parentId === null ? undefined : ticketById.get(current.parentId);
    }
    const last = path[path.length - 1];
    let nextDepth = knownDepth !== undefined ? knownDepth + 1 : last?.parentId === null ? 0 : 1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const item = path[index];
      if (!item) continue;
      depthById.set(item.id, nextDepth);
      nextDepth += 1;
    }
  }

  const projectLeaves = emptyLeaves();
  for (const ticket of ticketById.values()) {
    if ((childrenByParentId.get(ticket.id)?.length ?? 0) === 0) projectLeaves[ticket.status] += 1;
  }

  return {
    ticketById,
    childrenByParentId,
    depthById,
    subtreeHeightById,
    subtreeCountById,
    descendantCountById,
    leafCountsById,
    progressById,
    projectProgress: progressFromLeaves(projectLeaves),
  };
}
