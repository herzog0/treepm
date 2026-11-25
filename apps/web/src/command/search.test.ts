import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import { searchTickets } from "./search.js";

const byProject = (...groups: Array<[string, ReturnType<typeof makeTicket>[]]>) => Object.fromEntries(groups);
const ids = (results: readonly { id: string }[]) => results.map((entry) => entry.id);

describe("searchTickets", () => {
  const tickets = byProject(
    ["p1", [
      makeTicket("a", "p1", 47, "Exportar relatório", { key: "TREEPM-47" }),
      makeTicket("b", "p1", 5, "Relatório de vendas", { key: "TREEPM-5" }),
      makeTicket("c", "p1", 6, "Painel", { key: "TREEPM-6", descriptionExcerpt: "Inclui o relatório mensal" }),
      makeTicket("d", "p1", 7, "Exportar csv do relatório", { key: "TREEPM-7" }),
    ]],
  );

  it("returns nothing for empty or blank text", () => {
    expect(searchTickets("", tickets)).toEqual([]);
    expect(searchTickets("   ", tickets)).toEqual([]);
  });

  it("matches the complete key, ignoring case", () => {
    expect(ids(searchTickets("treepm-47", tickets))).toEqual(["a"]);
  });

  it("matches a bare number against the ticket number", () => {
    expect(ids(searchTickets("47", tickets))).toEqual(["a"]);
  });

  it("orders key, title that starts with, title that contains, then description excerpt", () => {
    expect(ids(searchTickets("relatorio", tickets))).toEqual(["b", "a", "d", "c"]);
  });

  it("puts a key match before a title match for the same text", () => {
    const list = byProject(["p1", [makeTicket("x", "p1", 1, "Rever 47 itens", { key: "A-1" }), makeTicket("y", "p1", 47, "Outro", { key: "A-47" })]]);
    expect(ids(searchTickets("47", list))).toEqual(["y", "x"]);
  });

  it("ignores accents and case in both directions", () => {
    const list = byProject(["p1", [makeTicket("a", "p1", 1, "Configuração inicial"), makeTicket("b", "p1", 2, "Ação")]]);
    expect(ids(searchTickets("CONFIGURACAO", list))).toEqual(["a"]);
    expect(ids(searchTickets("acao", list))).toEqual(["b", "a"]);
    expect(ids(searchTickets("configuração", list))).toEqual(["a"]);
  });

  it("does not repeat a ticket that matches in more than one rule", () => {
    const list = byProject(["p1", [makeTicket("a", "p1", 1, "Login", { descriptionExcerpt: "login falha" })]]);
    expect(ids(searchTickets("login", list))).toEqual(["a"]);
  });

  it("returns at most eight results", () => {
    const many = byProject(["p1", Array.from({ length: 12 }, (_, index) => makeTicket(`t${index}`, "p1", index + 1, `Item ${index}`))]);
    expect(searchTickets("item", many)).toHaveLength(8);
  });

  it("searches the tickets of every project", () => {
    const list = byProject(
      ["p1", [makeTicket("a", "p1", 1, "Deploy", { key: "ALFA-1" })]],
      ["p2", [makeTicket("b", "p2", 1, "Deploy", { key: "BETA-1" })]],
    );
    expect(ids(searchTickets("deploy", list))).toEqual(["a", "b"]);
    expect(ids(searchTickets("1", list))).toEqual(["a", "b"]);
  });

  describe("by words", () => {
    const list = byProject(["p1", [
      makeTicket("a", "p1", 1, "Exportar tickets em CSV"),
      makeTicket("b", "p1", 2, "Importar CSV"),
      makeTicket("c", "p1", 3, "Relatório", { descriptionExcerpt: "Exportar em planilha" }),
      makeTicket("d", "p1", 4, "Exportar csv direto"),
    ]]);

    it("finds a title that has every word, not only the whole phrase", () => {
      expect(ids(searchTickets("exportar csv", list))).toEqual(["d", "a"]);
    });

    it("does not find a ticket when a word is missing", () => {
      expect(ids(searchTickets("exportar json", list))).toEqual([]);
      expect(ids(searchTickets("importar csv xml", list))).toEqual([]);
    });

    it("finds the words in any order", () => {
      expect(ids(searchTickets("csv exportar", list))).toEqual(["a", "d"]);
    });

    it("puts the title that starts with the whole text before the title that only contains the words", () => {
      expect(ids(searchTickets("exportar csv", list))[0]).toBe("d");
    });

    it("lets one word be in the title and another only in the excerpt, after the title matches", () => {
      expect(ids(searchTickets("relatorio planilha", list))).toEqual(["c"]);
      expect(ids(searchTickets("exportar", list))).toEqual(["a", "d", "c"]);
    });
  });
});

describe("searchTickets › chaves do Linear (ADR 0061)", () => {
  const tickets = byProject(
    ["p1", [
      makeTicket("a", "p1", 10, "Importado do Linear", { key: "TREEPM-10", externalKeys: ["ENG-123", "OPS-45", "OPS-9"] }),
      makeTicket("b", "p1", 11, "Outro", { key: "TREEPM-11", externalKeys: ["ENG-124"] }),
      makeTicket("c", "p1", 12, "Criado aqui", { key: "TREEPM-12" }),
    ]],
  );

  it("acha o ticket pela chave do Linear de hoje e pelas antigas, sem maiúsculas", () => {
    expect(ids(searchTickets("ENG-123", tickets))).toEqual(["a"]);
    expect(ids(searchTickets("ops-45", tickets))).toEqual(["a"]);
    expect(ids(searchTickets("OPS-9", tickets))).toEqual(["a"]);
  });

  it("a chave tem que ser inteira: 'ENG-12' não acha ENG-123", () => {
    expect(ids(searchTickets("ENG-12", tickets))).toEqual([]);
  });

  it("ticket sem chaves do Linear continua achado pela chave do TreePM", () => {
    expect(ids(searchTickets("treepm-12", tickets))).toEqual(["c"]);
  });
});
