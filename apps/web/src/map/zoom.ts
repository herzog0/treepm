import type { TreeNode } from "@treepm/engine";
import { mapGeometry } from "./mapGeometry.js";

/** Largura, em pixels de tela, que o menor nó do mapa alcança no zoom máximo (ADR 0026). */
export const LEAF_READABLE_WIDTH = 440;

/**
 * Escala máxima da câmera: a que leva o menor nó do layout a `LEAF_READABLE_WIDTH` px. O layout é o do mapa
 * (`mapGeometry`: as mesmas opções, nenhuma, e calculado uma só vez por conjunto de itens), então a largura do menor nó é a que o pacote enxerga.
 */
export function computeLeafMaxScale(items: readonly TreeNode[]): number {
  const { layout } = mapGeometry(items);
  const smallest = layout.nodes.reduce((minimum, node) => Math.min(minimum, node.width), Infinity);
  return LEAF_READABLE_WIDTH / smallest;
}

/** Piso da escala máxima que o pacote já aplica hoje (`Math.max(6, …)`); sem ele, árvores pequenas perderiam zoom e mudariam o enquadramento. */
export const PACKAGE_MIN_MAX_SCALE = 6;

/** Escala máxima passada ao mapa: o maior entre o piso do pacote e a escala que leva a folha a 440 px. */
export const computeMapMaxScale = (items: readonly TreeNode[]): number => Math.max(PACKAGE_MIN_MAX_SCALE, computeLeafMaxScale(items));
