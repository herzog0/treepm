import { scanTicketKeys } from "@treepm/domain";
import type { TicketSummary } from "../api/client.js";

/** O que abriu o seletor: `@` (pessoa) ou `#` (ticket), e onde o `@` ou o `#` está no texto. */
export interface Trigger {
  char: "@" | "#";
  start: number;
}
export interface LiveTrigger extends Trigger {
  /** O que se digitou depois do `@` ou do `#`, até o cursor: é o que filtra. */
  query: string;
  /** Onde o trecho termina (exclusivo): com o cursor no meio dele (`@bi|a`), confirmar troca o trecho inteiro. */
  end: number;
}
/** O que estava selecionado no campo antes de a pessoa digitar. */
export interface Selection {
  start: number;
  end: number;
}

/**
 * Só um `@` ou `#` digitado (nunca colado) no começo ou depois de espaço abre o seletor. Digitado sobre uma seleção, ele a substitui e
 * também abre: `selection` é o que estava selecionado antes da mudança.
 */
export function typedTrigger(previous: string, next: string, caret: number, selection?: Selection): Trigger | null {
  const at = caret - 1;
  if (at < 0) return null;
  const bases = selection !== undefined && selection.end > selection.start ? [previous, previous.slice(0, selection.start) + previous.slice(selection.end)] : [previous];
  if (!bases.some((base) => next.length === base.length + 1 && next.slice(0, at) + next.slice(at + 1) === base)) return null;
  const char = next[at];
  if (char !== "@" && char !== "#") return null;
  if (at > 0 && !/\s/.test(next[at - 1]!)) return null;
  return { char, start: at };
}

/** O gatilho continua valendo enquanto o cursor está dentro do trecho `@…`/`#…` sem espaço nem outro gatilho. */
export function liveTrigger(trigger: Trigger | null, text: string, caret: number): LiveTrigger | null {
  if (trigger === null || text[trigger.start] !== trigger.char || caret <= trigger.start) return null;
  const query = text.slice(trigger.start + 1, caret);
  if (/[\s@#]/.test(query)) return null;
  // Recém digitado (`@` e nada depois) é só o `@`, mesmo diante de uma palavra; com algo já escrito, o trecho é a palavra inteira.
  let end = caret;
  while (query !== "" && end < text.length && !/[\s@#]/.test(text[end]!)) end += 1;
  return { ...trigger, query, end };
}

/** O texto sem o trecho do gatilho (`@bia`, inteiro); o espaço que sobraria em dobro some. Devolve também onde o cursor fica. */
export function withoutToken(text: string, trigger: LiveTrigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  let after = text.slice(trigger.end);
  if ((before === "" || /\s$/.test(before)) && after.startsWith(" ")) after = after.slice(1);
  return { text: before + after, caret: before.length };
}

/** O trecho do gatilho (inteiro) trocado pela chave com `#` na frente e um espaço (`#TREEPM-88 `). */
export function withTicketKey(text: string, trigger: LiveTrigger, key: string): { text: string; caret: number } {
  const before = `${text.slice(0, trigger.start)}#${key} `;
  const after = text.slice(trigger.end).replace(/^ /, "");
  return { text: before + after, caret: before.length };
}

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

/** Tira o `#` que antecede uma chave de ticket visível (a pastilha já diz a chave); o das outras fica, e o código e os destinos de link não mudam. */
export function withoutHashOfTickets(text: string, byKey: ReadonlyMap<string, TicketSummary>): string {
  let result = text;
  for (const { key, start, hashed } of ticketKeyRefs(text).reverse()) {
    if (hashed && byKey.has(key)) result = result.slice(0, start - 1) + result.slice(start);
  }
  return result;
}
