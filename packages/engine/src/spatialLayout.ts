import type { SpatialItem, SpatialTreeIndex } from "./spatialIndex.js";

export interface SpatialBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface SpatialLayoutNode {
  readonly item: SpatialItem;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly subtreeRadius: number;
  readonly subtreeBounds: SpatialBounds;
  readonly slotBounds: SpatialBounds;
}

export interface SpatialLayout {
  readonly nodes: readonly SpatialLayoutNode[];
  readonly nodeById: ReadonlyMap<string, SpatialLayoutNode>;
  readonly bounds: SpatialBounds;
  readonly initialBounds: SpatialBounds;
}

const WIDTHS = [250, 190, 142, 104, 76, 56, 44, 32, 24, 18];
const HEIGHTS = [142, 108, 82, 62, 46, 34, 28, 22, 16, 12];
const ROOT_GAP = 180;

function dimensions(depth: number) {
  const index = Math.min(depth, WIDTHS.length - 1);
  return { width: WIDTHS[index] ?? 44, height: HEIGHTS[index] ?? 28 };
}

type MutableLayoutNode = { -readonly [Key in keyof SpatialLayoutNode]: SpatialLayoutNode[Key] };

interface MeasuredNode extends MutableLayoutNode {
  children: MeasuredNode[];
}

function scaleSubtree(node: MeasuredNode, factor: number) {
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

function layoutChildren(children: MeasuredNode[], width: number, height: number, gap: number): SpatialBounds {
  const columns = Math.ceil(Math.sqrt(children.length));
  const rows: MeasuredNode[][] = [];
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

function measure(item: SpatialItem, depth: number, index: SpatialTreeIndex, visited: Set<string>): MeasuredNode {
  const { width, height } = dimensions(depth);
  const ownRadius = Math.hypot(width / 2, height / 2);
  if (visited.has(item.id)) {
    return { item, depth, x: 0, y: 0, width, height, subtreeRadius: ownRadius, subtreeBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, slotBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, children: [] };
  }
  const nextVisited = new Set(visited).add(item.id);
  const children = (index.childrenByParentId.get(item.id) ?? []).map((child) => measure(child, depth + 1, index, nextVisited));
  if (!children.length) {
    return { item, depth, x: 0, y: 0, width, height, subtreeRadius: ownRadius, subtreeBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, slotBounds: { minX: -width / 2, maxX: width / 2, minY: 0, maxY: height }, children: [] };
  }

  const gap = Math.max(18, ownRadius * 0.18);
  const rawBounds = layoutChildren(children, width, height, gap);
  const rawSubtreeRadius = Math.max(ownRadius, Math.hypot((rawBounds.maxX - rawBounds.minX) / 2, (rawBounds.maxY - rawBounds.minY) / 2));
  const heightAllowance = Math.max(0, (index.subtreeHeightById.get(item.id) ?? 0) - 6);
  const normalization = Math.min(1, (ownRadius * (1 + heightAllowance * 1.4) + heightAllowance * 40) / rawSubtreeRadius);
  for (const child of children) scaleSubtree(child, normalization);
  const subtreeBounds = layoutChildren(children, width, height, Math.max(0.5, gap * normalization));
  const subtreeRadius = Math.max(ownRadius, Math.hypot((subtreeBounds.maxX - subtreeBounds.minX) / 2, (subtreeBounds.maxY - subtreeBounds.minY) / 2));
  return { item, depth, x: 0, y: 0, width, height, subtreeRadius, subtreeBounds, slotBounds: subtreeBounds, children };
}

function flatten(measured: MeasuredNode, offsetX: number, offsetY: number, output: SpatialLayoutNode[]) {
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

function boundsFor(nodes: SpatialLayoutNode[]): SpatialBounds {
  if (!nodes.length) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return {
    minX: Math.min(...nodes.map((node) => node.x - node.width / 2)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width / 2)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
  };
}

export function buildSpatialLayout(index: SpatialTreeIndex): SpatialLayout {
  const measured = (index.childrenByParentId.get(null) ?? []).map((item) => measure(item, 0, index, new Set()));
  const nodes: SpatialLayoutNode[] = [];
  let offset = 0;
  for (const root of measured) {
    flatten(root, offset - root.subtreeBounds.minX, 0, nodes);
    offset += root.subtreeBounds.maxX - root.subtreeBounds.minX + ROOT_GAP;
  }
  return {
    nodes,
    nodeById: new Map(nodes.map((node) => [node.item.id, node])),
    bounds: boundsFor(nodes),
    initialBounds: boundsFor(nodes.filter((node) => node.depth <= 2)),
  };
}
