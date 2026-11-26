import type { TreeNode, TreeIndex } from "./spatialIndex.js";

export interface SpatialBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface SpatialLayoutNode<TNode extends TreeNode = TreeNode> {
  readonly item: TNode;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly subtreeRadius: number;
  readonly subtreeBounds: SpatialBounds;
  readonly slotBounds: SpatialBounds;
}

export interface SpatialLayout<TNode extends TreeNode = TreeNode> {
  readonly nodes: readonly SpatialLayoutNode<TNode>[];
  readonly nodeById: ReadonlyMap<string, SpatialLayoutNode<TNode>>;
  readonly bounds: SpatialBounds;
  readonly initialBounds: SpatialBounds;
}

export interface SpatialDimensions {
  readonly width: number;
  readonly height: number;
}

export interface SpatialNormalizationOptions {
  readonly heightStart?: number;
  readonly heightFactor?: number;
  readonly heightPadding?: number;
  readonly minGap?: number;
}

export interface SpatialLayoutOptions<TNode extends TreeNode = TreeNode> {
  readonly dimensions?: readonly SpatialDimensions[] | ((node: TNode, depth: number) => SpatialDimensions);
  readonly rootGap?: number;
  readonly childGap?: number | ((node: TNode, depth: number, ownRadius: number) => number);
  readonly normalization?: false | SpatialNormalizationOptions;
  /** Proporção alvo (largura ÷ altura) da região dos filhos; padrão `TARGET_CHILD_REGION_ASPECT` (ADR 0067). */
  readonly childRegionAspect?: number;
}

/**
 * Proporção alvo (largura ÷ altura) da região dos filhos de um ticket (ADR 0067): o motor escolhe quantos filhos vão por
 * linha para chegar perto dela, preferindo largura, porque as telas são mais largas do que altas.
 */
export const TARGET_CHILD_REGION_ASPECT = 3;

export const DEFAULT_SPATIAL_LAYOUT_OPTIONS = Object.freeze({
  dimensions: Object.freeze([250, 190, 142, 104, 76, 56, 44, 32, 24, 18].map((width, depth) => Object.freeze({ width, height: [142, 108, 82, 62, 46, 34, 28, 22, 16, 12][depth] ?? 12 }))),
  rootGap: 180,
  normalization: Object.freeze({ heightStart: 6, heightFactor: 1.4, heightPadding: 40, minGap: 0.5 }),
});

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}

function validDimensions(value: SpatialDimensions): SpatialDimensions {
  if (!Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0) {
    throw new RangeError("Node dimensions must be finite and positive");
  }
  return value;
}

function normalizeLayoutOptions<TNode extends TreeNode>(options: SpatialLayoutOptions<TNode>) {
  const dimensions = options.dimensions ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.dimensions;
  if (typeof dimensions !== "function") {
    if (dimensions.length === 0) throw new RangeError("dimensions must contain at least one generation");
    dimensions.forEach(validDimensions);
  }
  const normalization: false | Required<SpatialNormalizationOptions> = options.normalization === false ? false : {
    heightStart: options.normalization?.heightStart ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.normalization.heightStart,
    heightFactor: options.normalization?.heightFactor ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.normalization.heightFactor,
    heightPadding: options.normalization?.heightPadding ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.normalization.heightPadding,
    minGap: options.normalization?.minGap ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.normalization.minGap,
  };
  if (normalization) {
    for (const [key, value] of Object.entries(normalization)) nonnegative(value, `normalization.${key}`);
  }
  if (typeof options.childGap === "number") nonnegative(options.childGap, "childGap");
  const childRegionAspect = options.childRegionAspect ?? TARGET_CHILD_REGION_ASPECT;
  if (!Number.isFinite(childRegionAspect) || childRegionAspect <= 0) throw new RangeError("childRegionAspect must be finite and positive");
  return { childRegionAspect, dimensions, rootGap: nonnegative(options.rootGap ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.rootGap, "rootGap"), childGap: options.childGap, normalization };
}

type LayoutConfig<TNode extends TreeNode> = ReturnType<typeof normalizeLayoutOptions<TNode>>;
type MutableLayoutNode<TNode extends TreeNode> = { -readonly [Key in keyof SpatialLayoutNode<TNode>]: SpatialLayoutNode<TNode>[Key] };

interface MeasuredNode<TNode extends TreeNode> extends MutableLayoutNode<TNode> {
  children: MeasuredNode<TNode>[];
}

function scaleSubtree<TNode extends TreeNode>(node: MeasuredNode<TNode>, factor: number) {
  node.x *= factor;
  node.y *= factor;
  node.width *= factor;
  node.height *= factor;
  node.subtreeRadius *= factor;
  node.slotBounds = {
    minX: node.slotBounds.minX * factor,
    maxX: node.slotBounds.maxX * factor,
    minY: node.slotBounds.minY * factor,
    maxY: node.slotBounds.maxY * factor,
  };
  for (const child of node.children) scaleSubtree(child, factor);
  const childBounds = node.children.map((child) => ({
    minX: child.x + child.subtreeBounds.minX,
    maxX: child.x + child.subtreeBounds.maxX,
    minY: child.y + child.subtreeBounds.minY,
    maxY: child.y + child.subtreeBounds.maxY,
  }));
  node.subtreeBounds = {
    minX: Math.min(-node.width / 2, ...childBounds.map((bounds) => bounds.minX)),
    maxX: Math.max(node.width / 2, ...childBounds.map((bounds) => bounds.maxX)),
    minY: Math.min(0, ...childBounds.map((bounds) => bounds.minY)),
    maxY: Math.max(node.height, ...childBounds.map((bounds) => bounds.maxY)),
  };
}

interface ChildRows {
  readonly rowCount: number;
  readonly bounds: SpatialBounds;
}

/**
 * Distância de uma região à proporção alvo: o erro relativo da altura em relação à altura ideal para aquela largura,
 * |altura − largura ÷ alvo| ÷ (largura ÷ alvo). Não depende de escala e pesa mais a região alta demais (o erro cresce
 * sem limite) do que a larga demais (o erro fica abaixo de 1), que é o "prefere largura" da ADR 0067.
 */
function aspectError(width: number, height: number, target: number): number {
  return Math.abs((target * height) / width - 1);
}

/** Onde cada linha termina, com `count` filhos em `rowCount` linhas equilibradas: as primeiras levam um filho a mais. */
function rowEnds(count: number, rowCount: number): number[] {
  const base = Math.floor(count / rowCount);
  const extra = count % rowCount;
  const ends: number[] = [];
  let end = 0;
  for (let row = 0; row < rowCount; row += 1) {
    end += base + (row < extra ? 1 : 0);
    ends.push(end);
  }
  return ends;
}

/** Largura da linha mais larga e soma das alturas das linhas (sem alocar: roda uma vez por candidato). */
function measureRows(widths: readonly number[], heights: readonly number[], rowCount: number, gap: number) {
  const base = Math.floor(widths.length / rowCount);
  const extra = widths.length % rowCount;
  let regionWidth = 0;
  let regionHeight = 0;
  let start = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const end = start + base + (row < extra ? 1 : 0);
    let rowWidth = gap * (end - start - 1);
    let rowHeight = 0;
    for (let position = start; position < end; position += 1) {
      rowWidth += widths[position]!;
      rowHeight = Math.max(rowHeight, heights[position]!);
    }
    regionWidth = Math.max(regionWidth, rowWidth);
    regionHeight += rowHeight + (row > 0 ? gap : 0);
    start = end;
  }
  return { regionWidth, regionHeight };
}

/**
 * Em quantas linhas a região fica mais perto do alvo; no empate, o arranjo mais largo. Busca exata, O(n²) no número de
 * filhos: cerca de 13 ms num pai com 2.000 filhos, uma vez por layout (a segunda passada reaproveita a quebra).
 */
function chooseRowCount(widths: readonly number[], heights: readonly number[], gap: number, target: number): number {
  let best = 1;
  let bestError = Infinity;
  let bestWidth = 0;
  for (let rowCount = 1; rowCount <= widths.length; rowCount += 1) {
    const { regionWidth, regionHeight } = measureRows(widths, heights, rowCount, gap);
    const error = aspectError(regionWidth, regionHeight, target);
    if (error < bestError - 1e-9 || (Math.abs(error - bestError) <= 1e-9 && regionWidth > bestWidth)) {
      best = rowCount;
      bestError = error;
      bestWidth = regionWidth;
    }
  }
  return best;
}

/**
 * Põe os filhos em linhas abaixo do card do pai (ADR 0067), na ordem, em linhas equilibradas: cada filho ocupa a largura
 * da própria subárvore, cada linha tem a altura do filho mais alto dela, as linhas ficam centralizadas sob o pai e os
 * filhos alinhados pelo topo da linha. Sem `rowCount`, escolhe o número de linhas pela proporção alvo.
 */
function layoutChildren<TNode extends TreeNode>(children: MeasuredNode<TNode>[], width: number, height: number, gap: number, target: number, rowCount?: number): ChildRows {
  const widths = children.map((child) => child.subtreeBounds.maxX - child.subtreeBounds.minX);
  const heights = children.map((child) => child.subtreeBounds.maxY - child.subtreeBounds.minY);
  const chosen = rowCount ?? chooseRowCount(widths, heights, gap, target);
  let regionWidth = 0;
  let maxY = height;
  let rowY = height + gap;
  let start = 0;
  for (const end of rowEnds(children.length, chosen)) {
    let rowWidth = gap * (end - start - 1);
    let rowHeight = 0;
    for (let position = start; position < end; position += 1) {
      rowWidth += widths[position]!;
      rowHeight = Math.max(rowHeight, heights[position]!);
    }
    let slotLeft = -rowWidth / 2;
    for (let position = start; position < end; position += 1) {
      const child = children[position]!;
      const childWidth = widths[position]!;
      child.slotBounds = { minX: slotLeft, maxX: slotLeft + childWidth, minY: rowY, maxY: rowY + rowHeight };
      child.x = slotLeft - child.subtreeBounds.minX;
      child.y = rowY - child.subtreeBounds.minY;
      slotLeft += childWidth + gap;
    }
    regionWidth = Math.max(regionWidth, rowWidth);
    maxY = Math.max(maxY, rowY + rowHeight);
    rowY += rowHeight + gap;
    start = end;
  }
  return {
    rowCount: chosen,
    bounds: {
      minX: Math.min(-width / 2, -regionWidth / 2),
      maxX: Math.max(width / 2, regionWidth / 2),
      minY: 0,
      maxY,
    },
  };
}

function measure<TNode extends TreeNode>(item: TNode, depth: number, index: TreeIndex<TNode>, visited: Set<string>, config: LayoutConfig<TNode>): MeasuredNode<TNode> {
  const size = typeof config.dimensions === "function"
    ? config.dimensions(item, depth)
    : config.dimensions[Math.min(depth, config.dimensions.length - 1)] ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.dimensions[0];
  if (!size) throw new RangeError("Missing node dimensions");
  const { width, height } = validDimensions(size);
  const ownRadius = Math.hypot(width / 2, height / 2);
  if (visited.has(item.id)) {
    return { item, depth, x: 0, y: 0, width, height, subtreeRadius: ownRadius, subtreeBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, slotBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, children: [] };
  }
  const nextVisited = new Set(visited).add(item.id);
  const children = (index.childrenByParentId.get(item.id) ?? []).map((child) => measure(child, depth + 1, index, nextVisited, config));
  if (!children.length) {
    return { item, depth, x: 0, y: 0, width, height, subtreeRadius: ownRadius, subtreeBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, slotBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, children: [] };
  }

  const gap = nonnegative(typeof config.childGap === "function" ? config.childGap(item, depth, ownRadius) : config.childGap ?? Math.max(18, ownRadius * 0.18), "childGap");
  const first = layoutChildren(children, width, height, gap, config.childRegionAspect);
  const rawBounds = first.bounds;
  const rawSubtreeRadius = Math.max(ownRadius, Math.hypot((rawBounds.maxX - rawBounds.minX) / 2, (rawBounds.maxY - rawBounds.minY) / 2));
  const settings = config.normalization;
  const heightAllowance = settings ? Math.max(0, (index.subtreeHeightById.get(item.id) ?? 0) - settings.heightStart) : 0;
  const normalization = settings ? Math.min(1, (ownRadius * (1 + heightAllowance * settings.heightFactor) + heightAllowance * settings.heightPadding) / rawSubtreeRadius) : 1;
  for (const child of children) scaleSubtree(child, normalization);
  // A segunda passada reaproveita a quebra da primeira: a escala muda, a disposição não.
  const subtreeBounds = layoutChildren(children, width, height, Math.max(settings ? settings.minGap : 0, gap * normalization), config.childRegionAspect, first.rowCount).bounds;
  const subtreeRadius = Math.max(ownRadius, Math.hypot((subtreeBounds.maxX - subtreeBounds.minX) / 2, (subtreeBounds.maxY - subtreeBounds.minY) / 2));
  return { item, depth, x: 0, y: 0, width, height, subtreeRadius, subtreeBounds, slotBounds: subtreeBounds, children };
}

function flatten<TNode extends TreeNode>(measured: MeasuredNode<TNode>, offsetX: number, offsetY: number, output: SpatialLayoutNode<TNode>[]) {
  const { children, ...node } = measured;
  const positioned = { ...node, x: node.x + offsetX, y: node.y + offsetY };
  positioned.subtreeBounds = {
    minX: node.subtreeBounds.minX + positioned.x,
    maxX: node.subtreeBounds.maxX + positioned.x,
    minY: node.subtreeBounds.minY + positioned.y,
    maxY: node.subtreeBounds.maxY + positioned.y,
  };
  positioned.slotBounds = {
    minX: node.slotBounds.minX + offsetX,
    maxX: node.slotBounds.maxX + offsetX,
    minY: node.slotBounds.minY + offsetY,
    maxY: node.slotBounds.maxY + offsetY,
  };
  output.push(positioned);
  for (const child of children) flatten(child, positioned.x, positioned.y, output);
}

function boundsFor<TNode extends TreeNode>(nodes: readonly SpatialLayoutNode<TNode>[]): SpatialBounds {
  if (!nodes.length) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return {
    minX: Math.min(...nodes.map((node) => node.x - node.width / 2)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width / 2)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
  };
}

export function buildSpatialLayout<TNode extends TreeNode>(index: TreeIndex<TNode>, options: SpatialLayoutOptions<TNode> = {}): SpatialLayout<TNode> {
  const config = normalizeLayoutOptions(options);
  const measured = (index.childrenByParentId.get(null) ?? []).map((item) => measure(item, 0, index, new Set(), config));
  const nodes: SpatialLayoutNode<TNode>[] = [];
  let offset = 0;
  for (const root of measured) {
    flatten(root, offset - root.subtreeBounds.minX, 0, nodes);
    offset += root.subtreeBounds.maxX - root.subtreeBounds.minX + config.rootGap;
  }
  return {
    nodes,
    nodeById: new Map(nodes.map((node) => [node.item.id, node])),
    bounds: boundsFor(nodes),
    initialBounds: boundsFor(nodes.filter((node) => node.depth <= 2)),
  };
}
