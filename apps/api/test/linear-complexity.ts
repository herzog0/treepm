// Pontos de complexidade de uma consulta do Linear, para os testes do cliente (extraído de `linear-client-sync.test.ts`).
/**
 * Pontos de complexidade pela regra documentada do Linear: campo escalar 0,1; objeto 1; conexão multiplica o que está dentro de
 * `nodes` pelo tamanho da página. Conservador: cada campo com chaves vale 1 mais o que tem dentro (`nodes` conta como o objeto do item).
 */
export function points(query: string, variables: Record<string, number>): number {
  // Tira o cabeçalho (`query Nome($a: T)`) e fica só a seleção da raiz, sem as chaves de fora.
  const start = query.indexOf("{");
  const text = query.slice(start + 1, query.lastIndexOf("}"));
  let index = 0;
  const skipSpaces = (): void => {
    while (index < text.length && /[\s,]/.test(text[index] as string)) index += 1;
  };
  /** O custo dos campos do nível, e o de `nodes` à parte (só ele é multiplicado pelo tamanho da página). */
  const selection = (): { others: number; nodes: number } => {
    let others = 0;
    let nodes = 0;
    for (;;) {
      skipSpaces();
      if (index >= text.length) return { others, nodes };
      if (text[index] === "}") {
        index += 1;
        return { others, nodes };
      }
      const name = /^[A-Za-z_]\w*/.exec(text.slice(index))?.[0];
      if (name === undefined) throw new Error(`consulta fora do formato perto de: ${text.slice(index, index + 20)}`);
      index += name.length;
      skipSpaces();
      let args = "";
      if (text[index] === "(") {
        const end = text.indexOf(")", index);
        args = text.slice(index + 1, end);
        index = end + 1;
        skipSpaces();
      }
      if (text[index] === "{") {
        index += 1;
        const inner = selection();
        const first = /first:\s*(\$?\w+)/.exec(args)?.[1];
        const size = first === undefined ? 1 : first.startsWith("$") ? (variables[first.slice(1)] as number) : Number(first);
        const cost = 1 + inner.others + size * inner.nodes;
        if (name === "nodes") nodes += cost;
        else others += cost;
      } else others += 0.1;
    }
  };
  const root = selection();
  return Math.round((root.others + root.nodes) * 10) / 10;
}
