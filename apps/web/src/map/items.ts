import type { TreeNode } from "@treepm/engine";
import type { Me, Project, TicketSummary } from "../api/client.js";

export interface MapNode extends TreeNode {
  readonly kind: "organization" | "project" | "ticket";
  readonly label: string;
  readonly color: string;
  /** Chave do projeto, mostrada onde a demo mostra o ID. */
  readonly key: string | null;
  /** Dados do ticket quando `kind` é `ticket`; nulo nos demais nós. */
  readonly ticket: TicketSummary | null;
}

export const ORGANIZATION_COLOR = "#6853a5";

const PALETTE = [
  "#8459b8",
  "#b94361",
  "#21865e",
  "#286fad",
  "#aa641c",
  "#6154b5",
  "#a8397f",
  "#1f7f8a",
] as const;

/** Cor estável por semente (ID ou chave do projeto): hash FNV-1a sobre a paleta. */
export function projectColor(seed: string): string {
  let hash = 0x811c9dc5;
  for (let position = 0; position < seed.length; position++) {
    hash ^= seed.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

/**
 * Organização na raiz, projetos abaixo dela e tickets abaixo do pai (ou do projeto, na raiz).
 * `ticketsByProject` traz a listagem de cada projeto na ordem da API (por `number`), que é a ordem dos irmãos.
 */
export function buildMapItems(
  organization: Me["organization"],
  projects: readonly Project[],
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>,
): readonly MapNode[] {
  const root: MapNode = {
    id: organization.orgId,
    parentId: null,
    kind: "organization",
    label: organization.name,
    color: ORGANIZATION_COLOR,
    key: null,
    ticket: null,
  };
  const visible = projects.filter((project) => project.archivedAt === null);
  const children = visible.map<MapNode>((project) => ({
    id: project.id,
    parentId: organization.orgId,
    kind: "project",
    label: project.name,
    color: projectColor(project.id),
    key: project.key,
    ticket: null,
  }));
  const tickets = visible.flatMap((project) =>
    (ticketsByProject[project.id] ?? []).map<MapNode>((ticket) => ({
      id: ticket.id,
      parentId: ticket.parentId ?? project.id,
      kind: "ticket",
      label: ticket.title,
      color: projectColor(project.id),
      key: ticket.key,
      ticket,
    })),
  );
  return [root, ...children, ...tickets];
}
