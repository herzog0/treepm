import { describe, expect, it } from "vitest";
import { formatActivityTime, formatDate, formatDateTime, formatNumber, toUpper } from "./format.js";

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

describe("formatActivityTime", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    ["pt-BR", 30_000, "agora"],
    ["en", 30_000, "now"],
    ["es-MX", 30_000, "ahora"],
    ["pt-BR", 5 * MIN, "há 5 minutos"],
    ["en", 5 * MIN, "5 minutes ago"],
    ["es-MX", 5 * MIN, "hace 5 minutos"],
    ["pt-BR", 3 * HOUR, "há 3 horas"],
    ["en", 2 * DAY, "2 days ago"],
    ["pt-BR", DAY, "ontem"],
  ] as const)("is relative when recent (%s, %i ms ago)", (language, elapsed, expected) => {
    expect(formatActivityTime(language, ago(elapsed), now)).toBe(expected);
  });

  it("is absolute from seven days on, with the year only when it is not the current one", () => {
    expect(formatActivityTime("pt-BR", ago(7 * DAY), now)).toBe("15 de nov.");
    expect(formatActivityTime("en", ago(7 * DAY), now)).toBe("Nov 15");
    expect(formatActivityTime("es-MX", "2025-03-04T12:00:00Z", now)).toBe("4 mar 2025");
  });

  it("treats a moment slightly in the future (clock skew) as now", () => {
    expect(formatActivityTime("en", new Date(now.getTime() + 20_000).toISOString(), now)).toBe("now");
  });
});

describe("formatDateTime", () => {
  it.each([
    ["pt-BR", "20 de novembro de 2026"],
    ["en", "November 20, 2026"],
    ["es-MX", "20 de noviembre de 2026"],
  ] as const)("is complete in %s: the long date and the time", (language, date) => {
    const text = formatDateTime(language, "2026-11-20T12:30:00Z", "America/Sao_Paulo");
    expect(text).toContain(date);
    expect(text).toMatch(/9[:.]30/);
  });
});
