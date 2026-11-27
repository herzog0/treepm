import type { DependencyEdge } from "./queue-place.js";
import { dependencySteps } from "./sibling-order.js";
import type { OrderNode } from "./sibling-order.js";
import { ideaRootsOf } from "./tickets.js";

/** Um card da árvore explodida (ADR 0070): a coluna (o passo), a linha, o ticket em que ele pendura e se é um alvo de fora (apagado). */
export interface ExplodedNode {
  readonly id: string;
  /** O passo da ADR 0069, a contar do menor passo que aparece (coluna 0, à esquerda). */
  readonly column: number;
  /** A linha; pode ser o meio de duas (um ticket fica na altura do meio dos que penduram nele). */
  readonly row: number;
  /** O ticket em que ele pendura: o de maior passo de que ele depende para começar (no empate, o de menor número); `null` na raiz. */
  readonly hangOn: string | null;
  /** Alvo de uma dependência que aponta para fora do que aparece: card apagado, sem as dependências próprias. */
  readonly outside: boolean;
}

export interface ExplodedTree {
  readonly nodes: readonly ExplodedNode[];
  /** Quantas colunas e quantas linhas a grade ocupa. */
  readonly columns: number;
  readonly rows: number;
}

/**
 * A árvore explodida de um foco (ADR 0070). Entram os tickets sem filhos (sem filho que não seja ideia) dentro do foco (`null`: o
 * projeto inteiro), fora ideias, em qualquer situação. Cada um fica na coluna do seu passo (ADR 0069, contado no projeto inteiro) e pendura
 * no ticket de que depende para começar que tem o maior passo (no empate, o menor número); quem não depende de ninguém é raiz. As folhas
 * dessa árvore ocupam linhas seguidas, e cada ticket fica na altura do meio dos que penduram nele. Irmãos e raízes vão por coluna e número.
 *
 * O alvo de uma dependência (de qualquer tipo) que está fora do que aparece vira um card apagado na coluna do passo dele, sem as
 * dependências próprias: um ticket fora do foco, ou um ticket com filhos dentro dele. Quem depende dele para começar pode pendurar nele.
 */
export function explodedTree(tickets: readonly OrderNode[], dependencies: readonly DependencyEdge[], focusId: string | null): ExplodedTree {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const hasChildren = new Set<string>();
  for (const ticket of tickets) if (ticket.parentId !== null && (ticket.ideaStage ?? null) === null) hasChildren.add(ticket.parentId);
  const inIdea = ideaRootsOf(tickets);
  const insideFocus = (id: string): boolean => {
    if (focusId === null) return true;
    const seen = new Set<string>();
    for (let up = byId.get(id)?.parentId ?? null; up !== null && !seen.has(up); up = byId.get(up)?.parentId ?? null) {
      if (up === focusId) return true;
      seen.add(up);
    }
    return false;
  };
  const included = new Set(tickets.filter((ticket) => !hasChildren.has(ticket.id) && !inIdea.has(ticket.id) && insideFocus(ticket.id)).map((ticket) => ticket.id));
  if (included.size === 0) return { nodes: [], columns: 0, rows: 0 };

  const outside = new Set<string>();
  for (const edge of dependencies) {
    if (included.has(edge.from) && !included.has(edge.to) && byId.has(edge.to) && !inIdea.has(edge.to)) outside.add(edge.to);
  }
  const steps = dependencySteps(tickets, dependencies);
  const step = (id: string) => steps.get(id) ?? 0;
  const number = (id: string) => byId.get(id)?.number ?? 0;
  const shown = [...included, ...outside];

  const hangOn = new Map<string, string | null>();
  for (const id of shown) hangOn.set(id, null);
  for (const edge of dependencies) {
    if (edge.need !== "start" || !included.has(edge.from) || !hangOn.has(edge.to) || step(edge.to) >= step(edge.from)) continue;
    const current = hangOn.get(edge.from) ?? null;
    if (current === null || step(edge.to) > step(current) || (step(edge.to) === step(current) && number(edge.to) < number(current))) hangOn.set(edge.from, edge.to);
  }

  const byColumnAndNumber = (a: string, b: string) => step(a) - step(b) || number(a) - number(b);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of shown) {
    const parent = hangOn.get(id) ?? null;
    if (parent === null) roots.push(id);
    else {
      const list = children.get(parent);
      if (list) list.push(id);
      else children.set(parent, [id]);
    }
  }
  roots.sort(byColumnAndNumber);
  for (const list of children.values()) list.sort(byColumnAndNumber);

  // As folhas da árvore em linhas seguidas; cada ticket no meio do primeiro e do último que penduram nele. Sem recursão: um caminho pode ter
  // centenas de passos.
  const rows = new Map<string, number>();
  let nextRow = 0;
  const stack: { id: string; at: number }[] = [...roots].reverse().map((id) => ({ id, at: 0 }));
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const below = children.get(frame.id) ?? [];
    if (frame.at < below.length) {
      stack.push({ id: below[frame.at]!, at: 0 });
      frame.at += 1;
      continue;
    }
    stack.pop();
    rows.set(frame.id, below.length === 0 ? nextRow++ : (rows.get(below[0]!)! + rows.get(below[below.length - 1]!)!) / 2);
  }

  const first = Math.min(...shown.map(step));
  const nodes = shown.map((id) => ({ id, column: step(id) - first, row: rows.get(id)!, hangOn: hangOn.get(id) ?? null, outside: outside.has(id) }));
  return { nodes, columns: Math.max(...nodes.map((node) => node.column)) + 1, rows: nextRow };
}
