// Cores das etiquetas (ADR 0065, seção 2): tokens no theme.css batendo com o domínio, e o texto da pastilha legível (AA) sobre o
// fundo misturado, nos dois temas. A mistura é calculada com a porcentagem lida do próprio CSS, a mesma que a tela pinta.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LABEL_COLORS, LABEL_HEX } from "@treepm/domain";
import { describe, expect, it } from "vitest";

const theme = readFileSync(resolve(import.meta.dirname, "../theme.css"), "utf8");
const css = readFileSync(resolve(import.meta.dirname, "labels.css"), "utf8");

/** O corpo do primeiro bloco com este seletor. */
const block = (selector: string): string => {
  const at = theme.indexOf(`${selector} {`);
  expect(at, `bloco ${selector}`).toBeGreaterThanOrEqual(0);
  return theme.slice(at, theme.indexOf("}", at));
};
const DARK = block(":root");
const LIGHT = block(':root[data-theme="light"]');

/** O valor de um token num bloco, seguindo `var(--x)` até um hexadecimal do :root. */
function value(body: string, name: string): string {
  const raw = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
  expect(raw, `${name}`).toBeDefined();
  const ref = /^var\((--[\w-]+)\)$/.exec(raw as string);
  return ref ? value(DARK, ref[1] as string) : (raw as string).toLowerCase();
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `color-mix(in srgb, cor p, base)`: média dos valores codificados, como o navegador faz em srgb. */
const mix = (color: [number, number, number], base: [number, number, number], p: number) => color.map((c, i) => Math.round(c * p + (base[i] as number) * (1 - p))) as [number, number, number];

describe("cores das etiquetas", () => {
  it("os tokens do tema escuro são os do domínio (LABEL_HEX)", () => {
    for (const color of LABEL_COLORS) expect(value(DARK, `--tp-label-${color}`)).toBe(LABEL_HEX[color]);
  });

  it("o tema claro tem as oito cores, diferentes das do escuro", () => {
    for (const color of LABEL_COLORS) expect(value(LIGHT, `--tp-label-${color}`)).not.toBe(LABEL_HEX[color]);
  });

  it("a pastilha mistura a cor ao fundo pelo token de porcentagem e escreve com o token de texto", () => {
    expect(css).toMatch(/color-mix\(in srgb, var\(--label-color\) var\(--tp-label-mix\), var\(--tp-label-surface\)\)/);
    expect(css).toMatch(/color: var\(--tp-label-ink\)/);
  });

  for (const [name, body] of [["escuro", DARK], ["claro", LIGHT]] as const) {
    it(`texto da pastilha com contraste AA (>= 4.5) sobre o fundo misturado, tema ${name}`, () => {
      const p = Number.parseFloat(value(body, "--tp-label-mix")) / 100;
      expect(p).toBeGreaterThan(0.05);
      const surface = rgb(value(body, "--tp-label-surface"));
      const ink = rgb(value(body, "--tp-label-ink"));
      const ratios = Object.fromEntries(LABEL_COLORS.map((color) => [color, Math.round(contrast(ink, mix(rgb(value(body, `--tp-label-${color}`)), surface, p)) * 100) / 100]));
      for (const color of LABEL_COLORS) expect(ratios[color], `${color}: ${JSON.stringify(ratios)}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`o ponto de cor se distingue do fundo da pastilha (>= 1.5), tema ${name}`, () => {
      const p = Number.parseFloat(value(body, "--tp-label-mix")) / 100;
      const surface = rgb(value(body, "--tp-label-surface"));
      for (const color of LABEL_COLORS) {
        const dot = rgb(value(body, `--tp-label-${color}`));
        expect(contrast(dot, mix(dot, surface, p)), color).toBeGreaterThanOrEqual(1.5);
      }
    });
  }
});
