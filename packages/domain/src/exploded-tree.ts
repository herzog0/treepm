import type { DependencyEdge, DependencyNeed, QueuePlace } from "./queue-place.js";
import type { OrderNode } from "./sibling-order.js";
import { ideaRootsOf, isFinished } from "./tickets.js";

/** Um card da árvore explodida (ADR 0070, com o brief da revisão do dono): a coluna, a linha, o ticket em que pendura e o lugar na fila. */
export interface ExplodedNode {
  readonly id: string;
  /** O passo no grafo dos nós, a contar do menor passo que aparece (coluna 0, à esquerda). */
  readonly column: number;
  /** A linha; pode ser o meio de duas (um ticket fica na altura do meio dos que penduram nele). */
  readonly row: number;
  /** O nó em que ele pendura: o de maior passo de que ele depende para começar (no empate, o de menor número); `null` na raiz. */
  readonly hangOn: string | null;
  /** Alvo de uma dependência que aponta para fora do foco: card apagado, sem as dependências próprias. */
  readonly outside: boolean;
  /** Quantos tickets estão dobrados dentro do nó (todos os descendentes que não são ideia); 0 num ticket sem filhos. */
  readonly inside: number;
  /** O lugar na fila do nó no grafo dos nós: livre, próximo ou esperando; `null` para concluído ou cancelado. */
  readonly place: QueuePlace | null;
}

export interface ExplodedTree {
  readonly nodes: readonly ExplodedNode[];
  /** Quantas colunas e quantas linhas a grade ocupa. */
  readonly columns: number;
  readonly rows: number;
}

/**
 * A árvore explodida de um foco (`null`: o projeto inteiro).
 *
 * Quem é nó: descendo do foco, um ticket é nó quando não tem filhos (fora ideias) ou quando entra em alguma dependência (como quem depende
 * ou como alvo). Os descendentes de um nó ficam dobrados nele (`inside` conta quantos) e não são desenhados; as dependências deles sobem
 * para o nó. Um ticket com filhos e sem dependência é só uma caixa: não é desenhado, e a descida entra nele. Motivo: no Linear as
 * dependências ficam na história, e a história tem sub-issues; desenhar as sub-issues no lugar da história perde todas as setas.
 *
 * O passo e o lugar na fila são os do grafo dos nós (a regra da ADR 0069 e da ADR 0068, aplicada aos nós). Cada nó fica na coluna do
 * seu passo e pendura no nó de que depende para começar que tem o maior passo (no empate, o menor número). As folhas dessa árvore ocupam
 * linhas seguidas, e cada nó fica no meio dos que penduram nele; irmãos e raízes vão por coluna e número. O alvo de uma dependência (de
 * qualquer tipo) que está fora do foco aparece apagado, no nó dele no projeto, sem as dependências próprias.
 */
export function explodedTree(tickets: readonly OrderNode[], dependencies: readonly DependencyEdge[], focusId: string | null): ExplodedTree {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const inIdea = ideaRootsOf(tickets);
  const children = new Map<string | null, string[]>();
  for (const ticket of tickets) {
    if (inIdea.has(ticket.id)) continue;
    const list = children.get(ticket.parentId);
    if (list) list.push(ticket.id);
    else children.set(ticket.parentId, [ticket.id]);
  }
  const usable = (edge: DependencyEdge) => byId.has(edge.from) && byId.has(edge.to) && !inIdea.has(edge.from) && !inIdea.has(edge.to);
  const linked = new Set<string>();
  for (const edge of dependencies) if (usable(edge)) linked.add(edge.from).add(edge.to);

  /** Desce de `from`: cada ticket vai para o seu nó; `inside` conta os dobrados em cada nó. */
  const walk = (from: readonly string[]) => {
    const nodeOf = new Map<string, string>();
    const inside = new Map<string, number>();
    const pending = [...from];
    while (pending.length > 0) {
      const id = pending.pop()!;
      const below = children.get(id) ?? [];
      if (below.length > 0 && !linked.has(id)) {
        pending.push(...below);
        continue;
      }
      nodeOf.set(id, id);
      let count = 0;
      const folded = [...below];
      while (folded.length > 0) {
        const inner = folded.pop()!;
        nodeOf.set(inner, id);
        count += 1;
        folded.push(...(children.get(inner) ?? []));
      }
      inside.set(id, count);
    }
    return { nodeOf, inside };
  };
  const project = walk(children.get(null) ?? []);
  const focus = focusId === null ? project : walk(children.get(focusId) ?? []);
  if (focus.inside.size === 0) return { nodes: [], columns: 0, rows: 0 };

  const containsFocus = (id: string): boolean => {
    if (focusId === null) return false;
    const seen = new Set<string>();
    for (let at: string | null = focusId; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
      if (at === id) return true;
      seen.add(at);
    }
    return false;
  };
  const lift = (id: string): string | null => {
    const inside = focus.nodeOf.get(id);
    if (inside !== undefined) return inside;
    const outside = project.nodeOf.get(id);
    return outside === undefined || containsFocus(outside) ? null : outside;
  };

  // As dependências entre nós: uma por par; "para começar" vence quando o par aparece com os dois tipos.
  const edges = new Map<string, { from: string; to: string; need: DependencyNeed }>();
  for (const edge of dependencies) {
    if (!usable(edge)) continue;
    const from = lift(edge.from);
    const to = lift(edge.to);
    if (from === null || to === null || from === to) continue;
    const key = `${from}>${to}`;
    const known = edges.get(key);
    if (!known || edge.need === "start") edges.set(key, { from, to, need: known?.need === "start" ? "start" : edge.need });
  }
  const startTargets = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (edge.need !== "start") continue;
    const list = startTargets.get(edge.from);
    if (list) list.push(edge.to);
    else startTargets.set(edge.from, [edge.to]);
  }

  const steps = new Map<string, number>();
  const visiting = new Set<string>();
  const step = (id: string): number => {
    const known = steps.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const targets = startTargets.get(id) ?? [];
    const value = targets.length === 0 ? 0 : 1 + Math.max(...targets.map(step));
    visiting.delete(id);
    steps.set(id, value);
    return value;
  };
  const open = (id: string) => !isFinished(byId.get(id)?.status ?? "todo");
  const openTargets = (id: string) => (startTargets.get(id) ?? []).filter(open);
  const isFree = (id: string) => open(id) && openTargets(id).length === 0;
  const placeOf = (id: string): QueuePlace | null => {
    if (!open(id)) return null;
    const waiting = openTargets(id);
    return waiting.length === 0 ? "free" : waiting.every(isFree) ? "next" : "waiting";
  };

  const insideIds = [...focus.inside.keys()];
  const insideSet = new Set(insideIds);
  const outside = new Set<string>();
  for (const edge of edges.values()) if (insideSet.has(edge.from) && !insideSet.has(edge.to)) outside.add(edge.to);
  const shown = [...insideIds, ...outside];
  const number = (id: string) => byId.get(id)?.number ?? 0;

  const hangOn = new Map<string, string | null>();
  for (const id of shown) hangOn.set(id, null);
  for (const edge of edges.values()) {
    if (edge.need !== "start" || !insideSet.has(edge.from) || !hangOn.has(edge.to) || step(edge.to) >= step(edge.from)) continue;
    const current = hangOn.get(edge.from) ?? null;
    if (current === null || step(edge.to) > step(current) || (step(edge.to) === step(current) && number(edge.to) < number(current))) hangOn.set(edge.from, edge.to);
  }

  const byColumnAndNumber = (a: string, b: string) => step(a) - step(b) || number(a) - number(b);
  const hanging = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of shown) {
    const parent = hangOn.get(id) ?? null;
    if (parent === null) roots.push(id);
    else {
      const list = hanging.get(parent);
      if (list) list.push(id);
      else hanging.set(parent, [id]);
    }
  }
  roots.sort(byColumnAndNumber);
  for (const list of hanging.values()) list.sort(byColumnAndNumber);

  // As folhas da árvore em linhas seguidas; cada nó no meio do primeiro e do último que penduram nele. Sem recursão: um caminho pode
  // ter centenas de passos.
  const rows = new Map<string, number>();
  let nextRow = 0;
  const stack: { id: string; at: number }[] = [...roots].reverse().map((id) => ({ id, at: 0 }));
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const below = hanging.get(frame.id) ?? [];
    if (frame.at < below.length) {
      stack.push({ id: below[frame.at]!, at: 0 });
      frame.at += 1;
      continue;
    }
    stack.pop();
    rows.set(frame.id, below.length === 0 ? nextRow++ : (rows.get(below[0]!)! + rows.get(below[below.length - 1]!)!) / 2);
  }

  const first = Math.min(...shown.map(step));
  const insideCount = (id: string) => focus.inside.get(id) ?? project.inside.get(id) ?? 0;
  const nodes = shown.map((id) => ({
    id,
    column: step(id) - first,
    row: rows.get(id)!,
    hangOn: hangOn.get(id) ?? null,
    outside: outside.has(id),
    inside: insideCount(id),
    place: placeOf(id),
  }));
  return { nodes, columns: Math.max(...nodes.map((node) => node.column)) + 1, rows: nextRow };
}
