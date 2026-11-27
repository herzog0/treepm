import type { ExplodedNode } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { cardText, firstCamera, headline } from "./cards.js";
import { CARD_HEIGHT, ROW_HEIGHT } from "./geometry.js";

describe("cardText", () => {
  it("a linha 1 é o código entre colchetes do começo do título; a linha 2, o resto do título", () => {
    expect(cardText({ key: "P-7", title: "[ABC-01] Fazer a base" })).toEqual({ code: "ABC-01", title: "Fazer a base" });
  });
  it("sem código no título, a linha 1 é a chave do ticket", () => {
    expect(cardText({ key: "P-7", title: "Fazer a base [x]" })).toEqual({ code: "P-7", title: "Fazer a base [x]" });
  });
});

const node = (id: string, column: number, row: number, place: ExplodedNode["place"], outside = false): ExplodedNode => ({ id, column, row, hangOn: null, outside, inside: 0, place });
const keys = new Map([
  ["a", { key: "P-1", title: "Primeiro", blocked: false }],
  ["b", { key: "P-2", title: "[ABC-02] Segundo", blocked: false }],
  ["c", { key: "P-3", title: "Terceiro", blocked: true }],
  ["d", { key: "P-4", title: "Quarto", blocked: false }],
  ["e", { key: "P-5", title: "Quinto", blocked: false }],
]);

describe("headline", () => {
  it("pegue agora: os livres sem impedimento; abre em seguida: os próximos; por coluna e linha; fora do foco não entra; pelo código do card", () => {
    const nodes = [node("b", 0, 3, "free"), node("a", 0, 1, "free"), node("c", 0, 2, "free"), node("d", 1, 0, "next"), node("e", 0, 0, "free", true)];
    // O mesmo código que a linha 1 do card mostra: a chave, ou o [CÓDIGO] do título.
    expect(headline(nodes, keys)).toEqual({ now: ["P-1", "ABC-02"], next: ["P-4"] });
  });
  it("sem nada, listas vazias", () => {
    expect(headline([node("a", 0, 0, "waiting")], keys)).toEqual({ now: [], next: [] });
  });
});

describe("firstCamera", () => {
  const size = { width: 1440, height: 800 };
  it("abre numa escala de leitura, com o passo 0 na borda esquerda e o primeiro 'pegue agora' na altura do meio", () => {
    const nodes = [node("x", 0, 0, "waiting"), node("a", 0, 30, "free"), node("z", 20, 60, "waiting")];
    const camera = firstCamera(nodes, 21, 61, size, ["a"]) as { x: number; y: number; scale: number };
    expect(camera.scale).toBe(1);
    expect(camera.x).toBe(24);
    expect(camera.y).toBeCloseTo(size.height / 2 - (30 * ROW_HEIGHT + CARD_HEIGHT / 2));
  });
  it("sem 'pegue agora', a primeira linha da coluna 0", () => {
    const camera = firstCamera([node("x", 0, 5, "waiting"), node("y", 0, 2, "waiting"), node("z", 9, 40, "waiting")], 10, 41, size, []) as { y: number };
    expect(camera.y).toBeCloseTo(size.height / 2 - (2 * ROW_HEIGHT + CARD_HEIGHT / 2));
  });
  it("uma árvore que cabe inteira numa escala de leitura abre inteira", () => {
    const camera = firstCamera([node("a", 0, 0, "free"), node("b", 1, 0, "next")], 2, 1, size, ["a"]);
    expect(camera).toEqual({ fitAll: true });
  });
});
