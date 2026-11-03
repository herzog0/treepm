import type { Progress, Ticket } from "./types.js";

export function childrenOf(tickets: Ticket[], parentId: string | null): Ticket[] {
  return tickets
    .filter((ticket) => ticket.parentId === parentId)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function descendantsOf(tickets: Ticket[], ticketId: string): Ticket[] {
  const result: Ticket[] = [];
  const visit = (parentId: string) => {
    for (const child of childrenOf(tickets, parentId)) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(ticketId);
  return result;
}

export function descendantIds(tickets: Ticket[], ticketId: string): Set<string> {
  return new Set(descendantsOf(tickets, ticketId).map((ticket) => ticket.id));
}

export function ticketIdentifier(ticket: Ticket, projectKey: string): string {
  return `${projectKey}-${String(ticket.sequence).padStart(3, "0")}`;
}

function summarizeLeaves(leaves: Ticket[]): Progress {
  const doneLeaves = leaves.filter((item) => item.status === "done").length;
  const startedLeaves = leaves.filter((item) => item.status !== "todo").length;
  const totalLeaves = leaves.length;
  const percent = totalLeaves === 0 ? 0 : Math.round((doneLeaves / totalLeaves) * 100);
  const status = totalLeaves > 0 && doneLeaves === totalLeaves
    ? "done"
    : startedLeaves === 0
      ? "not_started"
      : "active";

  return {
    doneLeaves,
    totalLeaves,
    percent,
    status,
    label: totalLeaves === 0 ? "Sem folhas" : `${doneLeaves} de ${totalLeaves} folhas concluídas · ${percent}%`,
  };
}

export function getProgress(tickets: Ticket[], ticketId: string): Progress {
  const ticket = tickets.find((item) => item.id === ticketId);
  if (!ticket) return summarizeLeaves([]);

  const descendants = descendantsOf(tickets, ticketId);
  const leaves = descendants.length === 0
    ? [ticket]
    : descendants.filter((item) => childrenOf(tickets, item.id).length === 0);
  return summarizeLeaves(leaves);
}

export function getProjectProgress(tickets: Ticket[]): Progress {
  const leaves = tickets.filter((ticket) => !tickets.some((item) => item.parentId === ticket.id));
  return summarizeLeaves(leaves);
}

export function validateParent(
  tickets: Ticket[],
  ticketId: string | null,
  parentId: string | null,
): string | null {
  if (parentId === null) return null;
  if (ticketId !== null && ticketId === parentId) return "Um ticket não pode ser pai de si mesmo.";
  const parent = tickets.find((ticket) => ticket.id === parentId);
  if (!parent) return "O ticket pai informado não existe.";
  if (ticketId !== null && descendantIds(tickets, ticketId).has(parentId)) {
    return "A movimentação criaria um ciclo na hierarquia.";
  }
  return null;
}

export function createsDependencyCycle(
  edges: { sourceId: string; targetId: string; type: string }[],
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "dependency") continue;
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), edge.targetId]);
  }
  const pending = [targetId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === sourceId) return true;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function depthOf(tickets: Ticket[], ticketId: string): number {
  let depth = 0;
  let current = tickets.find((ticket) => ticket.id === ticketId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    depth += 1;
    current = tickets.find((ticket) => ticket.id === current?.parentId);
  }
  return depth;
}
