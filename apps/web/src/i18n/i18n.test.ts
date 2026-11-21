import { describe, expect, it } from "vitest";
import i18n from "./index.js";

const members = (lng: string, count: number) => i18n.t("teams:list.members", { count, lng });

describe("plural by the rule of each language", () => {
  it.each([
    ["pt-BR", ["0 membros", "1 membro", "2 membros"]],
    ["en", ["0 members", "1 member", "2 members"]],
    ["es-MX", ["0 miembros", "1 miembro", "2 miembros"]],
  ] as const)("%s: 0, 1 and 2", (language, expected) => {
    expect([0, 1, 2].map((count) => members(language, count))).toEqual(expected);
  });

  it("uses the large-number category of es-MX and pt-BR", () => {
    expect(members("es-MX", 1_000_000)).toBe("1000000 miembros");
    expect(members("pt-BR", 1_000_000)).toBe("1000000 membros");
  });
});

describe("active language", () => {
  it("keeps <html lang> in step with the language", async () => {
    await i18n.changeLanguage("es-MX");
    expect(document.documentElement.lang).toBe("es-MX");
    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    await i18n.changeLanguage("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  it("interpolates variables without concatenation", () => {
    expect(i18n.t("teams:detail.removeMemberLabel", { name: "Ana", lng: "en" })).toBe("Remove Ana");
  });
});
