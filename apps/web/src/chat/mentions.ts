import { scanTicketKeys } from "@treepm/domain";
import type { TicketSummary } from "../api/client.js";

export const ticketsByKey = (byProject: Readonly<Record<string, readonly TicketSummary[]>> | null): ReadonlyMap<string, TicketSummary> =>
  new Map(Object.values(byProject ?? {}).flatMap((tickets) => tickets.map((ticket) => [ticket.key, ticket] as const)));

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

/** O texto sem o que não é citação: código (cercado e em linha), endereços e destinos de link; as posições não mudam. */
const withoutNonProse = (text: string): string =>
  text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/https?:\/\/\S+/g, blank)
    .replace(/\]\([^)\s]*\)/g, blank);

/** O que não pode vir antes do `#` para ele valer como citação: `abc#ALFA-1`, `a/b#ALFA-1`, `##ALFA-1` são outra coisa. */
const GLUED = /[\p{L}\p{N}_#/&=?-]/u;

export interface KeyRef {
  key: string;
  /** Onde a chave começa e termina no texto (`end` exclusivo), sem o `#`. */
  start: number;
  end: number;
  /** Tem `#` colado na frente (e fronteira antes dele): é uma citação. */
  hashed: boolean;
}

/** As chaves com cara de ticket no texto, fora de código, endereço e destino de link, com a marca de quais têm `#` (a mesma regra de fronteira para o destino da mensagem e para os elos). */
export function ticketKeyRefs(text: string): KeyRef[] {
  const prose = withoutNonProse(text);
  return scanTicketKeys(prose).map(({ key, start, end }) => ({ key, start, end, hashed: start > 0 && prose[start - 1] === "#" && (start === 1 || !GLUED.test(prose[start - 2]!)) }));
}

/** A parte da chave antes do número: a chave do projeto (`ALFA-12` → `ALFA`). */
const projectOf = (key: string): string => key.slice(0, key.lastIndexOf("-"));

/**
 * O texto tem algo que pede a lista de tickets: `#CHAVE` (ou, com `bare`, a chave sem `#`, como na resposta do assistente) cujo prefixo é a chave
 * de um projeto que a pessoa enxerga. `UTF-8` ou `COVID-19` não pedem nada.
 */
export function wantsTickets(text: string, projectKeys: ReadonlySet<string>, bare = false): boolean {
  return projectKeys.size > 0 && ticketKeyRefs(text).some((ref) => (ref.hashed || bare) && projectKeys.has(projectOf(ref.key)));
}

/** As chaves citadas com `#` no texto cujo prefixo é de um projeto que a pessoa enxerga, sem repetição e na ordem do texto. */
export function hashedKeys(text: string, projectKeys: ReadonlySet<string>): string[] {
  return [...new Set(ticketKeyRefs(text).filter((ref) => ref.hashed && projectKeys.has(projectOf(ref.key))).map((ref) => ref.key))];
}

/** O projeto (pela chave dele) de uma chave de ticket. */
export const projectKeyOf = projectOf;

/** Os tickets citados com `#CHAVE` que a pessoa enxerga (os que estão na lista), sem repetição e na ordem do texto. */
export function citedTickets(text: string, byKey: ReadonlyMap<string, TicketSummary>): TicketSummary[] {
  const found = new Map<string, TicketSummary>();
  for (const { key, hashed } of ticketKeyRefs(text)) {
    const ticket = byKey.get(key);
    if (ticket !== undefined && hashed) found.set(key, ticket);
  }
  return [...found.values()];
}

export type TextPart = string | { ticket: TicketSummary };

/** Parte o texto onde há `#CHAVE` de ticket visível (o `#` entra no elo); com `bare`, a chave sem `#` também (resposta do assistente). */
export function splitTicketRefs(text: string, byKey: ReadonlyMap<string, TicketSummary>, bare = false): TextPart[] {
  if (byKey.size === 0) return [text];
  const parts: TextPart[] = [];
  let last = 0;
  for (const { key, start, end, hashed } of ticketKeyRefs(text)) {
    const ticket = byKey.get(key);
    if (ticket === undefined || (!hashed && !bare)) continue;
    const from = hashed ? start - 1 : start;
    if (from > last) parts.push(text.slice(last, from));
    parts.push({ ticket });
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? [text] : parts;
}
