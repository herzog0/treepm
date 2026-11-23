import type { TreeNode } from "@treepm/engine";
import type { TFunction } from "i18next";
import i18n from "../i18n/index.js";
import { mixIndicatorColorCounts, mixIndicatorColors } from "@treepm/react";
import type { MixColors } from "@treepm/react";
import type { Me, Project, TicketStatus, TicketSummary } from "../api/client.js";
import { hasOpenDescendants, isInDiscardedIdea } from "./ticketState.js";

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
  /** O ticket está numa ideia descartada (a raiz ou algo dentro dela): o nó usa a cor de ideia apagada (ADR 0042). */
  readonly ideaDiscarded?: boolean;
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

/** Cópia hexadecimal de `--tp-idea` (ADR 0042): a cor de todo nó dentro de uma ideia, qualquer que seja a situação. */
export const IDEA_COLOR = "#e879c6";
const BACKGROUND_COLOR = "#08090d";

/** Mistura em sRGB, canal a canal, o mesmo cálculo do `color-mix(in srgb, …)` da folha de estilo. */
function blendHex(from: string, into: string, share: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const part = (at: number) => Math.round(channel(from, at) * share + channel(into, at) * (1 - share));
  return `#${[1, 3, 5].map((at) => part(at).toString(16).padStart(2, "0")).join("")}`;
}
/** A mesma cor de ideia, 50% misturada com o fundo: a ideia descartada, a raiz e tudo dentro dela. */
export const IDEA_DISCARDED_COLOR = blendHex(IDEA_COLOR, BACKGROUND_COLOR, 0.5);

/** O ticket é a raiz de uma ideia ou está dentro de uma (ADR 0042). */
export const isInIdea = (ticket: Pick<TicketSummary, "idea">): boolean => ticket.idea !== null && ticket.idea !== undefined;

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
  t: TFunction<"map"> = i18n.getFixedT(null, "map"),
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
  const tickets = visible.flatMap((project) => {
    const listed = ticketsByProject[project.id] ?? [];
    const byId = new Map(listed.map((ticket) => [ticket.id, ticket]));
    return listed.map<MapNode>((ticket) => {
      const idea = isInIdea(ticket);
      const muted = idea && isInDiscardedIdea(ticket, byId);
      return {
        id: ticket.id,
        parentId: ticket.parentId ?? project.id,
        kind: "ticket",
        label: ticket.title,
        color: !idea ? STATUS_COLORS[ticket.status] : muted ? IDEA_DISCARDED_COLOR : IDEA_COLOR,
        key: ticket.key,
        ticket,
        leafCount: 1,
        ...(muted ? { ideaDiscarded: true } : {}),
      };
    });
  });
  const painted = paintBranches([root, ...children, ...tickets]);
  if (!draft) return painted;
  // O card do rascunho entra depois da mistura de cores: ele não é folha de ninguém e não pinta o ramo.
  const parentId = draft.parentId ?? draft.projectId;
  if (!visible.some((project) => project.id === draft.projectId) || !painted.some((node) => node.id === parentId)) return painted;
  const ghost: MapNode = {
    id: DRAFT_NODE_ID,
    parentId,
    kind: "draft",
    label: draft.title.trim() === "" ? t("draft.title") : draft.title.trim(),
    color: ACCENT_COLOR,
    key: t("draft.key"),
    ticket: null,
    leafCount: 1,
  };
  return [...painted, ghost];
}

/**
 * Ticket com descendente aberto (ADR 0034) ganha a mistura das cores de todos os descendentes, cada um com a própria
 * situação (os que também têm filhos entram como itens). Sem descendente aberto, ou sem filhos, fica com a cor da
 * própria situação, como qualquer folha. Só quem tem descendente aberto muda: os demais já estão pintados.
 *
 * Uma passada de baixo para cima: cada nó soma, por cor, os descendentes que não são de ideia (a mistura em luz linear
 * só depende de quantos membros há de cada cor, não da ordem). `mixIndicatorColorCounts` faz a mesma conta de `mixIndicatorColors`.
 */
export function paintBranches(nodes: readonly MapNode[]): readonly MapNode[] {
  const childrenOf = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  // Contagem por cor dos descendentes de ticket comum, de cada nó que tem filhos (pós-ordem, sem recursão).
  const below = new Map<string, Map<string, number>>();
  const done = new Set<string>();
  for (const start of nodes) {
    if (done.has(start.id)) continue;
    const stack: { node: MapNode; at: number }[] = [{ node: start, at: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = childrenOf.get(frame.node.id);
      if (children !== undefined && frame.at < children.length) {
        const child = children[frame.at]!;
        frame.at += 1;
        if (!done.has(child.id)) stack.push({ node: child, at: 0 });
        continue;
      }
      stack.pop();
      done.add(frame.node.id);
      if (children === undefined) continue;
      const counts = new Map<string, number>();
      for (const child of children) {
        if (child.ticket !== null && !isInIdea(child.ticket)) counts.set(child.color, (counts.get(child.color) ?? 0) + 1);
        const childCounts = below.get(child.id);
        if (childCounts) for (const [color, count] of childCounts) counts.set(color, (counts.get(color) ?? 0) + count);
      }
      below.set(frame.node.id, counts);
    }
  }
  return nodes.map((node) => {
    // Os nós de ideia têm cor própria e não entram na mistura de quem está fora da ideia (ADR 0042).
    if (!node.ticket || isInIdea(node.ticket) || !hasOpenDescendants(node.ticket)) return node;
    const counts = below.get(node.id);
    if (counts === undefined) return node;
    let found = 0;
    for (const count of counts.values()) found += count;
    if (found === 0) return node;
    return { ...node, leafCount: found, color: mixIndicatorColorCounts(counts) };
  });
}
