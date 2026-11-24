import { describe, expect, it } from "vitest";

const files = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

const strings = (value: unknown, path: string): [string, string][] =>
  typeof value === "string" ? [[path, value]] : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`)) : [];

describe("o termo thread", () => {
  it("não se traduz em nenhum idioma: nem 'hilo' nem 'fio' aparecem nos catálogos", () => {
    const found = Object.entries(files).flatMap(([file, content]) => strings(content, file)).filter(([, text]) => /\b(hilos?|fios?)\b/i.test(text));
    expect(found).toEqual([]);
  });
});
