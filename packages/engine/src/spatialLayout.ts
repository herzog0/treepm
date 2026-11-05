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
}

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
  return { dimensions, rootGap: nonnegative(options.rootGap ?? DEFAULT_SPATIAL_LAYOUT_OPTIONS.rootGap, "rootGap"), childGap: options.childGap, normalization };
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

function layoutChildren<TNode extends TreeNode>(children: MeasuredNode<TNode>[], width: number, height: number, gap: number): SpatialBounds {
  const columns = Math.ceil(Math.sqrt(children.length));
  const rows: MeasuredNode<TNode>[][] = [];
  for (let childIndex = 0; childIndex < children.length; childIndex += columns) rows.push(children.slice(childIndex, childIndex + columns));
  const slotWidth = Math.max(...children.map((child) => child.subtreeBounds.maxX - child.subtreeBounds.minX));
  const slotHeight = Math.max(...children.map((child) => child.subtreeBounds.maxY - child.subtreeBounds.minY));
  let regionWidth = 0;
  let maxY = height;
  let rowY = height + gap;
  for (const row of rows) {
    const rowWidth = slotWidth * row.length + gap * (row.length - 1);
    let slotLeft = -rowWidth / 2;
    for (const child of row) {
      const childWidth = child.subtreeBounds.maxX - child.subtreeBounds.minX;
      child.slotBounds = { minX: slotLeft, maxX: slotLeft + slotWidth, minY: rowY, maxY: rowY + slotHeight };
      child.x = slotLeft + (slotWidth - childWidth) / 2 - child.subtreeBounds.minX;
      child.y = rowY - child.subtreeBounds.minY;
      slotLeft += slotWidth + gap;
    }
    regionWidth = Math.max(regionWidth, rowWidth);
    maxY = Math.max(maxY, rowY + slotHeight);
    rowY += slotHeight + gap;
  }
  return {
    minX: Math.min(-width / 2, -regionWidth / 2),
    maxX: Math.max(width / 2, regionWidth / 2),
    minY: 0,
    maxY,
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
  const rawBounds = layoutChildren(children, width, height, gap);
  const rawSubtreeRadius = Math.max(ownRadius, Math.hypot((rawBounds.maxX - rawBounds.minX) / 2, (rawBounds.maxY - rawBounds.minY) / 2));
  const settings = config.normalization;
  const heightAllowance = settings ? Math.max(0, (index.subtreeHeightById.get(item.id) ?? 0) - settings.heightStart) : 0;
  const normalization = settings ? Math.min(1, (ownRadius * (1 + heightAllowance * settings.heightFactor) + heightAllowance * settings.heightPadding) / rawSubtreeRadius) : 1;
  for (const child of children) scaleSubtree(child, normalization);
  const subtreeBounds = layoutChildren(children, width, height, Math.max(settings ? settings.minGap : 0, gap * normalization));
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
