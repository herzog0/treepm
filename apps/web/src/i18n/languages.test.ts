import { describe, expect, it } from "vitest";
import { languageFromNavigator, resolveLanguage } from "./languages.js";

describe("languageFromNavigator", () => {
  it.each([
    [["pt-BR"], "pt-BR"],
    [["pt"], "pt-BR"],
    [["pt-PT"], "pt-BR"],
    [["es-MX"], "es-MX"],
    [["es"], "es-MX"],
    [["es-ES"], "es-MX"],
    [["es-419"], "es-MX"],
    [["en"], "en"],
    [["en-GB"], "en"],
    [["en-US", "pt-BR"], "en"],
  ] as const)("maps %j to %s", (languages, expected) => {
    expect(languageFromNavigator(languages)).toBe(expected);
  });

  it("uses the first language of the list, not the first supported one", () => {
    expect(languageFromNavigator(["fr-FR", "pt-BR"])).toBe("en");
    expect(languageFromNavigator(["es-ES", "en"])).toBe("es-MX");
  });

  it("falls back to English for an unsupported language", () => {
    expect(languageFromNavigator(["fr-FR"])).toBe("en");
    expect(languageFromNavigator(["ja"])).toBe("en");
    expect(languageFromNavigator(["pty"])).toBe("en");
  });

  it("falls back to English for an empty list", () => {
    expect(languageFromNavigator([])).toBe("en");
  });

  it("is case-insensitive", () => {
    expect(languageFromNavigator(["PT-br"])).toBe("pt-BR");
    expect(languageFromNavigator(["ES"])).toBe("es-MX");
  });
});

describe("resolveLanguage", () => {
  it("follows the browser when the preference is auto", () => {
    expect(resolveLanguage("auto", ["es-ES"])).toBe("es-MX");
    expect(resolveLanguage("auto", [])).toBe("en");
  });

  it("uses the chosen language regardless of the browser", () => {
    expect(resolveLanguage("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(resolveLanguage("en", ["pt-BR"])).toBe("en");
    expect(resolveLanguage("es-MX", ["pt-BR"])).toBe("es-MX");
  });
});
