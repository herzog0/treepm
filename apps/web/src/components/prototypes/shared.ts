import { childrenOf, descendantsOf, getProgress } from "@treepm/domain";
import type { Project, Ticket, User } from "@treepm/domain";

export const PROTOTYPE_VARIANTS = ["A", "B", "C", "D"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

export interface PrototypeData {
  project: Project;
  tickets: Ticket[];
  users: User[];
}

export function parsePrototypeVariant(search: string): PrototypeVariant | null {
  const variant = new URLSearchParams(search).get("variant");
  return PROTOTYPE_VARIANTS.find((item) => item === variant) ?? null;
}

export function ticketPath(tickets: Ticket[], ticketId: string): Ticket[] {
  const path: Ticket[] = [];
  const visited = new Set<string>();
  let current = tickets.find((ticket) => ticket.id === ticketId);
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = tickets.find((ticket) => ticket.id === current?.parentId);
  }
  return path;
}

export function statusInfo(tickets: Ticket[], ticket: Ticket) {
  const isLeaf = childrenOf(tickets, ticket.id).length === 0;
  const progress = getProgress(tickets, ticket.id);
  const status = isLeaf ? ticket.status : progress.status;
  const label = isLeaf
    ? { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" }[ticket.status]
    : `${progress.doneLeaves}/${progress.totalLeaves} folhas · ${progress.percent}%`;
  return { isLeaf, progress, status, label };
}

export function hiddenCount(tickets: Ticket[], ticket: Ticket): number {
  return descendantsOf(tickets, ticket.id).length;
}

export function personInitials(userIds: string[], users: User[]): string {
  return userIds.map((id) => users.find((user) => user.id === id)?.name ?? "")
    .filter(Boolean)
    .map((name) => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2))
    .join(" · ");
}

export function visibleLabel(visible: number, summarized: number): string {
  return `${visible} visíveis · ${summarized} resumidos`;
}
