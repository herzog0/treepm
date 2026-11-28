import { enablers, inSiblingOrder } from "@treepm/domain";
import type { DependencyEdge } from "@treepm/domain";
import type { TreeNode } from "@treepm/engine";
import type { TFunction } from "i18next";
import i18n from "../i18n/index.js";
import type { MixColors } from "@treepm/react";
import type { Me, Project, TicketSummary } from "../api/client.js";
import { ACCENT_COLOR, CANCELLED_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, PRECEDENCE, SITUATION_COLORS, STATUS_COLORS, effectiveSituation, mostWorryingColor, situationRank } from "./situation.js";
import { hasOpenDescendants, isInDiscardedIdea } from "./ticketState.js";

// A paleta mora em `situation.ts` (ADR 0051); estes nomes continuam saindo daqui para quem já os importava.
export { ACCENT_COLOR, CANCELLED_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS };

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
  /** O habilitador (ADR 0069, seção 2): um irmão depende dele para começar e ele não depende de nenhum irmão. O card diz "abre os irmãos". */
  readonly enabler?: boolean;
  /** Os três números de um ticket com filhos (ADR 0069, seção 4), da subárvore inteira; ausente sem ticket que conte abaixo. */
  readonly counts?: SubtreeCounts;
}

/** Quantos tickets, quantos prontos e quantos livres há abaixo de um pai (ADR 0069, seção 4). Ideias e cancelados ficam fora. */
export interface SubtreeCounts {
  readonly tickets: number;
  readonly done: number;
  readonly free: number;
}

/** Livre para começar agora: "a fazer", sem filhos, com o lugar "livre" e sem impedimento (a mesma regra da fila de trabalho, ADR 0068). */
const isFreeToStart = (ticket: TicketSummary): boolean => ticket.status === "todo" && ticket.place === "free" && ticket.blocked !== true && !isInIdea(ticket);

/**
 * Os três números de cada ticket com filhos de um projeto: tickets e prontos saem do progresso que a API manda (sem ideias nem
 * cancelados), livres são contados aqui, subindo de cada ticket livre até a raiz.
 */
function subtreeCounts(tickets: readonly TicketSummary[]): Map<string, SubtreeCounts> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const free = new Map<string, number>();
  for (const ticket of tickets) {
    if (!isFreeToStart(ticket)) continue;
    const seen = new Set<string>();
    for (let up = ticket.parentId; up !== null && !seen.has(up); up = byId.get(up)?.parentId ?? null) {
      seen.add(up);
      free.set(up, (free.get(up) ?? 0) + 1);
    }
  }
  const counts = new Map<string, SubtreeCounts>();
  for (const ticket of tickets) {
    const progress = ticket.progress;
    if (progress === null || progress.total === 0 || isInIdea(ticket)) continue;
    counts.set(ticket.id, { tickets: progress.total, done: progress.done, free: free.get(ticket.id) ?? 0 });
  }
  return counts;
}

/** As dependências da lista de um projeto, como arestas: `from` depende de `to` (ADR 0069, seção 1). */
export function dependencyEdges(tickets: readonly TicketSummary[]): DependencyEdge[] {
  return tickets.flatMap((ticket) => (ticket.dependencies ?? []).map((dependency) => ({ from: ticket.id, to: dependency.id, need: dependency.need })));
}

/**
 * A lista de um projeto na ordem dos irmãos (ADR 0069, seção 2: passo, prioridade efetiva, número) e os habilitadores. A ordem de entrada
 * é a ordem dos irmãos no motor, que continua genérico.
 */
function orderProject(tickets: readonly TicketSummary[]): { ordered: TicketSummary[]; enablerIds: ReadonlySet<string> } {
  const edges = dependencyEdges(tickets);
  if (edges.length === 0) return { ordered: [...tickets], enablerIds: new Set() };
  const nodes = tickets.map((ticket) => ({
    id: ticket.id,
    parentId: ticket.parentId,
    status: ticket.status,
    ideaStage: ticket.idea?.root === true ? ticket.idea.stage : null,
    number: ticket.number,
    priority: ticket.priority ?? 0,
    ticket,
  }));
  return { ordered: inSiblingOrder(nodes, edges).map((node) => node.ticket), enablerIds: enablers(nodes, edges) };
}

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

/**
 * Cor de um quadrado mesclado (ADR 0051): a mais preocupante entre as dos membros, nunca uma média. Como a cor de cada
 * membro já é a do seu ramo, o quadrado mostra o pior que há dentro dele.
 */
export const mixMapColors: MixColors<MapNode> = (colors) => mostWorryingColor(colors.map((entry) => entry.color));

/** Cor própria do ticket, antes de os ramos serem pintados: a situação, vermelho quando bloqueado (ADR 0051), o lugar na fila num "a fazer" sem filhos (ADR 0069). */
function ticketColor(ticket: TicketSummary): string {
  const situation = effectiveSituation(ticket);
  return situation === "cancelled" ? CANCELLED_COLOR : SITUATION_COLORS[situation];
}

/**
 * Organização na raiz, projetos abaixo dela e tickets abaixo do pai (ou do projeto, na raiz).
 * `ticketsByProject` traz a listagem de cada projeto na ordem da API (por `number`); os irmãos saem na ordem das dependências (ADR 0069).
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
    const { ordered, enablerIds } = orderProject(listed);
    const counts = subtreeCounts(listed);
    return ordered.map<MapNode>((ticket) => {
      const idea = isInIdea(ticket);
      const muted = idea && isInDiscardedIdea(ticket, byId);
      return {
        id: ticket.id,
        parentId: ticket.parentId ?? project.id,
        kind: "ticket",
        label: ticket.title,
        color: !idea ? ticketColor(ticket) : muted ? IDEA_DISCARDED_COLOR : IDEA_COLOR,
        key: ticket.key,
        ticket,
        leafCount: 1,
        ...(muted ? { ideaDiscarded: true } : {}),
        ...(enablerIds.has(ticket.id) ? { enabler: true } : {}),
        ...(counts.has(ticket.id) ? { counts: counts.get(ticket.id)! } : {}),
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

const NOT_RANKED = Number.POSITIVE_INFINITY;
/** Depois das cinco situações: só há cancelados abaixo (cinza apagado). */
const ONLY_CANCELLED = PRECEDENCE.length;

/**
 * Pinta os ramos (ADR 0051): todo nó com tickets abaixo (ticket com filhos, projeto, organização) ganha a cor da primeira
 * situação da precedência (bloqueado › em andamento › em revisão › livre › próximo › esperando › a fazer › concluído, ADR 0069) entre os tickets que contam
 * abaixo dele: as folhas, mais qualquer ticket bloqueado no caminho. Cancelado e ideia não sobem; só cancelados dá o
 * cinza apagado; sem ticket abaixo, a cor própria do nó fica. Nenhuma cor é misturada.
 *
 * Uma passada de baixo para cima (pós-ordem, sem recursão): cada nó resume o ramo em dois números, a posição mais
 * preocupante e quantos tickets contam. `leafCount` (peso do nó no layout) só muda para quem tem descendente aberto.
 */
export function paintBranches(nodes: readonly MapNode[]): readonly MapNode[] {
  const childrenOf = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const worst = new Map<string, number>();
  const counted = new Map<string, number>();
  const done = new Set<string>();
  const countsAsTicket = (node: MapNode) => node.ticket !== null && !isInIdea(node.ticket);
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
      const id = frame.node.id;
      done.add(id);
      if (children === undefined) continue;
      let rank = NOT_RANKED;
      let total = 0;
      for (const child of children) {
        // Os nós de ideia têm cor própria e não sobem para quem está fora da ideia (ADR 0042).
        if (child.ticket !== null && isInIdea(child.ticket)) continue;
        const childId = child.id;
        const below = counted.get(childId) ?? 0;
        total += below;
        let own = NOT_RANKED;
        if (countsAsTicket(child)) {
          total += 1;
          // Folha: a própria cor. Ticket com filhos: o que vem dos descendentes (e do próprio bloqueio, somado abaixo).
          if (below === 0) own = child.color === CANCELLED_COLOR ? ONLY_CANCELLED : (situationRank(child.color) ?? NOT_RANKED);
        }
        rank = Math.min(rank, own, worst.get(childId) ?? NOT_RANKED);
      }
      // Um ticket bloqueado com filhos também é vermelho, e sobe como tal.
      if (total > 0 && countsAsTicket(frame.node) && effectiveSituation(frame.node.ticket!) === "blocked") rank = 0;
      worst.set(id, rank);
      counted.set(id, total);
    }
  }
  return nodes.map((node) => {
    if (node.ticket !== null && isInIdea(node.ticket)) return node;
    const id = node.id;
    const found = counted.get(id) ?? 0;
    const rank = worst.get(id) ?? NOT_RANKED;
    if (found === 0 || rank === NOT_RANKED) return node;
    const color = rank === ONLY_CANCELLED ? CANCELLED_COLOR : SITUATION_COLORS[PRECEDENCE[rank]!];
    return node.ticket !== null && hasOpenDescendants(node.ticket) ? { ...node, leafCount: found, color } : { ...node, color };
  });
}
