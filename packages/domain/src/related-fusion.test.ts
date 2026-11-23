import { describe, expect, it } from "vitest";
import { fuseRankings, FUSION_RANK_CONSTANT } from "./related-fusion.js";

const ids = (hits: { id: string }[]) => hits.map((hit) => hit.id);

describe("fuseRankings: fusão por posição (ADR 0053, item 7)", () => {
  it("a constante é 60 e a nota é a soma de 1 / (60 + posição), posição começando em 1", () => {
    expect(FUSION_RANK_CONSTANT).toBe(60);
    const [first] = fuseRankings(["a"], ["a"], 5);
    expect(first?.score).toBeCloseTo(2 / 61, 12);
  });

  it("quem está nas duas listas vence quem está numa só, mesmo em posição pior", () => {
    expect(ids(fuseRankings(["a", "b", "c"], ["z", "c", "y"], 10))).toEqual(["c", "a", "z", "b", "y"]);
  });

  it("empate pela ordem na lista de palavras, depois na de vetor", () => {
    // a (palavras 1) e z (vetor 1) têm a mesma nota: a vem primeiro, porque está na lista de palavras.
    expect(ids(fuseRankings(["a"], ["z"], 10))).toEqual(["a", "z"]);
    // b (palavras 2) e y (vetor 2): b antes; entre dois só do vetor com a mesma nota seria impossível (posições distintas).
    expect(ids(fuseRankings(["a", "b"], ["z", "y"], 10))).toEqual(["a", "z", "b", "y"]);
    // Mesma nota por soma, com as listas trocadas de posição: ordem de palavras decide.
    expect(ids(fuseRankings(["a", "b"], ["b", "a"], 10))).toEqual(["a", "b"]);
  });

  it("respeita o limite e devolve a origem de cada id", () => {
    const hits = fuseRankings(["a", "b"], ["b", "c"], 2);
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => [hit.id, hit.origin])).toEqual([
      ["b", "both"],
      ["a", "words"],
    ]);
    expect(fuseRankings(["a"], ["c"], 2).map((hit) => hit.origin)).toEqual(["words", "vector"]);
  });

  it("limite 0 ou negativo e listas vazias dão vazio; só palavras ou só vetor preservam a ordem", () => {
    expect(fuseRankings(["a"], ["b"], 0)).toEqual([]);
    expect(fuseRankings([], [], 5)).toEqual([]);
    expect(ids(fuseRankings(["a", "b", "c"], [], 5))).toEqual(["a", "b", "c"]);
    expect(ids(fuseRankings([], ["x", "y"], 5))).toEqual(["x", "y"]);
  });

  it("repetição dentro da mesma lista conta só a primeira posição", () => {
    expect(ids(fuseRankings(["a", "a", "b"], [], 5))).toEqual(["a", "b"]);
  });

  it("com a união cabendo no limite, nada achado por palavras some", () => {
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const vector = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const fused = ids(fuseRankings(words, vector, 30));
    for (const id of words) expect(fused).toContain(id);
    expect(fused).toHaveLength(24);
  });

  it("com a união maior que o limite, o corte é por nota: as duas listas dividem o espaço", () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const vector = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const fused = fuseRankings(words, vector, 30);
    expect(fused).toHaveLength(30);
    expect(fused.filter((hit) => hit.origin === "words")).toHaveLength(15);
    expect(fused.filter((hit) => hit.origin === "vector")).toHaveLength(15);
  });
});
