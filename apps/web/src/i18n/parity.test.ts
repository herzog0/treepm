import { describe, expect, it } from "vitest";
import { checkParity } from "./parity.js";
import { resources } from "./resources.js";

const files = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" });

const base = () => ({
  "./locales/pt-BR/area.json": { title: "Título", greeting: "Olá, {{name}}", items_one: "{{count}} item", items_many: "{{count}} itens", items_other: "{{count}} itens", items_zero: "{{count}} itens" },
  "./locales/en/area.json": { title: "Title", greeting: "Hello, {{name}}", items_one: "{{count}} item", items_other: "{{count}} items" },
  "./locales/es-MX/area.json": { title: "Título", greeting: "Hola, {{name}}", items_one: "{{count}} elemento", items_many: "{{count}} elementos", items_other: "{{count}} elementos" },
});

describe("checkParity (rules)", () => {
  it("accepts complete catalogs", () => {
    expect(checkParity(base())).toEqual([]);
  });

  it("reports a key missing in one language", () => {
    const input = base();
    delete (input["./locales/en/area.json"] as Record<string, string>).title;
    expect(checkParity(input)).toEqual([expect.stringContaining("en area: missing key \"title\"")]);
  });

  it("reports an extra key in one language", () => {
    const input = base();
    Object.assign(input["./locales/es-MX/area.json"], { extra: "Sobra" });
    expect(checkParity(input)).toContainEqual(expect.stringContaining("es-MX area: missing key \"extra\" in pt-BR"));
  });

  it("reports a file that exists in only some languages", () => {
    const input: Record<string, unknown> = base();
    delete input["./locales/es-MX/area.json"];
    expect(checkParity(input)).toEqual([expect.stringContaining("missing file es-MX/area.json")]);
  });

  it("reports a swapped or missing variable", () => {
    const input = base();
    input["./locales/en/area.json"].greeting = "Hello, {{nome}}";
    expect(checkParity(input)).toEqual([expect.stringContaining("en area: \"greeting\" has variables {{nome}} but pt-BR has {{name}}")]);
  });

  it("reports a plural form without {{count}}", () => {
    const input = base();
    input["./locales/en/area.json"].items_one = "one item";
    expect(checkParity(input)).toEqual([expect.stringContaining("en area: \"items_one\" has variables  but pt-BR has {{count}}")]);
  });

  it("reports a markup tag that does not match", () => {
    const input = base();
    input["./locales/pt-BR/area.json"].title = "Título <0>forte</0>";
    expect(checkParity(input).join("\n")).toContain("has variables  but pt-BR has <0>");
  });

  it("requires the plural forms each language needs (CLDR)", () => {
    const input = base();
    delete (input["./locales/en/area.json"] as Record<string, string>).items_other;
    delete (input["./locales/es-MX/area.json"] as Record<string, string>).items_many;
    const problems = checkParity(input);
    expect(problems).toContainEqual(expect.stringContaining("en area: \"items\" lacks the plural form _other"));
    expect(problems).toContainEqual(expect.stringContaining("es-MX area: \"items\" lacks the plural form _many"));
  });

  it("rejects plural forms a language does not use, but allows _zero", () => {
    const input = base();
    Object.assign(input["./locales/en/area.json"], { items_few: "{{count}} items" });
    expect(checkParity(input)).toEqual([expect.stringContaining("en area: \"items\" has the unexpected plural form _few")]);
  });

  it("reports a plural in one language and plain text in another", () => {
    const input = base();
    input["./locales/en/area.json"] = { title: "Title", greeting: "Hello, {{name}}", items: "items" } as never;
    expect(checkParity(input).join("\n")).toContain("\"items\" is plural in pt-BR but not in en");
  });

  it("reports empty and non-text values", () => {
    const input = base();
    input["./locales/en/area.json"].title = "";
    Object.assign(input["./locales/en/area.json"], { n: 3 });
    const problems = checkParity(input);
    expect(problems).toContainEqual(expect.stringContaining("en area: \"title\" is empty"));
    expect(problems).toContainEqual(expect.stringContaining("en area: \"n\" is not text"));
  });

  it("walks nested objects with dotted keys", () => {
    const input = base() as Record<string, unknown>;
    input["./locales/pt-BR/area.json"] = { a: { b: "x" } };
    input["./locales/en/area.json"] = { a: {} };
    input["./locales/es-MX/area.json"] = { a: { b: "x" } };
    expect(checkParity(input)).toEqual([expect.stringContaining("en area: missing key \"a.b\"")]);
  });
});

describe("the catalogs in the repository", () => {
  it("has the same files, keys, variables and plural forms in the three languages", () => {
    expect(checkParity(files)).toEqual([]);
  });

  it("registers every catalog file in resources.ts, which types the keys", () => {
    const registered = Object.keys(resources["pt-BR"]).sort();
    const onDisk = [...new Set(Object.keys(files).map((path) => path.split("/")[3]!.replace(".json", "")))].sort();
    expect(onDisk).toEqual(registered);
  });
});
