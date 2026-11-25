import { describe, expect, it } from "vitest";
import { personLink, scanPersonLinks } from "@treepm/domain";
import { cleanMentions, countFitting, fitPage, shrinkItem, truncateClean } from "../src/mcp/mcp-text.js";

// Revisão de segurança da fatia 3 do MCP (TREEPM-495): o limpador de menções roda em todo texto que sai pelas leituras de pessoas. A
// expressão antiga de elo com destino `person:` (`\[(?:[^\]\\]|\\.)*\]\(\s*person:…`) recomeçava a varredura em cada `[` e o laço de troca
// refazia o texto inteiro a cada elo: custo quadrático no tamanho do texto. Aqui: tempo linear medido, e o algoritmo antigo guardado só
// como oráculo, comparado em textos aleatórios.

const UNNAMED = "Unnamed person";
const ID = "6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10";
const names = new Map([[ID, "Bia Nome"]]);
const nameOf = (id: string): string | undefined => names.get(id);

/** O limpador antigo, como estava em `mcp-people-read.ts` (oráculo; quadrático). */
function oldClean(text: string): string {
  let current = text;
  for (let round = 0; round < 20; round += 1) {
    const links = scanPersonLinks(current);
    if (links.length === 0) break;
    for (const link of links.reverse()) current = `${current.slice(0, link.start)}@${nameOf(link.id.toLowerCase()) ?? UNNAMED}${current.slice(link.end)}`;
  }
  const raw = /\]\(\s*person:/i.test(current) || /\]:\s*<?\s*person:/i.test(current) || /href\s*=\s*["']?\s*person:/i.test(current) || /<\s*person:/i.test(current);
  if (raw) current = current.replace(/\[(?:[^\]\\]|\\.)*\]\(\s*person:[^)]*\)?/gi, `@${UNNAMED}`).replace(/person:\s*[^\s)>\]"'`]*/gi, `@${UNNAMED}`);
  return current;
}

const fill = (size: number, unit: string, prefix = "", suffix = ""): string => `${prefix}${unit.repeat(Math.ceil((size - prefix.length - suffix.length) / unit.length))}`.slice(0, size - suffix.length) + suffix;
const LINK = personLink(ID, "x@y.test");

/** Textos hostis: cada um maximiza uma alternância ou quantificador adjacente das expressões do limpador e de `mentionsPersonRaw`. */
const HOSTILE: Record<string, (size: number) => string> = {
  "[a](person:x) + [ repetido": (n) => fill(n, "[", "[a](person:x)"),
  "[a](person:x) + ]: + espaços + x": (n) => fill(n, " ", "[a](person:x)]:", "x"),
  "[a](person:x) + href= + espaços + x": (n) => fill(n, " ", "[a](person:x)href=", "x"),
  "[ repetido + ]( + espaços + x": (n) => fill(n, "[", "", "](" + " ".repeat(50) + "x"),
  "[ repetido e barras": (n) => fill(n, "[\\[", "[a](person:x)"),
  "[@ repetido": (n) => fill(n, "[@", "[a](person:x)"),
  "[@a\\ repetido": (n) => fill(n, "[@a\\", "[a](person:x)"),
  "person: + espaços repetido": (n) => fill(n, "person:   ", "[a](person:x)"),
  "]( + espaços repetido": (n) => fill(n, "](   ", "[a](person:x)"),
  "elos de pessoa válidos colados": (n) => fill(n, LINK),
  // Só unidades inteiras (o resto é espaço): um elo cortado no meio é texto comum, nem o limpador antigo o reconhecia.
  "elos de pessoa aninhados": (n) => {
    const unit = `[@\\[@B\\]\\(person:${ID}\\)](person:${ID}) `;
    return unit.repeat(Math.floor(n / unit.length)).padEnd(n, " ");
  },
  "texto comum": (n) => fill(n, "Um texto comum com palavras e pontuação. "),
};

function timeOf(work: () => unknown, reps: number): number {
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

describe("cleanMentions em tempo linear", () => {
  it.each(Object.entries(HOSTILE))("%s: 10.000 e 100.000 caracteres em menos de 50 ms, crescendo menos de 20 vezes", (_name, make) => {
    const small = make(10_000);
    const big = make(100_000);
    const tSmall = timeOf(() => cleanMentions(small, nameOf), 10);
    const tBig = timeOf(() => cleanMentions(big, nameOf), 1);
    expect(tSmall).toBeLessThan(50);
    expect(tBig).toBeLessThan(50);
    expect(tBig / Math.max(tSmall, 0.02)).toBeLessThan(20);
    // E nada de uuid nem de destino `person:` sobra.
    for (const out of [cleanMentions(small, nameOf), cleanMentions(big, nameOf)]) {
      expect(out).not.toContain(ID);
      expect(out).not.toMatch(/person:/i);
    }
  });
});

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe("cleanMentions dá o mesmo resultado que o limpador antigo", () => {
  const ALPHABET = ["[", "]", "(", ")", "[@", "](", "]:", ":", "\\", "\n", "\r", " ", " ", "<", '"', "'", "`", "=", ">", "person:", "PERSON:", `person:${ID}`, ID, "href", "a", "@", "x@y.test", LINK];
  it("em 30.000 textos curtos aleatórios", () => {
    const next = random(4950);
    const diffs: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      const size = 1 + Math.floor(next() * 12);
      const text = Array.from({ length: size }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
      if (cleanMentions(text, nameOf) !== oldClean(text)) diffs.push(text);
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });
  it("nos textos hostis (curtos, para o antigo terminar)", () => {
    for (const make of Object.values(HOSTILE)) for (const size of [60, 700]) expect(cleanMentions(make(size), nameOf)).toBe(oldClean(make(size)));
  });
  it("casos conhecidos", () => {
    for (const text of [`](person:[a](person:y)`, `[@Bia](person:${ID.toUpperCase()}) e [x](person:z`, `[a\\\n](person:x)`, `[a\\](person:x)`, `[[a](person:x)`, `<a href = ' person:${ID}'>`]) {
      expect(cleanMentions(text, nameOf), text).toBe(oldClean(text));
    }
  });
});

describe("truncateClean: o corte vem depois da limpeza", () => {
  it("um corte que cairia dentro de um elo não deixa o e-mail guardado no elo nem o uuid", () => {
    const text = `${"a".repeat(30)} ${LINK} fim`;
    for (let max = 1; max < text.length; max += 1) {
      const out = truncateClean(cleanMentions(text, nameOf), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toContain("x@y.test");
      expect(out).not.toContain(ID);
      expect(out).not.toMatch(/person:/i);
    }
  });
  it("não parte um par substituto e marca o corte com reticências", () => {
    const out = truncateClean(cleanMentions(`${"a".repeat(9)}😀😀`, nameOf), 11);
    expect(out).toBe(`${"a".repeat(9)}…`);
    expect(truncateClean(cleanMentions("curto", nameOf), 10)).toBe("curto");
  });
});

describe("fitPage: corta pelo texto cru e limpa só o que vai sair", () => {
  it("50 itens de 10.000 caracteres: só os que cabem passam pela limpeza", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, body: "x".repeat(10_000) }));
    let cleaned = 0;
    const page = await fitPage(rows, 79_000, (row) => row, async (some) => {
      cleaned += some.length;
      return some.map((row) => ({ i: row.i, body: cleanMentions(row.body, nameOf) }));
    });
    expect(page.kept.length).toBe(7);
    expect(cleaned).toBe(7);
    expect(page.cut).toBe(true);
    expect(JSON.stringify(page.kept.map((item) => item.out)).length).toBeLessThanOrEqual(79_000);
  });
  it("a limpeza que aumenta o texto corta de novo; um item sozinho grande demais sai cortado e marcado", async () => {
    const grows = Array.from({ length: 3 }, () => "<person:>".repeat(5_000));
    const page = await fitPage(grows, 79_000, (row) => row, async (some) => some.map((row) => ({ body: cleanMentions(row, nameOf) })));
    expect(page.kept.length).toBe(1);
    expect(page.kept[0]?.out).toMatchObject({ truncated: true });
    expect(JSON.stringify(page.kept.map((item) => item.out)).length).toBeLessThanOrEqual(79_000);
  });
  it("countFitting sempre deixa um; shrinkItem corta a maior cadeia ou a maior lista", () => {
    expect(countFitting([], 10)).toBe(0);
    expect(countFitting(["x".repeat(100)], 10)).toBe(1);
    const shrunk = shrinkItem({ id: "a", title: cleanMentions("t".repeat(5_000), nameOf), people: Array.from({ length: 2_000 }, (_, i) => ({ id: String(i), name: "Nome" })) }, 1_000);
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(1_000);
    expect(shrunk).toMatchObject({ id: "a", truncated: true });
  });
});
