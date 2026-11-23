import { buildSpatialLayout, buildTreeIndex } from "@treepm/engine";
import type { SpatialLayout, TreeIndex, TreeNode } from "@treepm/engine";

/** Índice e layout (com as opções padrão, as do mapa) de um conjunto de itens. */
export interface MapGeometry<TNode extends TreeNode> {
  readonly index: TreeIndex<TNode>;
  readonly layout: SpatialLayout<TNode>;
}

const built = new WeakMap<readonly TreeNode[], MapGeometry<TreeNode>>();

/**
 * Índice e layout dos `items`, calculados uma vez por array: quem precisa da geometria (a escala máxima do zoom e o
 * canvas espacial) reaproveita o que já foi feito para os mesmos itens, em vez de refazer. Os itens são imutáveis,
 * como em todo estado do React; um array novo (um refresh que difere) é uma entrada nova.
 */
export function mapGeometry<TNode extends TreeNode>(items: readonly TNode[]): MapGeometry<TNode> {
  const known = built.get(items);
  if (known) return known as MapGeometry<TNode>;
  const index = buildTreeIndex(items);
  const geometry: MapGeometry<TNode> = { index, layout: buildSpatialLayout(index) };
  built.set(items, geometry as MapGeometry<TreeNode>);
  return geometry;
}
