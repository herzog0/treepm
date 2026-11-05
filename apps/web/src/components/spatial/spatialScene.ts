import type { TreeIndex } from "@treepm/domain";
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
  representation: "indicator" | "ticket";
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

interface Viewport { width: number; height: number }

const INDICATOR_SIZE = 6;
const INDICATOR_GAP = 3;
const MAX_INDIVIDUAL_INDICATORS = 8;
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

function indicatorLayout(parent: SpatialSceneNode, childCount: number) {
  const individualCount = Math.min(childCount, MAX_INDIVIDUAL_INDICATORS);
  const overflow = childCount - individualCount;
  const groupWidth = overflow > 0 ? Math.max(18, String(overflow).length * 5 + 8) : 0;
  const rowWidth = individualCount * INDICATOR_SIZE + Math.max(0, individualCount - 1) * INDICATOR_GAP + (overflow > 0 ? INDICATOR_GAP + groupWidth : 0);
  const scale = rowWidth > 0 ? Math.min(1, parent.width / rowWidth) : 1;
  return { individualCount, overflow, groupWidth, rowWidth, scale };
}

function indicatorSlot(parent: SpatialSceneNode, childIndex: number, childCount: number) {
  const { individualCount, groupWidth, rowWidth, scale } = indicatorLayout(parent, childCount);
  const slotOffset = childIndex < individualCount
    ? childIndex * (INDICATOR_SIZE + INDICATOR_GAP) + INDICATOR_SIZE / 2
    : individualCount * (INDICATOR_SIZE + INDICATOR_GAP) + groupWidth / 2;
  return { x: parent.x + (slotOffset - rowWidth / 2) * scale, y: parent.y + parent.height + 5 * scale, size: INDICATOR_SIZE * scale, scale };
}

function previewOpacity(parent: SpatialSceneNode) {
  return parent.opacity * smooth((parent.reveal - 0.7) / 0.3) * smooth((parent.width - 4) / 8);
}

function inViewport(x: number, y: number, width: number, height: number, viewport: Viewport) {
  return x + width / 2 >= -100 && x - width / 2 <= viewport.width + 100 && y + height >= -100 && y <= viewport.height + 100;
}

/** One geometric representative per ticket; camera scale drives the entire reversible morph. */
export function buildSpatialScene(layout: SpatialLayout, index: TreeIndex, camera: SpatialCamera, viewport: Viewport): SpatialScene {
  const projected = new Map<string, SpatialSceneNode>();
  const groups: SpatialIndicatorGroup[] = [];
  const regions: SpatialSceneRegion[] = [];
  const roots = index.childrenByParentId.get(null) ?? [];
  const childReveal = (node: SpatialLayoutNode, width: number) => {
    const children = index.childrenByParentId.get(node.ticket.id) ?? [];
    const largestChildWidth = children.reduce((maximum, child) => Math.max(maximum, layout.nodeById.get(child.id)?.width ?? 0), 0);
    const nominalThreshold = node.depth === 0 ? 100 : node.depth === 1 ? 260 : 180;
    // Complete the handoff before even the widest child reaches its readable 140px.
    const threshold = largestChildWidth > 0 ? Math.min(nominalThreshold, node.width / largestChildWidth * 110) : nominalThreshold;
    return smooth((width / threshold - 0.85) / 0.3);
  };

  const visit = (id: string, parent?: SpatialSceneNode, siblingIndex = 0, siblingCount = 0) => {
    const node = layout.nodeById.get(id);
    if (!node) return;
    const reveal = parent ? childReveal(parent.node, parent.width) : 1;
    const origin = parent ? indicatorSlot(parent, siblingIndex, siblingCount) : { x: 0, y: 0, size: INDICATOR_SIZE, scale: 1 };
    const grouped = siblingIndex >= MAX_INDIVIDUAL_INDICATORS;
    const split = grouped ? smooth((reveal - 0.25) / 0.5) : 1;
    // Separate the small squares first, then grow them inside their destination regions.
    const translationX = smooth((reveal - 0.12) / 0.63);
    const translationY = smooth(reveal / 0.45);
    const growth = smooth((reveal - 0.25) / 0.75);
    const width = parent ? lerp(origin.size, node.width * camera.scale, growth) * split : node.width * camera.scale;
    const height = parent ? lerp(origin.size, node.height * camera.scale, growth) * split : node.height * camera.scale;
    const x = parent ? lerp(origin.x, node.x * camera.scale + camera.x, translationX) : node.x * camera.scale + camera.x;
    const y = parent ? lerp(origin.y, node.y * camera.scale + camera.y, translationY) : node.y * camera.scale + camera.y;
    const opacity = parent ? previewOpacity(parent) : 1;
    const children = index.childrenByParentId.get(id) ?? [];
    const lod: SpatialLod = width >= 130 ? "full" : width >= 65 ? "compact" : width >= 28 ? "chip" : "dot";
    const item: SpatialSceneNode = {
      id, node, x, y, width, height, reveal, opacity, lod,
      contentOpacity: growth * smooth((width - 24) / 60),
      indicatorScale: origin.scale,
      aggregate: children.length > 0 && childReveal(node, width) < 1,
      representation: reveal === 0 ? "indicator" : "ticket",
    };
    projected.set(id, item);
    if (parent && reveal > 0 && inViewport(x, y, width, height, viewport)) {
      const bounds = node.slotBounds;
      regions.push({ id, x: bounds.minX * camera.scale + camera.x, y: bounds.minY * camera.scale + camera.y, width: (bounds.maxX - bounds.minX) * camera.scale, height: (bounds.maxY - bounds.minY) * camera.scale, opacity: reveal * opacity });
    }
    // A collapsed square does not recursively draw its descendants.
    if (previewOpacity(item) === 0) return;
    const expansion = childReveal(node, width);
    const indicators = indicatorLayout(item, children.length);
    const groupSplit = smooth((expansion - 0.25) / 0.5);
    if (indicators.overflow > 0 && groupSplit < 1) {
      const group = indicatorSlot(item, indicators.individualCount, children.length);
      const groupScale = indicators.scale * (1 - groupSplit);
      if (inViewport(group.x, group.y, indicators.groupWidth * groupScale, 12 * groupScale, viewport)) {
        groups.push({ parentId: id, childIds: children.slice(indicators.individualCount).map((child) => child.id), width: indicators.groupWidth, scale: groupScale, x: group.x, y: group.y, opacity: previewOpacity(item) });
      }
    }
    children.forEach((child, childIndex) => visit(child.id, item, childIndex, children.length));
  };
  roots.forEach((root) => visit(root.id));
  return { nodes: [...projected.values()].filter((item) => item.opacity > 0 && item.width > 0 && item.height > 0 && inViewport(item.x, item.y, item.width, item.height, viewport)), groups, regions };
}
