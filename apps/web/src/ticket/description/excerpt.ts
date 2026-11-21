/**
 * Tira os sinais de markdown do trecho da descrição na hora de mostrar (ADR 0036). O trecho da API não muda: ele alimenta a
 * procura do caminho. Cobre o subconjunto da ADR; um sinal deixado aberto pelo corte do trecho também sai.
 */
export function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]*)`?/g, "$1")
        .replace(/(\*\*|__)(.*?)(\1|$)/g, "$2")
        .replace(/(?<![\p{L}\p{N}])([*_])(?=\S)(.*?)(?<=\S)\1(?![\p{L}\p{N}])/gu, "$2"),
    )
    .join("\n");
}
