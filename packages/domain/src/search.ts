/** O que a busca de tickets lê de cada item: a chave, o número, o título e o trecho da descrição. */
export interface SearchableTicket {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly descriptionExcerpt: string;
  /** As chaves que o ticket tem ou teve no provedor externo (ADR 0061): batem como a chave, para uma palavra só. */
  readonly externalKeys?: readonly string[];
}

/** Sem maiúsculas nem acentos: a comparação da busca. */
export const foldForSearch = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Texto normalizado de cada ticket, guardado por identidade do objeto: a barra busca a cada tecla sobre a mesma lista, e
 * normalizar (NFD + regex) título, chave e trecho de 20 000 tickets custava ~100 ms por tecla. Cada entrada guarda o texto
 * de origem que normalizou e só vale enquanto o ticket ainda o tem (um objeto editado no lugar é normalizado de novo).
 * Os campos são normalizados só quando a regra precisa deles, como antes.
 */
interface Folded {
  keySource: string;
  key: string | undefined;
  titleSource: string;
  title: string;
  excerptSource: string;
  excerpt: string | undefined;
}
const foldedTickets = new WeakMap<object, Folded>();
function foldedOf(ticket: SearchableTicket): Folded {
  let folded = foldedTickets.get(ticket);
  if (folded === undefined) {
    folded = { keySource: ticket.key, key: undefined, titleSource: ticket.title, title: foldForSearch(ticket.title), excerptSource: ticket.descriptionExcerpt, excerpt: undefined };
    foldedTickets.set(ticket, folded);
    return folded;
  }
  if (folded.keySource !== ticket.key) {
    folded.keySource = ticket.key;
    folded.key = undefined;
  }
  if (folded.titleSource !== ticket.title) {
    folded.titleSource = ticket.title;
    folded.title = foldForSearch(ticket.title);
  }
  if (folded.excerptSource !== ticket.descriptionExcerpt) {
    folded.excerptSource = ticket.descriptionExcerpt;
    folded.excerpt = undefined;
  }
  return folded;
}

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
    const folded = foldedOf(ticket);
    const title = folded.title;
    const tier =
      single && ((folded.key ??= foldForSearch(ticket.key)) === needle || (numeric !== null && ticket.number === numeric) || (ticket.externalKeys !== undefined && ticket.externalKeys.some((external) => foldForSearch(external) === needle)))
        ? 0
        : title.startsWith(needle)
          ? 1
          : words.every((word) => title.includes(word))
            ? 2
            : (() => {
                const both = `${title} ${(folded.excerpt ??= foldForSearch(ticket.descriptionExcerpt))}`;
                return words.every((word) => both.includes(word));
              })()
              ? 3
              : -1;
    if (tier >= 0) tiers[tier]!.push(ticket);
  }
  return tiers.flat().slice(0, limit);
}
