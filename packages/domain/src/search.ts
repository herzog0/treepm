/** O que a busca de tickets lê de cada item: a chave, o número, o título e o trecho da descrição. */
export interface SearchableTicket {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly descriptionExcerpt: string;
}

/** Sem maiúsculas nem acentos: a comparação da busca. */
export const foldForSearch = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Busca de tickets (ADR 0036, compartilhada pela barra da web e pela camada de consulta da API, ADR 0037). O texto vira
 * palavras; o ticket bate quando todas aparecem. Ordem: chave que bate (texto de uma palavra: `TREEPM-47` ou só `47`);
 * título que começa com o texto inteiro; título que contém todas as palavras; todas as palavras somando título e trecho
 * da descrição. Cada ticket aparece uma vez, na melhor regra; dentro de cada regra vale a ordem em que os tickets
 * chegam. Devolve no máximo `limit` itens.
 */
export function searchTickets<T extends SearchableTicket>(text: string, tickets: Iterable<T>, limit: number): T[] {
  const words = foldForSearch(text).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0 || limit <= 0) return [];
  const needle = words.join(" ");
  const single = words.length === 1;
  const numeric = single && /^\d+$/.test(needle) ? Number(needle) : null;
  const tiers: T[][] = [[], [], [], []];
  for (const ticket of tickets) {
    const title = foldForSearch(ticket.title);
    const tier =
      single && (foldForSearch(ticket.key) === needle || (numeric !== null && ticket.number === numeric))
        ? 0
        : title.startsWith(needle)
          ? 1
          : words.every((word) => title.includes(word))
            ? 2
            : (() => {
                const both = `${title} ${foldForSearch(ticket.descriptionExcerpt)}`;
                return words.every((word) => both.includes(word));
              })()
              ? 3
              : -1;
    if (tier >= 0) tiers[tier]!.push(ticket);
  }
  return tiers.flat().slice(0, limit);
}
