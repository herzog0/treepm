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
    expect(CANCELLED_COLOR).toBe(TOKENS["--tp-cancelled"]);
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
