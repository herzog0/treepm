import type { SpatialBounds } from "@treepm/engine";

/** Largura, em pixels de tela, a que a câmera leva o ticket aberto quando cabe (ADR 0026). */
export const TICKET_FOCUS_WIDTH = 440;

interface FocusNode {
  readonly width: number;
  readonly subtreeBounds: SpatialBounds;
}

/**
 * Escala para enquadrar o ticket aberto: 440 px de largura, ou o que couber do ticket e de seus filhos
 * (a subárvore inteira) na área visível do mapa. O teto de zoom do mapa é aplicado pela câmera.
 */
export function ticketFocus(node: FocusNode, area: { width: number; height: number }): { bounds: SpatialBounds; requiredScale: number } {
  const { minX, maxX, minY, maxY } = node.subtreeBounds;
  const fit = 0.9 * Math.min(area.width / Math.max(maxX - minX, 1e-9), area.height / Math.max(maxY - minY, 1e-9));
  return { bounds: node.subtreeBounds, requiredScale: Math.min(TICKET_FOCUS_WIDTH / node.width, fit) };
}
