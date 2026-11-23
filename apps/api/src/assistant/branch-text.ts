/**
 * O texto que a procura mostra de um candidato, montado na hora da procura (ADR 0052, item 1). Lógica pura: recebe a
 * árvore do projeto como ela está e as notas escritas por pessoa; nada fica guardado, então mover, criar ou remover
 * ticket muda o texto dos ramos envolvidos na procura seguinte, sem escrita nenhuma.
 *
 * Forma do texto de um ticket com filhos:
 *
 *   <trecho da descrição dele (o corte de `descriptionExcerpt`)>
 *   Nota: <nota escrita por pessoa, se houver>
 *   Contém: <títulos dos filhos diretos>
 *   Dentro deles: <títulos dos netos>        (só se couber)
 *   Mais abaixo: <títulos dos bisnetos em diante, num bloco só> (só se couber)
 *   … e mais N                               (só quando algum descendente ficou de fora)
 */
import { descriptionExcerpt } from "@treepm/domain";

/**
 * Teto, em caracteres, do texto INTEIRO de um candidato, na prioridade trecho curto da descrição → nota da pessoa →
 * filhos diretos → níveis de baixo: cada parte só usa o que sobrou das anteriores e o que passa é cortado, com "…" quando
 * a nota é cortada e "… e mais N" quando descendentes ficam de fora. O texto de cada candidato vai duas vezes na
 * requisição ao Jev (`candidate_groups` e as opções do `choice`) e o orçamento de 28 mil tokens estimados
 * (`JEV_TOKEN_BUDGET`) dá cerca de 70 mil caracteres: com 1.100 por candidato cabem uns 30 candidatos de texto cheio por
 * nível. Quando um nível maior não cabe, o serviço encolhe a parte dos descendentes de todos os candidatos na mesma
 * proporção (`descendantsScale`) antes de desistir, e `judgeInputFits` continua a guarda de última instância.
 */
export const BRANCH_TEXT_MAX_CHARS = 1100;

/** Teto da parte dos descendentes quando sobra espaço (os blocos "Contém", "Dentro deles", "Mais abaixo" e o "… e mais N"). */
export const BRANCH_DESCENDANTS_MAX_CHARS = 600;

export type BranchNode = {
  id: string;
  parentId: string | null;
  number: number;
  title: string;
  description: string;
  /** `cancelled` não entra no texto (nem o que está dentro dele). */
  status: string;
};

/** `descendantsScale` (0 a 1, 1 por padrão) encolhe só a parte dos descendentes; trecho e nota não mudam. */
export type BranchTexts = { textOf(id: string, descendantsScale?: number): string };

/** Árvore indexada uma vez por procura: uma leitura, nenhuma consulta por candidato. */
export function branchTexts(tickets: readonly BranchNode[], notes: ReadonlyMap<string, string>): BranchTexts {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenOf = new Map<string, BranchNode[]>();
  for (const ticket of [...tickets].sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : 1))) {
    if (ticket.status === "cancelled" || ticket.parentId === null || !byId.has(ticket.parentId)) continue;
    const list = childrenOf.get(ticket.parentId) ?? [];
    list.push(ticket);
    childrenOf.set(ticket.parentId, list);
  }

  // Quantos descendentes vivos tem cada ticket (uma passada, sem recursão: a árvore pode ser funda).
  const sizes = new Map<string, number>();
  const order: BranchNode[] = [];
  const stack = tickets.filter((ticket) => ticket.parentId === null || !byId.has(ticket.parentId));
  while (stack.length > 0) {
    const next = stack.pop() as BranchNode;
    order.push(next);
    stack.push(...(childrenOf.get(next.id) ?? []));
  }
  for (const ticket of order.reverse()) {
    sizes.set(ticket.id, (childrenOf.get(ticket.id) ?? []).reduce((total, child) => total + 1 + (sizes.get(child.id) ?? 0), 0));
  }

  const cache = new Map<string, string>();
  const build = (id: string, scale: number): string => {
    const ticket = byId.get(id);
    if (!ticket) return "";
    const parts: string[] = [];
    let left = BRANCH_TEXT_MAX_CHARS;
    const excerpt = descriptionExcerpt(ticket.description);
    if (excerpt !== "") {
      const kept = excerpt.slice(0, left);
      parts.push(kept);
      left -= kept.length + 1;
    }
    const note = notes.get(id)?.trim() ?? "";
    if (note !== "" && left > "Nota: …".length) {
      const line = `Nota: ${note}`;
      const kept = line.length <= left ? line : `${line.slice(0, left - 1).trimEnd()}…`;
      parts.push(kept);
      left -= kept.length + 1;
    }
    const total = sizes.get(id) ?? 0;
    const budget = Math.floor(Math.min(BRANCH_DESCENDANTS_MAX_CHARS, Math.max(left, 0)) * Math.min(Math.max(scale, 0), 1));
    if (total > 0) parts.push(...descendantLines(id, total, budget));
    return parts.join("\n");
  };

  /**
   * Nível por nível dentro do orçamento: "Contém" (filhos), "Dentro deles" (netos) e "Mais abaixo" (do terceiro nível em
   * diante, num bloco só). A ordem dentro do nível é a dos filhos (número do ticket), então o texto é determinístico.
   * Sem orçamento, só a contagem ("… e mais N").
   */
  const descendantLines = (id: string, total: number, budget: number): string[] => {
    const blocks: { header: string; titles: string[] }[] = [];
    let used = 0;
    let shown = 0;
    let level = childrenOf.get(id) ?? [];
    let depth = 1;
    let full = budget > 0;
    while (level.length > 0 && full) {
      const header = depth === 1 ? "Contém: " : depth === 2 ? "Dentro deles: " : "Mais abaixo: ";
      let block = blocks[blocks.length - 1];
      const continuing = depth > 3 && block !== undefined;
      if (!continuing) {
        block = { header, titles: [] };
        blocks.push(block);
      }
      const current = block as { header: string; titles: string[] };
      let cost = continuing ? 0 : header.length + 1;
      for (const entry of level) {
        const extra = entry.title.length + (current.titles.length > 0 || continuing ? 2 : 0);
        if (used + cost + extra > budget) {
          full = false;
          break;
        }
        current.titles.push(entry.title);
        cost += extra;
        shown += 1;
      }
      used += cost;
      level = level.flatMap((entry) => childrenOf.get(entry.id) ?? []);
      depth += 1;
    }
    const lines = blocks.filter((block) => block.titles.length > 0).map((block) => `${block.header}${block.titles.join("; ")}`);
    if (shown < total) lines.push(`… e mais ${total - shown}`);
    return lines;
  };

  return {
    textOf(id, descendantsScale = 1) {
      const key = `${descendantsScale}:${id}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const built = build(id, descendantsScale);
      cache.set(key, built);
      return built;
    },
  };
}
