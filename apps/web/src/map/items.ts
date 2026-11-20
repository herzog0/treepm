import type { TreeNode } from "@treepm/engine";
import { mixIndicatorColors } from "@treepm/react";
import type { MixColors } from "@treepm/react";
import type { Me, Project, TicketStatus, TicketSummary } from "../api/client.js";

export interface MapNode extends TreeNode {
  readonly kind: "organization" | "project" | "ticket";
  readonly label: string;
  readonly color: string;
  /** Chave do projeto, mostrada onde a demo mostra o ID. */
  readonly key: string | null;
  /** Dados do ticket quando `kind` é `ticket`; nulo nos demais nós. */
  readonly ticket: TicketSummary | null;
  /** Folhas sob o nó (ele próprio, se for folha); peso do nó na mistura de cores. */
  readonly leafCount: number;
}

/**
 * Cópias hexadecimais dos tokens `--tp-accent` e de situação: a mistura de cores do pacote trabalha com
 * cores resolvidas, não com `var()`. `theme.test.ts` garante que continuam iguais a `theme.css`.
 */
export const ACCENT_COLOR = "#a99bff";
export const STATUS_COLORS: Record<TicketStatus, string> = {
  todo: "#8b92a3",
  in_progress: "#6ea8ff",
  in_review: "#e7b450",
  done: "#4fc48c",
  cancelled: "#8b92a3",
};

export interface WeightedColor {
  readonly color: string;
  readonly weight: number;
}

/** Média ponderada em luz linear (a do pacote). Com pesos iguais a cores iguais, devolve a própria cor. */
export function mixWeightedColors(entries: readonly WeightedColor[]): string {
  return mixIndicatorColors(entries);
}

/**
 * Cor de um quadrado mesclado: a mistura das cores dos membros pesada pelo número de folhas de cada um,
 * o que equivale à mistura das folhas descendentes (a mesma regra de `buildMapItems` para um ticket com filhos).
 */
export const mixMapColors: MixColors<MapNode> = (colors, members) =>
  mixWeightedColors(colors.map((entry, position) => ({ color: entry.color, weight: members[position]?.leafCount ?? 1 })));

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
    color: ACCENT_COLOR,
    key: null,
    ticket: null,
    leafCount: 1,
  };
  const visible = projects.filter((project) => project.archivedAt === null);
  const children = visible.map<MapNode>((project) => ({
    id: project.id,
    parentId: organization.orgId,
    kind: "project",
    label: project.name,
    color: ACCENT_COLOR,
    key: project.key,
    ticket: null,
    leafCount: 1,
  }));
  const tickets = visible.flatMap((project) =>
    (ticketsByProject[project.id] ?? []).map<MapNode>((ticket) => ({
      id: ticket.id,
      parentId: ticket.parentId ?? project.id,
      kind: "ticket",
      label: ticket.title,
      color: ticket.status ? STATUS_COLORS[ticket.status] : STATUS_COLORS.todo,
      key: ticket.key,
      ticket,
      leafCount: 1,
    })),
  );
  return paintBranches([root, ...children, ...tickets]);
}

/** Ticket com filhos ganha a mistura das cores das folhas descendentes; só ele muda, as folhas já estão pintadas. */
function paintBranches(nodes: readonly MapNode[]): readonly MapNode[] {
  const childrenOf = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const leaves = (node: MapNode): MapNode[] => {
    const below = childrenOf.get(node.id);
    return below ? below.flatMap(leaves) : [node];
  };
  return nodes.map((node) => {
    if (node.kind !== "ticket" || !childrenOf.has(node.id)) return node;
    const found = leaves(node);
    return { ...node, leafCount: found.length, color: mixWeightedColors(found.map((leaf) => ({ color: leaf.color, weight: 1 }))) };
  });
}
