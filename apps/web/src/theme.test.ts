import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENT_COLOR, CANCELLED_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS } from "./map/items.js";
import { SITUATION_COLORS } from "./map/situation.js";

const SRC = import.meta.dirname;
const theme = readFileSync(resolve(SRC, "theme.css"), "utf8");

/** Valores da tabela de tokens da ADR 0025. */
const TOKENS: Record<string, string> = {
  "--tp-bg": "#08090d",
  "--tp-bar": "#0b0c11",
  "--tp-surface": "#0e1016",
  "--tp-card": "#12151d",
  "--tp-raised": "#14171f",
  "--tp-selected": "#1a1e2b",
  "--tp-divider": "#1c1f28",
  "--tp-border": "#272c38",
  "--tp-border-strong": "#343a49",
  "--tp-text": "#eceef2",
  "--tp-text-2": "#a0a6b4",
  "--tp-text-3": "#8b92a3",
  "--tp-accent": "#a99bff",
  "--tp-accent-soft": "#d6ceff",
  "--tp-on-accent": "#121019",
  "--tp-blocked": "#ff5a4a",
  "--tp-todo": "#70778a",
  "--tp-doing": "#3b8eff",
  "--tp-review": "#ffd000",
  "--tp-done": "#2ee6b6",
  "--tp-cancelled": "#3c404c",
  "--tp-idea": "#f472d0",
  "--tp-danger": "#e5687a",
  "--tp-danger-text": "#f0919b",
};
const tokenValue = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(theme)?.[1]?.toLowerCase();

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

describe("theme.css", () => {
  it.each(Object.entries(TOKENS))("defines %s as %s on :root", (name, value) => {
    expect(tokenValue(name)).toBe(value);
  });

  it("colors the status mark of each queue place with its token (ADR 0069)", () => {
    const marks = readFileSync(resolve(SRC, "map/status-mark.css"), "utf8");
    for (const place of ["free", "next", "waiting"]) expect(marks).toContain(`.status-mark[data-place="${place}"] { --mark: var(--tp-${place}); }`);
  });

  it("declares the tokens inside :root", () => {
    expect(theme).toMatch(/:root\s*{/);
  });

  it("keeps the hexadecimal copies used by the map colors in sync with the tokens", () => {
    expect(ACCENT_COLOR).toBe(TOKENS["--tp-accent"]);
    expect(IDEA_COLOR).toBe(TOKENS["--tp-idea"]);
    expect(STATUS_COLORS).toEqual({
      todo: TOKENS["--tp-todo"],
      in_progress: TOKENS["--tp-doing"],
      in_review: TOKENS["--tp-review"],
      done: TOKENS["--tp-done"],
      cancelled: TOKENS["--tp-cancelled"],
    });
    expect(SITUATION_COLORS.blocked).toBe(TOKENS["--tp-blocked"]);
    // ADR 0069: os tons de fila, com o mesmo token no mapa, no marcador e na página do ticket.
    expect([SITUATION_COLORS.free, SITUATION_COLORS.next, SITUATION_COLORS.waiting]).toEqual([tokenValue("--tp-free"), tokenValue("--tp-next"), tokenValue("--tp-waiting")]);
    expect(CANCELLED_COLOR).toBe(TOKENS["--tp-cancelled"]);
  });
});

/** Tokens da barra lateral e da coluna da conversa (ADR 0055). */
const SIDE: Record<string, string> = {
  "--tp-side-bg": "#171922",
  "--tp-side-border": "#2c3040",
  "--tp-side-field": "#0f1118",
  "--tp-side-field-border": "#343949",
  "--tp-side-hover": "#1f2230",
  "--tp-side-strong": "#ffffff",
  "--tp-side-text": "#d5d8e2",
  "--tp-side-text-2": "#b4b9c7",
  "--tp-side-text-3": "#9da3b4",
  "--tp-side-selected": "#a99bff",
  "--tp-side-on-selected": "#15121f",
  "--tp-side-selected-meta": "#2c2547",
  "--tp-side-cta": "#f2f3f7",
  "--tp-side-on-cta": "#14161d",
  "--tp-mention": "#ff6b5e",
  "--tp-on-mention": "#1b0907",
  "--tp-conv-bg": "#10121a",
  "--tp-conv-field": "#181b25",
  "--tp-conv-field-border": "#3a4052",
  "--tp-conv-text": "#e6e8ef",
};
const luminance = (hex: string) => {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("sidebar tokens (ADR 0055)", () => {
  it.each(Object.entries(SIDE))("defines %s as %s on :root", (name, value) => {
    expect(tokenValue(name)).toBe(value);
  });

  // Texto sobre fundo, mínimo 4,5:1 (WCAG AA): cada par que a barra, a conversa e as linhas selecionadas usam.
  it.each([
    ["--tp-side-strong", "--tp-side-bg"],
    ["--tp-side-text", "--tp-side-bg"],
    ["--tp-side-text-2", "--tp-side-bg"],
    ["--tp-side-text-3", "--tp-side-bg"],
    ["--tp-side-text-3", "--tp-side-field"],
    ["--tp-side-text-2", "--tp-side-field"],
    ["--tp-side-text", "--tp-side-hover"],
    ["--tp-side-text-3", "--tp-side-hover"],
    ["--tp-side-on-selected", "--tp-side-selected"],
    ["--tp-side-selected-meta", "--tp-side-selected"],
    ["--tp-side-on-cta", "--tp-side-cta"],
    ["--tp-on-mention", "--tp-mention"],
    ["--tp-conv-text", "--tp-conv-bg"],
    ["--tp-side-text-3", "--tp-conv-bg"],
    ["--tp-side-text-2", "--tp-conv-bg"],
    ["--tp-side-strong", "--tp-conv-bg"],
    ["--tp-conv-text", "--tp-conv-field"],
    ["--tp-side-text-3", "--tp-conv-field"],
    ["--tp-accent-soft", "--tp-conv-field"],
    ["--tp-accent-soft", "--tp-conv-bg"],
  ])("%s on %s has at least 4.5:1", (foreground, background) => {
    expect(contrast(tokenValue(foreground)!, tokenValue(background)!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("idea color (ADR 0042)", () => {
  it("is distinct from every status color and from the accent", () => {
    expect([...new Set([...Object.values(STATUS_COLORS), ACCENT_COLOR])]).not.toContain(IDEA_COLOR);
  });

  it("draws the discarded idea as the idea color blended 50% with the background, the same blend the stylesheet applies", () => {
    expect(IDEA_DISCARDED_COLOR).toBe("#7e3e6f");
    expect(readFileSync(resolve(SRC, "map/status-mark.css"), "utf8")).toMatch(/color-mix\(in srgb, var\(--tp-idea\) 50%, var\(--tp-bg\)\)/);
  });
});

describe("literal colors", () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\b(?:white|black)\b(?!-)/;
  const files = cssFiles(SRC).filter((file) => relative(SRC, file) !== "theme.css" && !relative(SRC, file).startsWith("demo/"));

  it("finds the stylesheets it is supposed to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((file) => [relative(SRC, file), file]))("%s has no literal color (only tokens)", (_name, file) => {
    const lines = readFileSync(file as string, "utf8").split("\n");
    const offenders = lines.filter((line) => LITERAL.test(line));
    expect(offenders).toEqual([]);
  });
});
