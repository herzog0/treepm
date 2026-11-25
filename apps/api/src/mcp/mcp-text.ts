import { mentionsPersonRaw, scanPersonLinks } from "@treepm/domain";
import { UNNAMED_PERSON } from "./person-name.js";

/**
 * Texto que passou pelo limpador de menções (ou o corte dele): o único tipo de texto livre que as leituras de pessoas do MCP entregam
 * (ADR 0062, fatia 3; revisão de segurança, TREEPM-495). Só `cleanMentions` e `truncateClean` o produzem; um campo de texto da saída
 * tipado como `CleanText` não aceita texto cru.
 */
export type CleanText = string & { readonly __clean: unique symbol };

/** O que encerra uma linha para o `.` de uma expressão regular sem a marca `s`. */
const LINE_END = new Set(["\n", "\r", " ", " "]);
/** A cauda de um elo com destino `person:`, a partir do `]`: `(`, espaços, `person:`, até o `)` (que pode faltar). */
const PERSON_TAIL = /\(\s*person:[^)]*\)?/iy;
const BARE_PERSON = /person:\s*[^\s)>\]"'`]*/gi;

/** Uma rodada de troca dos elos de pessoa (`[@Nome](person:id)`) por `@Nome`, montada por pedaços; `null` quando não há elo. */
function replacePersonLinks(text: string, nameOf: (id: string) => string | undefined): string | null {
  const links = scanPersonLinks(text);
  if (links.length === 0) return null;
  const parts: string[] = [];
  let at = 0;
  for (const link of links) {
    parts.push(text.slice(at, link.start), `@${nameOf(link.id.toLowerCase()) ?? UNNAMED_PERSON}`);
    at = link.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/**
 * Faz o mesmo que `text.replace(/\[(?:[^\]\\]|\\.)*\]\(\s*person:[^)]*\)?/gi, replacement)`, em uma passada. A expressão recomeçava a
 * varredura do texto do elo em cada `[` (o `[` vale dentro dele), o que dava custo quadrático. Mas a varredura que começa num `[` passa
 * pelo `[` seguinte sempre numa fronteira de item (sozinho ou como par `\[`) e termina no mesmo lugar que a dele: o `]` não escapado, uma
 * barra antes de fim de linha ou o fim do texto. Então todos os `[` até esse ponto casam ou falham juntos, e basta olhar cada trecho uma
 * vez. Um teste compara com a expressão em milhares de textos.
 */
function replaceBracketPersonTargets(text: string, replacement: string): string {
  const parts: string[] = [];
  let from = 0;
  let index = 0;
  for (;;) {
    const open = text.indexOf("[", index);
    if (open < 0) break;
    let end = open + 1;
    while (end < text.length) {
      const char = text[end];
      if (char === "]") break;
      if (char === "\\") {
        if (end + 1 < text.length && !LINE_END.has(text[end + 1] as string)) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    if (text[end] === "]") {
      PERSON_TAIL.lastIndex = end + 1;
      const tail = PERSON_TAIL.exec(text);
      if (tail) {
        parts.push(text.slice(from, open), replacement);
        from = end + 1 + tail[0].length;
        index = from;
        continue;
      }
    }
    index = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * Tira o elo de pessoa de um texto: `[@Nome](person:<uuid>)` vira `@Nome`, com o nome dado por `nameOf` (pelo id em minúsculas; quem
 * chama resolve pela função de todo nome do MCP, porque o nome guardado no elo pode ser o e-mail). Pessoa sem nome em `nameOf`, id mal
 * formado e qualquer outra forma de destino `person:` viram `@Unnamed person`; o uuid nunca sai. Menção de ticket fica como a chave.
 * Tempo linear no tamanho do texto (revisão de segurança, TREEPM-495): até 20 rodadas (elo dentro do nome de outro), cada uma de uma passada.
 */
export function cleanMentions(text: string, nameOf: (id: string) => string | undefined): CleanText {
  let current = text;
  for (let round = 0; round < 20; round += 1) {
    const next = replacePersonLinks(current, nameOf);
    if (next === null) break;
    current = next;
  }
  if (mentionsPersonRaw(current)) current = replaceBracketPersonTargets(current, `@${UNNAMED_PERSON}`).replace(BARE_PERSON, `@${UNNAMED_PERSON}`);
  return current as CleanText;
}

/** Corta um texto já limpo em até `max` caracteres, terminando em `…` quando corta, sem partir um par substituto. */
export function truncateClean(text: CleanText, max: number): CleanText {
  if (text.length <= max) return text;
  if (max < 1) return "" as CleanText;
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…` as CleanText;
}

// ---- o teto de tamanho de uma resposta ------------------------------------------------------------------------------

const sizeOf = (value: unknown): number => JSON.stringify(value).length;

/** Quantos dos primeiros valores cabem num arreio JSON de até `budget` caracteres; sempre ao menos um (quando há algum). */
export function countFitting(values: readonly unknown[], budget: number): number {
  let total = 2;
  for (const [index, value] of values.entries()) {
    total += sizeOf(value) + (index > 0 ? 1 : 0);
    if (total > budget && index > 0) return index;
  }
  return values.length;
}

/** Um valor JSON qualquer, para percorrer o item a cortar. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Corta um ÚNICO item que sozinho passa de `max` caracteres em JSON, e o marca com `truncated: true`: encurta a maior cadeia (que já
 * passou pelo limpador, ou é de formato fechado e curta) terminando em `…`, ou tira do fim a maior lista (os participantes), até caber.
 * Recebe o item já limpo: cortar o texto cru poderia partir um elo de pessoa e deixar o nome guardado nele sem a cauda que o limpador reconhece.
 */
export function shrinkItem<T extends object>(item: T, max: number): T & { truncated?: true } {
  const copy = JSON.parse(JSON.stringify(item)) as { [key: string]: Json };
  copy["truncated"] = true;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const excess = sizeOf(copy) - max;
    if (excess <= 0) break;
    let best: { holder: { [key: string]: Json } | Json[]; key: string | number; weight: number } | null = null;
    const visit = (holder: { [key: string]: Json } | Json[]): void => {
      for (const [key, value] of Object.entries(holder)) {
        if (typeof value === "string" || Array.isArray(value)) {
          const weight = sizeOf(value);
          if (weight > 2 && (best === null || weight > best.weight)) best = { holder, key: Array.isArray(holder) ? Number(key) : key, weight };
        }
        if (value !== null && typeof value === "object") visit(value);
      }
    };
    visit(copy);
    const target = best as { holder: { [key: string]: Json } | Json[]; key: string | number; weight: number } | null;
    if (target === null) break;
    const value = (target.holder as Record<string | number, Json>)[target.key];
    if (typeof value === "string") (target.holder as Record<string | number, Json>)[target.key] = truncateClean(value as CleanText, Math.max(0, value.length - excess - 1));
    else if (Array.isArray(value)) value.splice(Math.max(0, value.length - Math.max(1, Math.ceil((excess / target.weight) * value.length))));
  }
  return copy as unknown as T & { truncated?: true };
}

/**
 * Uma página que cabe em `budget` caracteres: corta pelo tamanho do texto CRU (barato), monta e limpa só os itens que sobraram (`build`),
 * corta de novo pelo tamanho limpo (a limpeza pode aumentar o texto: `<person:>` vira `<@Unnamed person>`) e, se um único item ainda não
 * couber, corta o item com a marca de corte. `cut` diz se algum item ficou de fora.
 */
export async function fitPage<R, O extends object>(rows: readonly R[], budget: number, raw: (row: R) => unknown, build: (rows: readonly R[]) => Promise<O[]>): Promise<{ kept: { row: R; out: O }[]; cut: boolean }> {
  if (rows.length === 0) return { kept: [], cut: false };
  const rawCount = countFitting(rows.map(raw), budget);
  const outs = await build(rows.slice(0, rawCount));
  const count = countFitting(outs, budget);
  const kept = outs.slice(0, count).map((out, index) => ({ row: rows[index] as R, out }));
  const only = kept[0];
  if (kept.length === 1 && only && sizeOf([only.out]) > budget) only.out = shrinkItem(only.out, budget - 2);
  return { kept, cut: count < rows.length };
}
