/**
 * Diz se acrescentar "`from` depende de `to`" fecha um ciclo (ADR 0037). `edges` são os pares [de, para] que já existem ("de"
 * depende de "para"). É ciclo quando `from === to`, quando `to` já depende de `from` direta ou indiretamente.
 */
export function createsDependencyCycle(edges: readonly (readonly [from: string, to: string])[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const target of next.get(current) ?? []) {
      if (target === from) return true;
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return false;
}
