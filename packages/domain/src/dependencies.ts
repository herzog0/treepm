/**
 * Diz se acrescentar "`from` depende de `to`" fecha um ciclo (ADR 0037). `edges` são os pares [de, para] que já existem ("de"
 * depende de "para"). É ciclo quando `from === to`, quando `to` já depende de `from` direta ou indiretamente.
 */
export function createsDependencyCycle(edges: readonly (readonly [from: string, to: string])[], from: string, to: string): boolean {
  return new DependencyGraph(edges).wouldCycle(from, to);
}

/**
 * O grafo de "depende de" montado UMA vez e atualizado a cada ligação aceita (a importação do Linear confere centenas de ligações por
 * página contra dezenas de milhares já existentes; refazer o mapa a cada uma custava segundos). A regra do ciclo é a de
 * `createsDependencyCycle`, que delega para cá.
 */
export class DependencyGraph {
  private readonly next = new Map<string, Set<string>>();

  constructor(edges: Iterable<readonly [from: string, to: string]> = []) {
    for (const [from, to] of edges) this.add(from, to);
  }

  add(from: string, to: string): void {
    const targets = this.next.get(from) ?? new Set<string>();
    targets.add(to);
    this.next.set(from, targets);
  }

  /** Acrescentar "`from` depende de `to`" fecha um ciclo? (`from === to`, ou `to` já depende de `from` direta ou indiretamente.) */
  wouldCycle(from: string, to: string): boolean {
    if (from === to) return true;
    const seen = new Set<string>([to]);
    const stack = [to];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const target of this.next.get(current) ?? []) {
        if (target === from) return true;
        if (!seen.has(target)) {
          seen.add(target);
          stack.push(target);
        }
      }
    }
    return false;
  }
}
