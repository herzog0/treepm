import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, toUpper } from "./format.js";

describe("formatDate", () => {
  const iso = "2026-11-20T12:00:00Z";
  it.each([
    ["pt-BR", "20 de novembro de 2026"],
    ["en", "November 20, 2026"],
    ["es-MX", "20 de noviembre de 2026"],
  ] as const)("formats in %s", (language, expected) => {
    expect(formatDate(language, iso)).toBe(expected);
  });
});

describe("formatNumber", () => {
  it.each([
    ["pt-BR", "1.234,5"],
    ["en", "1,234.5"],
    ["es-MX", "1,234.5"],
  ] as const)("formats in %s", (language, expected) => {
    expect(formatNumber(language, 1234.5)).toBe(expected);
  });
});

describe("toUpper", () => {
  it("uppercases with the rules of the language", () => {
    expect(toUpper("pt-BR", "ação")).toBe("AÇÃO");
    expect(toUpper("es-MX", "acción")).toBe("ACCIÓN");
    expect(toUpper("en", "action")).toBe("ACTION");
  });
});
