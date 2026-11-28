import { describe, expect, it } from "vitest";
import { selectionArrows } from "./arrows.js";
import type { ArrowInput, ArrowSceneNode } from "./arrows.js";

// ADR 0069, seção 5: ao selecionar um ticket, as setas das dependências dele, e só dele.
// Coordenadas da cena: `x` é o centro do card e `y` o topo; o palco soma a câmera.
const card = (id: string, x: number, y: number, extra: Partial<ArrowSceneNode> = {}): ArrowSceneNode => ({
  id,
  x,
  y,
  width: 100,
  height: 50,
  opacity: 1,
  aggregate: false,
  representation: "card",
  ...extra,
});
const parents: Record<string, string | null> = { s: "p", a: "p", b: "p", p: null, inner: "closed", inner2: "closed", closed: "p", grouped: "p", far: "q", q: null };
const base = (extra: Partial<ArrowInput> = {}): ArrowInput => ({
  selectedId: "s",
  waitsFor: [],
  unlocks: [],
  parentOf: (id) => parents[id] ?? null,
  scene: { nodes: [card("s", 300, 300), card("a", 300, 100), card("b", 300, 500)], groups: [] },
  layoutPoint: () => null,
  camera: { x: 10, y: 20 },
  viewport: { width: 800, height: 700 },
  ...extra,
});

describe("selectionArrows", () => {
  it("o que ele espera chega nele; o que ele libera sai dele; as pontas ficam na borda dos cards, no palco", () => {
    const arrows = selectionArrows(base({ waitsFor: [{ id: "a", need: "start", finished: false }], unlocks: [{ id: "b", need: "start", finished: false }] }));
    expect(arrows).toEqual([
      { key: "waits:a", kind: "waits", need: "start", finished: false, x1: 310, y1: 170, x2: 310, y2: 320 },
      { key: "unlocks:b", kind: "unlocks", need: "start", finished: false, x1: 310, y1: 370, x2: 310, y2: 520 },
    ]);
  });

  it("leva o tipo (para entregar é tracejada) e se a outra ponta já terminou", () => {
    const [arrow] = selectionArrows(base({ waitsFor: [{ id: "a", need: "deliver", finished: true }] }));
    expect(arrow).toMatchObject({ need: "deliver", finished: true });
  });

  it("a outra ponta dentro de um pai fechado vai até o pai", () => {
    const scene = { nodes: [card("s", 300, 300), card("closed", 600, 100, { aggregate: true })], groups: [] };
    const [arrow] = selectionArrows(base({ scene, waitsFor: [{ id: "inner", need: "start", finished: false }] }));
    // Do pai (centro 610, 145) ao selecionado (centro 310, 345): sai pela borda de baixo do pai.
    expect(arrow!.y1).toBeCloseTo(170);
    expect(arrow!.x1).toBeCloseTo(572.5);
  });

  it("a outra ponta num grupo vai até o quadradinho do grupo", () => {
    const group = { childIds: ["grouped", "x"], x: 300, y: 600, width: 10, height: 10, scale: 1, opacity: 1 };
    const [arrow] = selectionArrows(base({ scene: { nodes: [card("s", 300, 300)], groups: [group] }, unlocks: [{ id: "grouped", need: "start", finished: false }] }));
    expect(arrow).toMatchObject({ x1: 310, y1: 370, x2: 310, y2: 620 });
  });

  it("a outra ponta fora da tela: a seta vai até a borda do palco, na direção dela", () => {
    const [arrow] = selectionArrows(base({ scene: { nodes: [card("s", 300, 300)], groups: [] }, layoutPoint: (id) => (id === "far" ? { x: 300, y: 5000 } : null), unlocks: [{ id: "far", need: "start", finished: false }] }));
    expect(arrow).toMatchObject({ x1: 310, y1: 370, x2: 310 });
    expect(arrow!.y2).toBeGreaterThan(650);
    expect(arrow!.y2).toBeLessThanOrEqual(700);
  });

  it("um pai aberto na tela não serve de ponta: a outra ponta está fora da tela dentro dele", () => {
    const scene = { nodes: [card("s", 300, 300), card("q", 300, 600)], groups: [] };
    const [arrow] = selectionArrows(base({ scene, layoutPoint: (id) => (id === "far" ? { x: 300, y: 5000 } : null), unlocks: [{ id: "far", need: "start", finished: false }] }));
    expect(arrow!.y2).toBeGreaterThan(650);
  });

  it("nada a desenhar quando as duas pontas caem no mesmo lugar visível", () => {
    const scene = { nodes: [card("closed", 300, 300, { aggregate: true })], groups: [] };
    const input = base({ selectedId: "inner", scene, waitsFor: [{ id: "inner2", need: "start", finished: false }] });
    expect(selectionArrows(input)).toEqual([]);
  });

  it("sem dependências, nenhuma seta", () => {
    expect(selectionArrows(base())).toEqual([]);
  });
});
