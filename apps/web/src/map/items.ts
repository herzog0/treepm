import type { TreeNode } from "@treepm/engine";
import { mixIndicatorColors } from "@treepm/react";
import type { MixColors } from "@treepm/react";
import type { Me, Project, TicketStatus, TicketSummary } from "../api/client.js";
import { hasOpenDescendants } from "./ticketState.js";

export interface MapNode extends TreeNode {
  readonly kind: "organization" | "project" | "ticket" | "draft";
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

/** Nó temporário do rascunho da conversa com a IA (ADR 0029): card tracejado que não é ticket. */
export const DRAFT_NODE_ID = "assistant-draft";

/** Onde o rascunho aparece no mapa: filho do ticket `parentId`, ou da raiz do projeto quando é nulo. */
export interface MapDraft {
  readonly projectId: string;
  readonly parentId: string | null;
  readonly title: string;
}

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
  draft?: MapDraft | null,
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
      color: STATUS_COLORS[ticket.status],
      key: ticket.key,
      ticket,
      leafCount: 1,
    })),
  );
  const painted = paintBranches([root, ...children, ...tickets]);
  if (!draft) return painted;
  // O card do rascunho entra depois da mistura de cores: ele não é folha de ninguém e não pinta o ramo.
  const parentId = draft.parentId ?? draft.projectId;
  if (!visible.some((project) => project.id === draft.projectId) || !painted.some((node) => node.id === parentId)) return painted;
  const ghost: MapNode = {
    id: DRAFT_NODE_ID,
    parentId,
    kind: "draft",
    label: draft.title.trim() === "" ? "Novo ticket" : draft.title.trim(),
    color: ACCENT_COLOR,
    key: "Novo",
    ticket: null,
    leafCount: 1,
  };
  return [...painted, ghost];
}

/**
 * Ticket com descendente aberto (ADR 0034) ganha a mistura das cores de todos os descendentes, cada um com a própria
 * situação (os que também têm filhos entram como itens). Sem descendente aberto, ou sem filhos, fica com a cor da
 * própria situação, como qualquer folha. Só quem tem descendente aberto muda: os demais já estão pintados.
 */
function paintBranches(nodes: readonly MapNode[]): readonly MapNode[] {
  const childrenOf = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const descendants = (node: MapNode): MapNode[] => (childrenOf.get(node.id) ?? []).flatMap((child) => [child, ...descendants(child)]);
  return nodes.map((node) => {
    if (!node.ticket || !hasOpenDescendants(node.ticket)) return node;
    const found = descendants(node).filter((entry) => entry.ticket !== null);
    if (found.length === 0) return node;
    return { ...node, leafCount: found.length, color: mixWeightedColors(found.map((entry) => ({ color: entry.color, weight: 1 }))) };
  });
}
