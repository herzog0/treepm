import type { SpatialTreeIndex } from "./spatialIndex.js";
import type { SpatialLayout, SpatialLayoutNode } from "./spatialLayout.js";
import type { SpatialCamera } from "./spatialCameraMotion.js";

export type SpatialLod = "full" | "compact" | "chip" | "dot";

export interface SpatialSceneNode {
  id: string;
  node: SpatialLayoutNode;
  x: number;
  y: number;
  width: number;
  height: number;
  reveal: number;
  opacity: number;
  contentOpacity: number;
  indicatorScale: number;
  lod: SpatialLod;
  aggregate: boolean;
  representation: "indicator" | "card";
}

export interface SpatialIndicatorGroup {
  parentId: string;
  childIds: string[];
  scale: number;
  width: number;
  x: number;
  y: number;
  opacity: number;
}

export interface SpatialSceneRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}

export interface SpatialScene {
  nodes: SpatialSceneNode[];
  groups: SpatialIndicatorGroup[];
  regions: SpatialSceneRegion[];
}

interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Origin in scene output coordinates; defaults to zero. Only affects culling. */
  readonly x?: number;
  readonly y?: number;
}

const INDICATOR_SIZE = 6;
const INDICATOR_GAP = 3;
const MAX_INDIVIDUAL_INDICATORS = 8;
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

interface PreparedNode {
  id: string;
  node: SpatialLayoutNode;
  threshold: number;
  children: { node: PreparedNode | undefined; offset: number }[];
  overflowIds: string[];
  groupWidth: number;
  rowWidth: number;
  groupOffset: number;
}

// Layout/index are immutable snapshots: replacing either prepares fresh geometry.
// Both keys are weak so discarded snapshots and their metadata can be collected.
const preparedByLayout = new WeakMap<SpatialLayout, WeakMap<SpatialTreeIndex, readonly PreparedNode[]>>();

function prepareScene(layout: SpatialLayout, index: SpatialTreeIndex): readonly PreparedNode[] {
  let byIndex = preparedByLayout.get(layout);
  const cached = byIndex?.get(index);
  if (cached) return cached;
  if (!byIndex) {
    byIndex = new WeakMap();
    preparedByLayout.set(layout, byIndex);
  }
  const prepared = new Map<string, PreparedNode>();
  for (const [id, node] of layout.nodeById) {
    const children = index.childrenByParentId.get(node.item.id) ?? [];
    const largestChildWidth = children.reduce((maximum, child) => Math.max(maximum, layout.nodeById.get(child.id)?.width ?? 0), 0);
    const nominalThreshold = node.depth === 0 ? 100 : node.depth === 1 ? 260 : 180;
    // Complete the handoff before even the widest child reaches its readable 140px.
    const threshold = largestChildWidth > 0 ? Math.min(nominalThreshold, node.width / largestChildWidth * 110) : nominalThreshold;
    const individualCount = Math.min(children.length, MAX_INDIVIDUAL_INDICATORS);
    const overflow = children.length - individualCount;
    const groupWidth = overflow > 0 ? Math.max(18, String(overflow).length * 5 + 8) : 0;
    const rowWidth = individualCount * INDICATOR_SIZE + Math.max(0, individualCount - 1) * INDICATOR_GAP + (overflow > 0 ? INDICATOR_GAP + groupWidth : 0);
    const groupOffset = individualCount * (INDICATOR_SIZE + INDICATOR_GAP) + groupWidth / 2 - rowWidth / 2;
    prepared.set(id, { id, node, threshold, children: [], overflowIds: children.slice(individualCount).map((child) => child.id), groupWidth, rowWidth, groupOffset });
  }
  for (const entry of prepared.values()) {
    const children = index.childrenByParentId.get(entry.id) ?? [];
    const individualCount = Math.min(children.length, MAX_INDIVIDUAL_INDICATORS);
    entry.children = children.map((child, childIndex) => ({
      node: prepared.get(child.id),
      offset: childIndex < individualCount
        ? childIndex * (INDICATOR_SIZE + INDICATOR_GAP) + INDICATOR_SIZE / 2 - entry.rowWidth / 2
        : entry.groupOffset,
    }));
  }
  const roots: PreparedNode[] = [];
  for (const root of index.childrenByParentId.get(null) ?? []) {
    const entry = prepared.get(root.id);
    if (entry) roots.push(entry);
  }
  byIndex.set(index, roots);
  return roots;
}

interface ChildFrame {
  parent: SpatialSceneNode;
  reveal: number;
  opacity: number;
  scale: number;
  size: number;
  y: number;
  translationX: number;
  translationY: number;
  growth: number;
  split: number;
}

function inViewport(x: number, y: number, width: number, height: number, viewport: Viewport) {
  const originX = viewport.x ?? 0;
  const originY = viewport.y ?? 0;
  return x + width / 2 >= originX - 100 && x - width / 2 <= originX + viewport.width + 100 && y + height >= originY - 100 && y <= originY + viewport.height + 100;
}

/**
 * One geometric representative per item; camera scale drives the reversible morph.
 * Layout/index are readonly snapshots: rebuild/replace them after topology or
 * geometry changes. Static geometry
 * is cached by both identities; in-place edits do not invalidate that cache.
 * Returned scene arrays are fresh and can be modified independently of the cache.
 * Optional viewport x/y move only the culling window, never the output geometry.
 */
export function buildSpatialScene(layout: SpatialLayout, index: SpatialTreeIndex, camera: SpatialCamera, viewport: Viewport): SpatialScene {
  const nodes: SpatialSceneNode[] = [];
  const groups: SpatialIndicatorGroup[] = [];
  const regions: SpatialSceneRegion[] = [];
  const roots = prepareScene(layout, index);

  const visit = (entry: PreparedNode, frame?: ChildFrame, siblingIndex = 0, offset = 0) => {
    const { id, node, children } = entry;
    const reveal = frame ? frame.reveal : 1;
    const growth = frame ? frame.growth : 1;
    const split = frame && siblingIndex >= MAX_INDIVIDUAL_INDICATORS ? frame.split : 1;
    // Separate the small squares first, then grow them inside their destination regions.
    const width = frame ? lerp(frame.size, node.width * camera.scale, growth) * split : node.width * camera.scale;
    const height = frame ? lerp(frame.size, node.height * camera.scale, growth) * split : node.height * camera.scale;
    const x = frame ? lerp(frame.parent.x + offset * frame.scale, node.x * camera.scale + camera.x, frame.translationX) : node.x * camera.scale + camera.x;
    const y = frame ? lerp(frame.y, node.y * camera.scale + camera.y, frame.translationY) : node.y * camera.scale + camera.y;
    const opacity = frame ? frame.opacity : 1;
    const expansion = smooth((width / entry.threshold - 0.85) / 0.3);
    const lod: SpatialLod = width >= 130 ? "full" : width >= 65 ? "compact" : width >= 28 ? "chip" : "dot";
    const item: SpatialSceneNode = {
      id, node, x, y, width, height, reveal, opacity, lod,
      contentOpacity: growth * smooth((width - 24) / 60),
      indicatorScale: frame ? frame.scale : 1,
      aggregate: children.length > 0 && expansion < 1,
      representation: reveal === 0 ? "indicator" : "card",
    };
    const visible = inViewport(x, y, width, height, viewport);
    // Valid indexed forests visit each ID once, in the same preorder as the layout.
    if (opacity > 0 && width > 0 && height > 0 && visible) nodes.push(item);
    if (frame && reveal > 0 && visible) {
      const bounds = node.slotBounds;
      regions.push({ id, x: bounds.minX * camera.scale + camera.x, y: bounds.minY * camera.scale + camera.y, width: (bounds.maxX - bounds.minX) * camera.scale, height: (bounds.maxY - bounds.minY) * camera.scale, opacity: reveal * opacity });
    }
    // A collapsed square does not recursively draw its descendants. Offscreen
    // parents still project children: their presented positions can be onscreen.
    const preview = opacity * smooth((reveal - 0.7) / 0.3) * smooth((width - 4) / 8);
    if (preview === 0 || children.length === 0) return;
    const indicatorScale = entry.rowWidth > 0 ? Math.min(1, width / entry.rowWidth) : 1;
    const originY = y + height + 5 * indicatorScale;
    const groupSplit = smooth((expansion - 0.25) / 0.5);
    if (entry.overflowIds.length > 0 && groupSplit < 1) {
      const groupX = x + entry.groupOffset * indicatorScale;
      const groupScale = indicatorScale * (1 - groupSplit);
      if (inViewport(groupX, originY, entry.groupWidth * groupScale, 12 * groupScale, viewport)) {
        groups.push({ parentId: id, childIds: entry.overflowIds.slice(), width: entry.groupWidth, scale: groupScale, x: groupX, y: originY, opacity: preview });
      }
    }
    const childFrame: ChildFrame = {
      parent: item,
      reveal: expansion,
      opacity: preview,
      scale: indicatorScale,
      size: INDICATOR_SIZE * indicatorScale,
      y: originY,
      translationX: smooth((expansion - 0.12) / 0.63),
      translationY: smooth(expansion / 0.45),
      growth: smooth((expansion - 0.25) / 0.75),
      split: groupSplit,
    };
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (child?.node) visit(child.node, childFrame, childIndex, child.offset);
    }
  };
  for (const root of roots) visit(root);
  return { nodes, groups, regions };
}
