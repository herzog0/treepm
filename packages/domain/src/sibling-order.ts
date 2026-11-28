import { effectivePriorities } from "./priority.js";
import { isFinished } from "./tickets.js";
import type { DependencyEdge } from "./queue-place.js";
import type { TicketNode } from "./tickets.js";

/** O que a ordem dos irmãos precisa saber de um ticket (ADR 0069, seção 2). */
export interface OrderNode extends TicketNode {
  readonly number: number;
  /** Prioridade PRÓPRIA (ADR 0047); a ordem usa a efetiva, que sobe pelos ancestrais. */
  readonly priority: number;
}

/** Os filhos de cada ticket que contam para o passo: os que não são ideia (a mesma conta da situação do pai, ADR 0068). */
function childrenOf(tickets: readonly TicketNode[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const ticket of tickets) {
    if (ticket.parentId === null || (ticket.ideaStage ?? null) !== null) continue;
    const list = children.get(ticket.parentId);
    if (list) list.push(ticket.id);
    else children.set(ticket.parentId, [ticket.id]);
  }
  return children;
}

/**
 * O passo de cada ticket (ADR 0069, seção 2): 0 quando ele não depende de ninguém para começar; nos outros casos, 1 mais o maior passo
 * dos tickets de que ele depende para começar. O passo de um ticket com filhos é o menor passo dentro dele (as dependências próprias
 * dele não contam). Toda dependência "para começar" conta, mesmo com o alvo concluído: a ordem muda quando uma dependência muda, não
 * quando um ticket termina. "Para entregar" não conta. Um alvo fora da lista é ignorado; um ciclo (que a API recusa) vale 0 no ponto
 * em que fecha, para a conta sempre terminar.
 */
export function dependencySteps(tickets: readonly TicketNode[], dependencies: readonly DependencyEdge[]): Map<string, number> {
  const known = new Set(tickets.map((ticket) => ticket.id));
  const children = childrenOf(tickets);
  const targets = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (edge.need !== "start" || !known.has(edge.from) || !known.has(edge.to)) continue;
    const list = targets.get(edge.from);
    if (list) list.push(edge.to);
    else targets.set(edge.from, [edge.to]);
  }
  const steps = new Map<string, number>();
  const visiting = new Set<string>();
  const stepOf = (id: string): number => {
    const done = steps.get(id);
    if (done !== undefined) return done;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inside = children.get(id);
    let step: number;
    if (inside !== undefined) step = Math.min(...inside.map(stepOf));
    else {
      const own = targets.get(id) ?? [];
      step = own.length === 0 ? 0 : 1 + Math.max(...own.map(stepOf));
    }
    visiting.delete(id);
    steps.set(id, step);
    return step;
  };
  for (const ticket of tickets) stepOf(ticket.id);
  return steps;
}

/**
 * Os tickets na ordem dos irmãos (ADR 0069, seção 2): dentro de cada pai, por passo (do menor para o maior); no empate, prioridade
 * efetiva (maior primeiro, ADR 0047), depois número. Devolve os mesmos objetos numa lista nova: a ordem relativa de cada grupo de irmãos é a
 * ordem de entrada que o motor do mapa usa, e o motor continua genérico.
 */
export function inSiblingOrder<T extends OrderNode>(tickets: readonly T[], dependencies: readonly DependencyEdge[]): T[] {
  const steps = dependencySteps(tickets, dependencies);
  const priorities = effectivePriorities(tickets);
  const step = (ticket: T) => steps.get(ticket.id) ?? 0;
  const priority = (ticket: T) => priorities.get(ticket.id)?.value ?? 0;
  return [...tickets].sort((a, b) => step(a) - step(b) || priority(b) - priority(a) || a.number - b.number);
}

/**
 * Os habilitadores (ADR 0069, seção 2): o filho de que algum irmão depende para começar e que não depende de nenhum irmão para começar.
 * Ele ganha a marca "abre os irmãos". Quem espera pode ser o irmão ou algo DENTRO dele (as secções de uma página esperam a casca); o
 * habilitador é o próprio alvo da dependência: um pai não vira habilitador porque um irmão espera algo dentro dele. "Não depende de
 * nenhum irmão" olha também o que está dentro dele. Vale também entre os tickets do topo do projeto. Só tickets abertos levam a marca:
 * concluído ou cancelado, ele já abriu os irmãos. "Para entregar" não conta, como no passo: pela ordem, o habilitador aparece primeiro.
 */
export function enablers(tickets: readonly TicketNode[], dependencies: readonly DependencyEdge[]): Set<string> {
  const parentOf = new Map(tickets.map((ticket) => [ticket.id, ticket.parentId] as const));
  const statusOf = new Map(tickets.map((ticket) => [ticket.id, ticket.status] as const));
  const chain = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let cursor: string | null | undefined = id; cursor !== null && cursor !== undefined && !seen.has(cursor); cursor = parentOf.get(cursor)) {
      seen.add(cursor);
      path.unshift(cursor);
    }
    return path;
  };
  const waits = new Set<string>();
  const opens = new Set<string>();
  for (const edge of dependencies) {
    if (edge.need !== "start" || !parentOf.has(edge.from) || !parentOf.has(edge.to)) continue;
    const from = chain(edge.from);
    const to = chain(edge.to);
    let at = 0;
    while (at < from.length && at < to.length && from[at] === to[at]) at += 1;
    const fromSibling = from[at];
    const toSibling = to[at];
    if (fromSibling === undefined || toSibling === undefined) continue; // um é ancestral do outro: não são irmãos
    waits.add(fromSibling);
    if (toSibling === edge.to) opens.add(toSibling);
  }
  return new Set([...opens].filter((id) => !waits.has(id) && !isFinished(statusOf.get(id)!)));
}
