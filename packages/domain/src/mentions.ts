export interface TicketKeyMatch {
  readonly key: string;
  /** Posição no texto onde a chave começa e termina (`end` exclusivo). */
  readonly start: number;
  readonly end: number;
}

/** Chave de ticket solta no texto: letras maiúsculas e números, hífen e número. Não vale no meio de palavra. */
const KEY = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]*-\d+(?![\p{L}\p{N}_-])/gu;

/**
 * As chaves de ticket soltas em um texto, com a posição de cada ocorrência, na ordem em que aparecem (ADR 0037). É a única
 * definição de "chave": a web e a API usam esta. Não sabe quais tickets existem; quem chama filtra pelo projeto.
 */
export function scanTicketKeys(text: string): TicketKeyMatch[] {
  return Array.from(text.matchAll(KEY), (match) => ({ key: match[0], start: match.index, end: match.index + match[0].length }));
}

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

/** Abertura ou fecho de bloco de código cercado: até a margem de uma citação ou de um item de lista, e três ou mais ` ou ~. */
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})/;

/** Troca por espaços o que está em bloco de código cercado, linha a linha, sem mudar posições. */
function withoutFencedBlocks(markdown: string): string {
  let open: { char: string; size: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = FENCE.exec(line)?.[1];
      if (open === null) {
        if (fence === undefined) return line;
        // Um cerco de crases não abre se a linha tem mais crases depois (seria código em linha).
        const char = fence[0] ?? "`";
        if (char === "`" && line.slice(FENCE.exec(line)?.[0].length).includes("`")) return line;
        open = { char, size: fence.length };
        return blank(line);
      }
      if (fence !== undefined && fence[0] === open.char && fence.length >= open.size && line.replace(FENCE, "").trim() === "") open = null;
      return blank(line);
    })
    .join("\n");
}

/** Troca por espaços o código em linha: uma sequência de crases abre e fecha na mesma sequência, dentro do mesmo parágrafo. */
const INLINE_CODE = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g;
const withoutInlineCode = (text: string): string => text.replace(INLINE_CODE, blank);

/**
 * O endereço (e o título) de um link `[texto](endereço "título")` não é texto da descrição. Imagem não entra: o editor a mantém
 * como o próprio texto `![…](…)` (ADR 0036), então o que há nela é texto.
 */
const LINK = /(?<!!)(\[(?:[^[\]\\\n]|\\.)*\]\()([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?)\)/g;
const withoutLinkAddresses = (text: string): string => text.replace(LINK, (_all, open: string, address: string, title: string) => `${open}${blank(address)}${blank(title)})`);

/**
 * Sublinhado que abre e fecha ênfase (`_texto_`, `__texto__`) não é texto: o editor mostra só o texto de dentro. Sublinhado no
 * meio de palavra (`x_y_z`) não é ênfase e fica, e a chave colada nele continua não valendo.
 */
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}_])(_{1,2})(?=[^\s_])([^\n]*?[^\s_])\1(?![\p{L}\p{N}_])/gu;
const withoutUnderscoreEmphasis = (text: string): string => text.replace(UNDERSCORE_EMPHASIS, (_all, marks: string, inner: string) => `${blank(marks)}${inner}${blank(marks)}`);

/**
 * As chaves mencionadas em uma descrição em markdown (ADR 0037): sem repetição, na ordem em que aparecem. Não conta o que está
 * em bloco de código cercado, em código em linha nem no endereço de um link; conta título, lista, tarefa, citação, negrito,
 * itálico e texto de link. Não sabe quais tickets existem; quem chama filtra pelo projeto.
 */
export function mentionedKeys(markdown: string): string[] {
  return [...new Set(scanTicketKeys(proseOf(markdown)).map((match) => match.key))];
}

/** O texto sem o que não é texto da descrição (código, endereço de link, ênfase por sublinhado); as posições não mudam. */
const proseOf = (markdown: string): string => withoutUnderscoreEmphasis(withoutLinkAddresses(withoutInlineCode(withoutFencedBlocks(markdown))));

/** O que não pode vir antes do `#` para ele valer como parte da menção: `abc#ALFA-1`, `a/#ALFA-1`, `##ALFA-1` são outra coisa. */
const GLUED = /[\p{L}\p{N}_#/&=?-]/u;

export interface TicketRef extends TicketKeyMatch {
  /** Tem `#` colado na frente (e fronteira antes dele): é a menção como ela é guardada. `start` já inclui o `#`. */
  readonly hashed: boolean;
}

/**
 * As chaves de ticket de um texto em markdown, com e sem `#` (ADR 0058): `#CHAVE` é a menção guardada; a chave solta dos textos
 * antigos também vale. Mesma regra de código e de endereço de link de `mentionedKeys`; `start` inclui o `#`, quando há.
 */
export function scanTicketRefs(markdown: string): TicketRef[] {
  const prose = proseOf(markdown);
  return scanTicketKeys(prose).map(({ key, start, end }) => {
    const hashed = start > 0 && prose[start - 1] === "#" && (start === 1 || !GLUED.test(prose[start - 2] as string));
    return { key, start: hashed ? start - 1 : start, end, hashed };
  });
}

/** Põe `#` na frente das chaves soltas de tickets que existem (`exists`): a leitura dos textos antigos, que ao salvar saem com `#`. */
export function hashTicketKeys(markdown: string, exists: (key: string) => boolean): string {
  let result = markdown;
  // A fronteira se olha no texto sem as marcas de ênfase (`_TREEPM-8_` é itálico, a chave está solta), como a leitura da menção faz.
  const prose = proseOf(markdown);
  for (const ref of scanTicketRefs(markdown).reverse()) {
    // Só chave solta: `/`, `=`, `a#` e afins na frente fazem dela parte de um endereço ou de outra coisa.
    const glued = ref.start > 0 && GLUED.test(prose[ref.start - 1] as string);
    if (!ref.hashed && !glued && exists(ref.key)) result = `${result.slice(0, ref.start)}#${result.slice(ref.start)}`;
  }
  return result;
}

export interface PersonLink {
  readonly id: string;
  /** O nome guardado, sem o `@` e sem os escapes. */
  readonly name: string;
  /** Onde o elo começa e termina no texto (`end` exclusivo). */
  readonly start: number;
  readonly end: number;
}

const PERSON_LINK = /\[@((?:[^[\]\\\n]|\\.)*)\]\(person:([A-Za-z0-9_-]+)\)/gi;

/** O elo de pessoa como é guardado: `[@Nome](person:id)`. Colchetes, parênteses e barra invertida do nome são escapados; quebra de linha vira espaço. */
export function personLink(id: string, name: string): string {
  const safe = name.replace(/\s+/g, " ").trim().replace(/`/g, "'").replace(/[\\[\]()]/g, "\\$&");
  return `[@${safe}](person:${id})`;
}

/**
 * Os elos de pessoa de um texto de mensagem, na ordem. A varredura é crua: mensagem é texto, não markdown, então crases e blocos de
 * código não escondem um elo (é o que o servidor confere contra as pessoas marcadas, e a web faz igual).
 */
export function scanPersonLinks(text: string): PersonLink[] {
  return Array.from(text.matchAll(PERSON_LINK), (match) => ({
    id: match[2] as string,
    name: (text.slice(match.index + 2, match.index + 2 + (match[1] as string).length)).replace(/\\(.)/g, "$1"),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Os ids de pessoa que o texto cita, sem repetição e na ordem em que aparecem. */
export const personIdsIn = (text: string): string[] => [...new Set(scanPersonLinks(text).map((link) => link.id))];

export const hasPersonLink = (text: string): boolean => scanPersonLinks(text).length > 0;

/**
 * O teste estrito que recusa nome de pessoa em formato de menção (nome + id) onde o texto vai a um provedor de IA ou às leituras do
 * MCP. Olha o texto cru, sem exceção para código, citação ou lista, sem diferenciar maiúsculas e tolerando espaços: qualquer destino
 * `person:` (em link, em referência, em `href` ou em autolink) conta. Recusar a mais é aceitável; deixar passar não. É outro teste que
 * o da tela, que decide o que desenhar.
 */
export const mentionsPersonRaw = (text: string): boolean => /\]\(\s*person:/i.test(text) || /\]:\s*<?\s*person:/i.test(text) || /href\s*=\s*["']?\s*person:/i.test(text) || /<\s*person:/i.test(text);

/** Os ids que um texto cru cita em destinos `](person:…)`, mesmo mal formados (id vazio entra como ""): a base do `mention_mismatch`. */
export function rawPersonRefIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\]\(\s*person:\s*([^)\s]*)/gi), (match) => match[1] as string))];
}

/** Troca cada elo de pessoa (ou só os das pessoas em `only`) pelo `@Nome` simples. */
export function withoutPersonLinks(text: string, only?: ReadonlySet<string>): string {
  let result = text;
  for (const link of scanPersonLinks(text).reverse()) {
    if (only === undefined || only.has(link.id)) result = `${result.slice(0, link.start)}@${link.name}${result.slice(link.end)}`;
  }
  return result;
}

/** Como `withoutPersonLinks` para todos os elos, repetido até estabilizar: um elo dentro do nome de outro (`[@\[@Bob\]\(person:id\)](person:x)`) não sobra. */
export function withoutPersonLinksDeep(text: string): string {
  let current = text;
  for (let round = 0; round < 20; round += 1) {
    const next = withoutPersonLinks(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}
