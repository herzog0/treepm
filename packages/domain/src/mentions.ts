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
  const text = withoutUnderscoreEmphasis(withoutLinkAddresses(withoutInlineCode(withoutFencedBlocks(markdown))));
  return [...new Set(scanTicketKeys(text).map((match) => match.key))];
}
