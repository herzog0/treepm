import type { TicketSummary } from "../api/client.js";

/** Máximo de tickets na folha da barra (ADR 0036). */
export const MAX_RESULTS = 8;

/** Sem maiúsculas nem acentos: a comparação da busca. */
export const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Busca da barra (ADR 0036): sobre os tickets já carregados. O texto vira palavras; o ticket bate quando todas aparecem.
 * Ordem: chave que bate (texto de uma palavra: `TREEPM-47` ou só `47`); título que começa com o texto inteiro; título que
 * contém todas as palavras; todas as palavras somando título e trecho da descrição. Cada ticket aparece uma vez, na melhor
 * regra; dentro de cada regra vale a ordem em que os tickets chegam.
 */
export function searchTickets(text: string, ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>): TicketSummary[] {
  const words = fold(text).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  const needle = words.join(" ");
  const single = words.length === 1;
  const numeric = single && /^\d+$/.test(needle) ? Number(needle) : null;
  const tiers: TicketSummary[][] = [[], [], [], []];
  for (const list of Object.values(ticketsByProject)) {
    for (const ticket of list) {
      const title = fold(ticket.title);
      const tier =
        single && (fold(ticket.key) === needle || (numeric !== null && ticket.number === numeric))
          ? 0
          : title.startsWith(needle)
            ? 1
            : words.every((word) => title.includes(word))
              ? 2
              : (() => {
                  const both = `${title} ${fold(ticket.descriptionExcerpt)}`;
                  return words.every((word) => both.includes(word));
                })()
                ? 3
                : -1;
      if (tier >= 0) tiers[tier]!.push(ticket);
    }
  }
  return tiers.flat().slice(0, MAX_RESULTS);
}
