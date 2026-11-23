import { describe, expect, it } from "vitest";
import { fuseBy, fuseRankings, interleaveRankings } from "./related-fusion.js";

const ids = (hits: { id: string }[]) => hits.map((hit) => hit.id);

describe("interleaveRankings: um de cada lista, começando pelas palavras (ADR 0053)", () => {
  it("alterna palavras 1, vetor 1, palavras 2, vetor 2…", () => {
    expect(ids(interleaveRankings(["a", "b", "c"], ["x", "y", "z"], 10))).toEqual(["a", "x", "b", "y", "c", "z"]);
  });

  it("pula repetidos: quem já entrou não entra de novo, e o turno passa para a outra lista", () => {
    expect(ids(interleaveRankings(["a", "b", "c"], ["a", "c", "y"], 10))).toEqual(["a", "c", "b", "y"]);
  });

  it("quando uma lista acaba, segue com a outra", () => {
    expect(ids(interleaveRankings(["a"], ["x", "y", "z"], 10))).toEqual(["a", "x", "y", "z"]);
    expect(ids(interleaveRankings(["a", "b", "c"], ["x"], 10))).toEqual(["a", "x", "b", "c"]);
    expect(ids(interleaveRankings(["a", "b"], [], 10))).toEqual(["a", "b"]);
    expect(ids(interleaveRankings([], ["x", "y"], 10))).toEqual(["x", "y"]);
  });

  it("respeita o limite e zero ou negativo dá lista vazia", () => {
    expect(ids(interleaveRankings(["a", "b", "c"], ["x", "y", "z"], 3))).toEqual(["a", "x", "b"]);
    expect(interleaveRankings(["a"], ["x"], 0)).toEqual([]);
    expect(interleaveRankings([], [], 5)).toEqual([]);
  });

  it("a origem de cada id: só palavras, só vetor ou as duas", () => {
    const hits = interleaveRankings(["a", "b"], ["b", "x"], 10);
    expect(hits.map((hit) => [hit.id, hit.origin])).toEqual([["a", "words"], ["b", "both"], ["x", "vector"]]);
  });

  it("repetição dentro da mesma lista vale uma vez", () => {
    expect(ids(interleaveRankings(["a", "a", "b"], ["x", "x"], 10))).toEqual(["a", "x", "b"]);
  });

  it("nenhum achado das palavras sai do topo por causa do vetor: o 4º das palavras fica no 7º ou antes", () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i + 1}`);
    const vector = Array.from({ length: 10 }, (_, i) => `v${i + 1}`);
    const out = ids(interleaveRankings(words, vector, 30));
    expect(out.indexOf("w4")).toBe(6);
    expect(out).toHaveLength(20);
  });

  it("a nota é decrescente com a posição", () => {
    const hits = interleaveRankings(["a", "b"], ["x"], 10);
    expect(hits.map((hit) => hit.score)).toEqual([...hits.map((hit) => hit.score)].sort((l, r) => r - l));
  });
});

describe("fuseBy: a regra escolhida por SEMANTIC_TRIAGE", () => {
  it("rrf é a soma de posições de hoje; interleave é a intercalação", () => {
    const words = ["a", "b", "c"];
    const vector = ["z", "c", "y"];
    expect(fuseBy("rrf", words, vector, 10)).toEqual(fuseRankings(words, vector, 10));
    expect(ids(fuseBy("interleave", words, vector, 10))).toEqual(ids(interleaveRankings(words, vector, 10)));
  });
});
