import { describe, expect, it } from "vitest";
import { mentionsPersonRaw, personLink, scanPersonLinks, withoutPersonLinks } from "./mentions.js";

// Revisão de segurança da fatia 3 do MCP (TREEPM-495): `mentionsPersonRaw` roda em todo texto que entra (descrição, título, mensagem) e
// em todo texto que sai pelo MCP. Quantificadores adjacentes sobre a mesma classe (`\s*<?\s*`, `\s*["']?\s*`) davam custo quadrático no
// tamanho do texto. O teste mede o tempo em textos hostis de 10.000 e 100.000 caracteres e confere, contra as expressões antigas guardadas
// aqui só como oráculo, que nada mudou no que a função reconhece.

const OLD = (text: string): boolean => /\]\(\s*person:/i.test(text) || /\]:\s*<?\s*person:/i.test(text) || /href\s*=\s*["']?\s*person:/i.test(text) || /<\s*person:/i.test(text);

/** Repete `unit` até o tamanho dado, com `prefix` e `suffix`. */
const fill = (size: number, unit: string, prefix = "", suffix = ""): string => `${prefix}${unit.repeat(Math.ceil((size - prefix.length - suffix.length) / unit.length))}`.slice(0, size - suffix.length) + suffix;

/** Os textos hostis: cada um maximiza uma alternância ou um quantificador adjacente sobre a mesma classe de caracteres. */
const HOSTILE: Record<string, (size: number) => string> = {
  "]: + espaços + x": (n) => fill(n, " ", "]:", "x"),
  "]: + espaços + < + espaços + x": (n) => fill(n, " ", "]:", "<" + " ".repeat(10) + "x"),
  "]: + < + espaços": (n) => fill(n, " ", "]:<", "x"),
  "]: repetido com espaços": (n) => fill(n, "]: "),
  "href= + espaços + x": (n) => fill(n, " ", "href=", "x"),
  "href + espaços + = + espaços": (n) => fill(n, " ", "href", "= x"),
  "href= + aspas + espaços": (n) => fill(n, " ", 'href="', "x"),
  "href= repetido": (n) => fill(n, "href= "),
  "](  + espaços + x": (n) => fill(n, " ", "](", "x"),
  "< + espaços + x": (n) => fill(n, " ", "<", "x"),
  "< repetido com espaços": (n) => fill(n, "< "),
  "[ repetido": (n) => fill(n, "["),
  "[a](person:x) + [ repetido": (n) => fill(n, "[", "[a](person:x)"),
  "tabs e quebras de linha": (n) => fill(n, "\t\n ", "]:", "x"),
  "texto comum": (n) => fill(n, "Um texto comum com palavras e pontuação. "),
};

/** O menor tempo (ms) de várias execuções, cada uma repetindo a chamada `reps` vezes; aquece antes. */
function timeOf(work: () => unknown, reps: number): number {
  // Uma chamada lenta já reprova: não repete (o caso quadrático levaria minutos).
  const first = performance.now();
  work();
  const once = performance.now() - first;
  if (once > 200) return once;
  work();
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    for (let i = 0; i < reps; i += 1) work();
    best = Math.min(best, (performance.now() - start) / reps);
  }
  return best;
}

describe("mentionsPersonRaw em tempo linear", () => {
  it.each(Object.entries(HOSTILE))("%s: 10.000 e 100.000 caracteres em menos de 50 ms, crescendo menos de 20 vezes", (_name, make) => {
    const small = make(10_000);
    const big = make(100_000);
    expect(small.length).toBe(10_000);
    expect(big.length).toBe(100_000);
    const tSmall = timeOf(() => mentionsPersonRaw(small), 20);
    const tBig = timeOf(() => mentionsPersonRaw(big), 2);
    expect(tSmall).toBeLessThan(50);
    expect(tBig).toBeLessThan(50);
    // Piso de 0,01 ms: abaixo disso a razão é só ruído do relógio.
    expect(tBig / Math.max(tSmall, 0.01)).toBeLessThan(20);
  });
});

/** Gerador pseudoaleatório fixo: a mesma sequência em toda execução. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe("mentionsPersonRaw reconhece o mesmo que as expressões antigas", () => {
  const ALPHABET = ["[", "]", "(", ")", ":", "\\", "\n", " ", "\t", "<", '"', "'", "=", "person:", "PERSON:", "href", "HREF", "a", "@", " "];
  it("em 20.000 textos curtos aleatórios sobre um alfabeto pequeno", () => {
    const next = random(495);
    const diffs: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const size = 1 + Math.floor(next() * 14);
      const text = Array.from({ length: size }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
      if (mentionsPersonRaw(text) !== OLD(text)) diffs.push(text);
    }
    expect(diffs).toEqual([]);
  });
  it("nos textos hostis", () => {
    for (const make of Object.values(HOSTILE)) for (const size of [50, 500]) expect(mentionsPersonRaw(make(size))).toBe(OLD(make(size)));
  });
});

// `scanPersonLinks` roda no limpador de menções do MCP e na tela (mensagens). O texto do elo aceita `\[` escapado, então a varredura que
// começava em cada `[@` ia até o fim em `[@a\[@a\[…`: custo quadrático. Mesmo teste de tempo e o mesmo oráculo (a expressão antiga).
const OLD_LINK = /\[@((?:[^[\]\\\n]|\\.)*)\]\(person:([A-Za-z0-9_-]+)\)/gi;
const oldScan = (text: string) =>
  Array.from(text.matchAll(OLD_LINK), (match) => ({
    id: match[2] as string,
    name: text.slice(match.index + 2, match.index + 2 + (match[1] as string).length).replace(/\\(.)/g, "$1"),
    start: match.index,
    end: match.index + match[0].length,
  }));
const ID = "6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10";
const LINK_HOSTILE: Record<string, (size: number) => string> = {
  "[@a\\ repetido": (n) => fill(n, "[@a\\"),
  "[@ + \\[ repetido": (n) => fill(n, "\\[", "[@"),
  "[@ + \\[@ repetido + ](person:": (n) => fill(n, "\\[@", "[@", "](person:"),
  "elos válidos colados": (n) => fill(n, personLink(ID, "Bia")),
  "[@ repetido": (n) => fill(n, "[@"),
  "texto comum": (n) => fill(n, "Um texto comum com palavras e pontuação. "),
};

describe("scanPersonLinks e withoutPersonLinks em tempo linear", () => {
  it.each(Object.entries(LINK_HOSTILE))("%s: 10.000 e 100.000 caracteres em menos de 50 ms, crescendo menos de 20 vezes", (_name, make) => {
    const small = make(10_000);
    const big = make(100_000);
    for (const work of [scanPersonLinks, withoutPersonLinks]) {
      const tSmall = timeOf(() => work(small), 10);
      const tBig = timeOf(() => work(big), 1);
      expect(tSmall).toBeLessThan(50);
      expect(tBig).toBeLessThan(50);
      expect(tBig / Math.max(tSmall, 0.02)).toBeLessThan(20);
    }
  });
});

describe("scanPersonLinks reconhece o mesmo que a expressão antiga", () => {
  const ALPHABET = ["[", "[@", "]", "](", "(", ")", "@", "\\", "\n", "\r", "\u2028", " ", "a", "person:", "PERSON:", ID, "-", "_", "](person:", personLink(ID, "B[i]a")];
  it("em 30.000 textos curtos aleatórios", () => {
    const next = random(4951);
    const diffs: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      const size = 1 + Math.floor(next() * 12);
      const text = Array.from({ length: size }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
      if (JSON.stringify(scanPersonLinks(text)) !== JSON.stringify(oldScan(text))) diffs.push(text);
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });
  it("nos textos hostis", () => {
    for (const make of Object.values(LINK_HOSTILE)) for (const size of [60, 700]) expect(scanPersonLinks(make(size))).toEqual(oldScan(make(size)));
  });
});
