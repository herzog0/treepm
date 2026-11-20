import type { TicketSummary } from "../api/client.js";

/** Ancestrais do ticket, do mais alto ao pai imediato. Para no primeiro pai ausente da lista. */
export function ancestorsOf(tickets: readonly TicketSummary[], ticket: Pick<TicketSummary, "parentId">): TicketSummary[] {
  const byId = new Map(tickets.map((entry) => [entry.id, entry]));
  const path: TicketSummary[] = [];
  let parent = ticket.parentId === null ? undefined : byId.get(ticket.parentId);
  while (parent && !path.includes(parent)) {
    path.unshift(parent);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return path;
}

/** IDs de todos os descendentes do ticket (filhos, netos…). */
export function descendantIds(tickets: readonly TicketSummary[], id: string): Set<string> {
  const childrenOf = new Map<string, TicketSummary[]>();
  for (const entry of tickets) {
    if (entry.parentId === null) continue;
    const siblings = childrenOf.get(entry.parentId) ?? [];
    siblings.push(entry);
    childrenOf.set(entry.parentId, siblings);
  }
  const found = new Set<string>();
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (found.has(next.id)) continue;
    found.add(next.id);
    queue.push(...(childrenOf.get(next.id) ?? []));
  }
  return found;
}
