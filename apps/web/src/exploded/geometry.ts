import type { SpatialBounds, SpatialLayout, TreeNode } from "@treepm/engine";

/** Medidas da grade no mundo (ADR 0070): os cards ficam parados aqui; só a câmera move e escala. */
export const CARD_WIDTH = 132;
export const CARD_HEIGHT = 38;
export const COLUMN_WIDTH = 168;
export const ROW_HEIGHT = 46;
/** Abaixo desta escala o card mostra só o código, grande (o texto de 11 a 12 px ficaria abaixo de 7 px). */
export const CODE_SCALE = 0.6;
/** Abaixo desta escala nem o código grande se lê: o card vira um retângulo com a cor. */
export const BLOCK_SCALE = 0.28;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A caixa do card no mundo, pela coluna e pela linha da árvore. */
export const cardBox = ({ column, row }: { column: number; row: number }): Box => ({ x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT, width: CARD_WIDTH, height: CARD_HEIGHT });

/** O card aparece na tela com esta câmera? Uma margem de meio card evita que ele surja só depois de entrar. */
export function onScreen(box: Box, camera: Camera, size: Size): boolean {
  const margin = (CARD_WIDTH / 2) * camera.scale;
  const left = box.x * camera.scale + camera.x;
  const top = box.y * camera.scale + camera.y;
  return left + box.width * camera.scale >= -margin && left <= size.width + margin && top + box.height * camera.scale >= -margin && top <= size.height + margin;
}

/**
 * O que o card mostra, pela escala: de perto, o código e o título; no meio (o zoom que cabe a árvore inteira numa tela), só o código,
 * grande, para ainda se ler; bem longe, o retângulo com a cor (ADR 0070, seção 7).
 */
export const cardLevel = (scale: number): "card" | "code" | "block" => (scale < BLOCK_SCALE ? "block" : scale < CODE_SCALE ? "code" : "card");

const toStage = (x: number, y: number, camera: Camera) => [x * camera.scale + camera.x, y * camera.scale + camera.y] as const;

/** Os pontos, no palco, da seta entre dois cards: da borda direita do primeiro à borda esquerda do segundo, na altura do meio. */
export function arrowEnds(from: Box, to: Box, camera: Camera): { x1: number; y1: number; x2: number; y2: number } {
  const [x1, y1] = toStage(from.x + from.width, from.y + from.height / 2, camera);
  const [x2, y2] = toStage(to.x, to.y + to.height / 2, camera);
  return { x1, y1, x2, y2 };
}

/** A curva da seta "pendura em", no palco: sai na horizontal e chega na horizontal. */
export function hangPath(from: Box, to: Box, camera: Camera): string {
  const { x1, y1, x2, y2 } = arrowEnds(from, to, camera);
  const bend = Math.max(12, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
}

/** A seta passa pela tela? (a caixa que contém as duas pontas cruza a janela) */
export function segmentOnScreen(from: Box, to: Box, camera: Camera, size: Size): boolean {
  const { x1, y1, x2, y2 } = arrowEnds(from, to, camera);
  return Math.max(x1, x2) >= 0 && Math.min(x1, x2) <= size.width && Math.max(y1, y2) >= 0 && Math.min(y1, y2) <= size.height;
}

/** O nó único que a câmera do mapa (`useSpatialCamera`) recebe: cobre a grade inteira. */
export interface ExplodedRoot extends TreeNode {
  readonly id: "exploded-root";
}

/**
 * Um layout no formato do mapa para a câmera do `@treepm/react`, reaproveitada sem mudança: um nó só, do tamanho da grade. A câmera usa
 * dele as bordas (enquadrar) e a largura (o zoom máximo); o nó tem id fixo, então novos dados não reenquadram a tela.
 */
export function cameraLayout(columns: number, rows: number): SpatialLayout<ExplodedRoot> {
  const bounds: SpatialBounds = {
    minX: 0,
    minY: 0,
    maxX: Math.max(0, columns - 1) * COLUMN_WIDTH + CARD_WIDTH,
    maxY: Math.max(0, rows - 1) * ROW_HEIGHT + CARD_HEIGHT,
  };
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const root = {
    item: { id: "exploded-root" as const, parentId: null },
    depth: 0,
    x: width / 2,
    y: 0,
    width: CARD_WIDTH,
    height,
    subtreeRadius: Math.max(width, height) / 2,
    subtreeBounds: bounds,
    slotBounds: bounds,
  };
  return { nodes: [root], nodeById: new Map([[root.item.id, root]]), bounds, initialBounds: bounds };
}
