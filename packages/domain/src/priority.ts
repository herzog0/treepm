/**
 * Prioridade do ticket (ADR 0047): inteiro de -999 a 999, 0 por padrão, número maior primeiro. Funções puras.
 */

export const PRIORITY_MIN = -999;
export const PRIORITY_MAX = 999;

/** O que a prioridade precisa saber de um ticket: quem é, quem é o pai e a prioridade própria. */
export interface PriorityNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly priority: number;
}

/** A prioridade que vale e de qual ticket ela veio; `fromId` é `null` quando a cadeia toda é 0. */
export interface EffectivePriority {
  readonly value: number;
  readonly fromId: string | null;
}

/** Inteiro de -999 a 999. */
export function isValidPriority(value: number): boolean {
  return Number.isInteger(value) && value >= PRIORITY_MIN && value <= PRIORITY_MAX;
}

const NONE: EffectivePriority = { value: 0, fromId: null };

/**
 * A prioridade que vale para cada ticket (ADR 0047): a própria, se diferente de 0; senão a do ancestral mais próximo diferente
 * de 0; senão 0. Uma passada com memória, então serve para o projeto inteiro. Pai que forma ciclo não trava: vale 0.
 */
export function effectivePriorities(tickets: readonly PriorityNode[]): Map<string, EffectivePriority> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const result = new Map<string, EffectivePriority>();
  for (const start of tickets) {
    if (result.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let found: EffectivePriority | null = null;
    for (let cursor: PriorityNode | undefined = start; cursor && found === null; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
      const known = result.get(cursor.id);
      if (known) found = known;
      else if (onPath.has(cursor.id)) found = NONE;
      else if (cursor.priority !== 0) found = { value: cursor.priority, fromId: cursor.id };
      else {
        path.push(cursor.id);
        onPath.add(cursor.id);
      }
    }
    for (const id of path) result.set(id, found ?? NONE);
    if (found !== null && !result.has(start.id)) result.set(start.id, found);
  }
  return result;
}

/** A prioridade que vale para um ticket (ver `effectivePriorities`); ticket desconhecido vale 0. */
export function effectivePriority(tickets: readonly PriorityNode[], id: string): EffectivePriority {
  return effectivePriorities(tickets).get(id) ?? NONE;
}
