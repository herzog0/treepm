import { describe, expect, it, vi } from "vitest";
import { foldForSearch, searchTickets } from "./search.js";
import type { SearchableTicket } from "./search.js";

/** A versão de antes (normaliza tudo a cada chamada), guardada como referência de equivalência. */
function searchReference<T extends SearchableTicket>(text: string, tickets: Iterable<T>, limit: number): T[] {
  const words = foldForSearch(text).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0 || limit <= 0) return [];
  const needle = words.join(" ");
  const single = words.length === 1;
  const numeric = single && /^\d+$/.test(needle) ? Number(needle) : null;
  const tiers: T[][] = [[], [], [], []];
  for (const ticket of tickets) {
    const title = foldForSearch(ticket.title);
    const tier =
      single && (foldForSearch(ticket.key) === needle || (numeric !== null && ticket.number === numeric))
        ? 0
        : title.startsWith(needle)
          ? 1
          : words.every((word) => title.includes(word))
            ? 2
            : (() => {
                const both = `${title} ${foldForSearch(ticket.descriptionExcerpt)}`;
                return words.every((word) => both.includes(word));
              })()
              ? 3
              : -1;
    if (tier >= 0) tiers[tier]!.push(ticket);
  }
  return tiers.flat().slice(0, limit);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ["Relatório", "relatorios", "FILA", "fila", "notificações", "Notificacoes", "café", "CAFE", "ação", "açao", "login", "Ñandú", "São Paulo", "ÇÃO", "implementar", "corrigir", "a", "é", "47", "x̃"];
function tickets(count: number, seed: number): SearchableTicket[] {
  const random = seeded(seed);
  const pick = () => WORDS[Math.floor(random() * WORDS.length)]!;
  return Array.from({ length: count }, (_, at) => ({
    key: `${random() < 0.5 ? "TREEPM" : "Alfa"}-${at + 1}`,
    number: at + 1,
    title: Array.from({ length: Math.floor(random() * 5) }, pick).join(" "),
    descriptionExcerpt: random() < 0.2 ? "" : Array.from({ length: Math.floor(random() * 8) }, pick).join(" "),
  }));
}
const QUERIES = ["relatorio", "RELATÓRIOS", "fila notificacoes", "cafe", "ação", "acao", "TREEPM-47", "treepm-47", "47", "0047", "alfa-3", "sao paulo", "  fila   ", "", "   ", "zzzz", "implementar corrigir login", "a", "é", "Ñandú", "x̃", "1", "12"];

describe("searchTickets: same result and order as before", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`generated list, seed ${seed}, every query, several limits`, () => {
      const list = tickets(150 + seed * 40, seed);
      for (const query of QUERIES) for (const limit of [0, 1, 8, 50, 10_000]) expect(searchTickets(query, list, limit)).toEqual(searchReference(query, list, limit));
    });
  }

  it("empty list and an iterable that is not an array", () => {
    expect(searchTickets("fila", [], 8)).toEqual([]);
    const list = tickets(60, 9);
    expect(searchTickets("fila", new Set(list), 8)).toEqual(searchReference("fila", new Set(list), 8));
    expect(searchTickets("fila", (function* () { yield* list; })(), 8)).toEqual(searchReference("fila", list, 8));
  });

  it("the same ticket object edited in place is searched by its new text (the memory never serves stale text)", () => {
    const ticket = { key: "A-1", number: 1, title: "Relatório", descriptionExcerpt: "" };
    expect(searchTickets("relatorio", [ticket], 8)).toEqual([ticket]);
    ticket.title = "Fila";
    ticket.descriptionExcerpt = "outro";
    expect(searchTickets("relatorio", [ticket], 8)).toEqual([]);
    expect(searchTickets("fila outro", [ticket], 8)).toEqual([ticket]);
    ticket.key = "B-2";
    expect(searchTickets("b-2", [ticket], 8)).toEqual([ticket]);
  });
});

describe("searchTickets: normalizes each ticket once", () => {
  it("a later search over the same tickets only normalizes the text typed", () => {
    const list = tickets(500, 11);
    const spy = vi.spyOn(String.prototype, "normalize");
    try {
      searchTickets("zzzz", list, 8); // nada bate: a regra lê chave, título e trecho de todos
      const first = spy.mock.calls.length;
      spy.mockClear();
      searchTickets("relatorios fila", list, 8);
      searchTickets("fila", [...list], 8);
      expect(first).toBeGreaterThan(500);
      expect(spy.mock.calls.length).toBeLessThan(40);
    } finally {
      spy.mockRestore();
    }
  });
});
