import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { Language } from "../i18n/languages.js";
import { relativeTimeText } from "./relativeTime.js";

const now = Date.parse("2026-11-21T12:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const at = (language: Language, seconds: number) => relativeTimeText(i18n.getFixedT(language, "github"), ago(seconds), now);

describe("relativeTimeText", () => {
  it.each([
    [5, "agora"],
    [59, "agora"],
    [60, "há 1 minuto"],
    [150, "há 2 minutos"],
    [3600, "há 1 hora"],
    [7300, "há 2 horas"],
    [86400, "há 1 dia"],
    [3 * 86400, "há 3 dias"],
  ])("%is ago reads %s in Portuguese", (seconds, text) => {
    expect(at("pt-BR", seconds)).toBe(text);
  });

  it("never goes negative for a timestamp slightly in the future", () => {
    expect(at("pt-BR", -30)).toBe("agora");
  });

  it.each([
    ["en", 5, "just now"],
    ["en", 60, "1 minute ago"],
    ["en", 150, "2 minutes ago"],
    ["en", 7300, "2 hours ago"],
    ["en", 3 * 86400, "3 days ago"],
    ["es-MX", 5, "ahora"],
    ["es-MX", 60, "hace 1 minuto"],
    ["es-MX", 7300, "hace 2 horas"],
    ["es-MX", 86400, "hace 1 día"],
  ] as const)("%s, %is ago reads %s", (language, seconds, text) => {
    expect(at(language, seconds)).toBe(text);
  });
});
