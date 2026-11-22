import { describe, expect, it } from "vitest";
import { foldForSearch, searchTickets } from "./search.js";
import type { SearchableTicket } from "./search.js";

type Item = SearchableTicket & { id: string };

/** Mesmo formato dos casos da barra da web (`apps/web/src/command/search.test.ts`), sobre uma lista plana. */
const make = (id: string, number: number, title: string, extra: Partial<Item> = {}): Item => ({
  id,
  key: `P1-${number}`,
  number,
  title,
  descriptionExcerpt: "",
  ...extra,
});
const ids = (results: readonly { id: string }[]) => results.map((entry) => entry.id);
const search = (text: string, list: readonly Item[], limit = 8) => searchTickets(text, list, limit);

describe("foldForSearch", () => {
  it("removes accents and case", () => {
    expect(foldForSearch("Configuração AÇÃO")).toBe("configuracao acao");
  });
});

describe("searchTickets", () => {
  const tickets = [
    make("a", 47, "Exportar relatório", { key: "TREEPM-47" }),
    make("b", 5, "Relatório de vendas", { key: "TREEPM-5" }),
    make("c", 6, "Painel", { key: "TREEPM-6", descriptionExcerpt: "Inclui o relatório mensal" }),
    make("d", 7, "Exportar csv do relatório", { key: "TREEPM-7" }),
  ];

  it("returns nothing for empty or blank text", () => {
    expect(search("", tickets)).toEqual([]);
    expect(search("   ", tickets)).toEqual([]);
  });

  it("matches the complete key, ignoring case", () => {
    expect(ids(search("treepm-47", tickets))).toEqual(["a"]);
  });

  it("matches a bare number against the ticket number", () => {
    expect(ids(search("47", tickets))).toEqual(["a"]);
  });

  it("orders key, title that starts with, title that contains, then description excerpt", () => {
    expect(ids(search("relatorio", tickets))).toEqual(["b", "a", "d", "c"]);
  });

  it("puts a key match before a title match for the same text", () => {
    const list = [make("x", 1, "Rever 47 itens", { key: "A-1" }), make("y", 47, "Outro", { key: "A-47" })];
    expect(ids(search("47", list))).toEqual(["y", "x"]);
  });

  it("ignores accents and case in both directions", () => {
    const list = [make("a", 1, "Configuração inicial"), make("b", 2, "Ação")];
    expect(ids(search("CONFIGURACAO", list))).toEqual(["a"]);
    expect(ids(search("acao", list))).toEqual(["b", "a"]);
    expect(ids(search("configuração", list))).toEqual(["a"]);
  });

  it("does not repeat a ticket that matches in more than one rule", () => {
    const list = [make("a", 1, "Login", { descriptionExcerpt: "login falha" })];
    expect(ids(search("login", list))).toEqual(["a"]);
  });

  it("returns at most `limit` results, in relevance order", () => {
    const many = Array.from({ length: 12 }, (_, index) => make(`t${index}`, index + 1, `Item ${index}`));
    expect(search("item", many)).toHaveLength(8);
    expect(ids(search("item", many, 3))).toEqual(["t0", "t1", "t2"]);
    expect(search("item", many, 50)).toHaveLength(12);
  });

  it("returns nothing for a limit of zero", () => {
    expect(search("item", [make("a", 1, "Item")], 0)).toEqual([]);
  });

  it("keeps the type of the items it receives", () => {
    const found = search("item", [make("a", 1, "Item", { descriptionExcerpt: "x" })]);
    expect(found[0]?.id).toBe("a");
  });

  describe("by words", () => {
    const list = [
      make("a", 1, "Exportar tickets em CSV"),
      make("b", 2, "Importar CSV"),
      make("c", 3, "Relatório", { descriptionExcerpt: "Exportar em planilha" }),
      make("d", 4, "Exportar csv direto"),
    ];

    it("finds a title that has every word, not only the whole phrase", () => {
      expect(ids(search("exportar csv", list))).toEqual(["d", "a"]);
    });

    it("does not find a ticket when a word is missing", () => {
      expect(ids(search("exportar json", list))).toEqual([]);
      expect(ids(search("importar csv xml", list))).toEqual([]);
    });

    it("finds the words in any order", () => {
      expect(ids(search("csv exportar", list))).toEqual(["a", "d"]);
    });

    it("puts the title that starts with the whole text before the title that only contains the words", () => {
      expect(ids(search("exportar csv", list))[0]).toBe("d");
    });

    it("lets one word be in the title and another only in the excerpt, after the title matches", () => {
      expect(ids(search("relatorio planilha", list))).toEqual(["c"]);
      expect(ids(search("exportar", list))).toEqual(["a", "d", "c"]);
    });
  });
});
