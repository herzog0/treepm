import { describe, expect, it } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, COLUMN_WIDTH, ROW_HEIGHT, cameraLayout, cardBox, cardLevel, hangPath, onScreen } from "./geometry.js";

// ADR 0070, seção 7: os cards ficam parados no mundo; a câmera só move e escala. Só o que está na tela é desenhado.
describe("geometry", () => {
  it("o card fica na coluna e na linha da árvore", () => {
    expect(cardBox({ column: 2, row: 1.5 })).toEqual({ x: 2 * COLUMN_WIDTH, y: 1.5 * ROW_HEIGHT, width: CARD_WIDTH, height: CARD_HEIGHT });
  });

  it("na tela: só o que cruza a janela, com a câmera aplicada", () => {
    const camera = { x: -1000, y: 0, scale: 0.5 };
    const size = { width: 800, height: 600 };
    expect(onScreen(cardBox({ column: 0, row: 0 }), camera, size)).toBe(false);
    expect(onScreen(cardBox({ column: 8, row: 0 }), camera, size)).toBe(true);
    expect(onScreen(cardBox({ column: 8, row: 40 }), camera, size)).toBe(false);
  });

  it("com o zoom longe o card vira um retângulo com a cor; de perto, o card com texto", () => {
    expect(cardLevel(0.2)).toBe("block");
    expect(cardLevel(0.6)).toBe("card");
  });

  it("a seta sai da borda direita de quem vem antes e chega na borda esquerda de quem vem depois, no palco", () => {
    const camera = { x: 10, y: 20, scale: 0.5 };
    const path = hangPath(cardBox({ column: 0, row: 0 }), cardBox({ column: 1, row: 2 }), camera);
    const startX = 10 + CARD_WIDTH * 0.5;
    const startY = 20 + (CARD_HEIGHT / 2) * 0.5;
    const endX = 10 + COLUMN_WIDTH * 0.5;
    const endY = 20 + (2 * ROW_HEIGHT + CARD_HEIGHT / 2) * 0.5;
    expect(path.startsWith(`M ${startX} ${startY} C`)).toBe(true);
    expect(path.endsWith(`${endX} ${endY}`)).toBe(true);
  });

  it("dá à câmera do mapa um layout com um nó que cobre a grade inteira", () => {
    const layout = cameraLayout(3, 4);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.bounds).toEqual({ minX: 0, minY: 0, maxX: 2 * COLUMN_WIDTH + CARD_WIDTH, maxY: 3 * ROW_HEIGHT + CARD_HEIGHT });
    expect(layout.initialBounds).toEqual(layout.bounds);
    expect(layout.nodeById.get(layout.nodes[0]!.item.id)).toBe(layout.nodes[0]);
  });
});
