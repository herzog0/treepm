import type { TreeIndex, TreeNode } from "./spatialIndex.js";
import type { SpatialLayout, SpatialLayoutNode } from "./spatialLayout.js";
import type { SpatialCamera } from "./spatialCameraMotion.js";
import { normalizeSceneOptions, sceneOptionsKey } from "./spatialSceneOptions.js";
import type { SceneConfig, SpatialSceneOptions } from "./spatialSceneOptions.js";

export type SpatialLod = "full" | "compact" | "chip" | "dot";

export interface SpatialSceneNode<TNode extends TreeNode = TreeNode> {
  id: string;
  node: SpatialLayoutNode<TNode>;
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
  readonly id: string;
  readonly parentId: string;
  readonly childIds: readonly string[];
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

export interface SpatialSceneRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}

export interface SpatialScene<TNode extends TreeNode = TreeNode> {
  nodes: SpatialSceneNode<TNode>[];
  groups: SpatialIndicatorGroup[];
  regions: SpatialSceneRegion[];
}

export interface SpatialViewport {
  readonly width: number;
  readonly height: number;
  /** Origin in scene output coordinates; defaults to zero. Only affects culling. */
  readonly x?: number;
  readonly y?: number;
}

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

interface PreparedBucket {
  readonly id: string;
  readonly childIds: readonly string[];
  readonly offset: number;
}

interface PreparedNode {
  readonly id: string;
  readonly threshold: number;
  readonly layoutPosition: number;
  readonly geometry: Pick<SpatialLayoutNode, "x" | "y" | "width" | "height" | "slotBounds">;
  readonly children: readonly { node: PreparedNode | undefined; offset: number; grouped: boolean }[];
  readonly buckets: readonly PreparedBucket[];
  readonly mergedBuckets: readonly PreparedBucket[];
  readonly rowWidth: number;
}

// Metadata stores no erased consumer payload. Each visit reads its TNode directly
// from the generic layout. Both snapshot keys are weak; configs are scoped to them.
const preparedByLayout = new WeakMap<SpatialLayout, WeakMap<TreeIndex, Map<string, readonly PreparedNode[]>>>();

function prepareScene<TNode extends TreeNode>(layout: SpatialLayout<TNode>, index: TreeIndex<TNode>, config: SceneConfig): readonly PreparedNode[] {
  let byIndex = preparedByLayout.get(layout);
  if (!byIndex) {
    byIndex = new WeakMap();
    preparedByLayout.set(layout, byIndex);
  }
  let byConfig = byIndex.get(index);
  if (!byConfig) {
    byConfig = new Map();
    byIndex.set(index, byConfig);
  }
  const key = sceneOptionsKey(config);
  const cached = byConfig.get(key);
  if (cached) return cached;
  // Internal construction remains mutable; only completed metadata is published.
  type MutablePrepared = { -readonly [Key in keyof PreparedNode]: PreparedNode[Key] };
  const prepared = new Map<string, MutablePrepared>();
  const positions = new Map(layout.nodes.map((node, position) => [node.item.id, position]));
  for (const [id, node] of layout.nodeById) {
    const children = index.childrenByParentId.get(id) ?? [];
    const largestChildWidth = children.reduce((maximum, child) => Math.max(maximum, layout.nodeById.get(child.id)?.width ?? 0), 0);
    const nominalThreshold = node.depth === 0 ? config.rootRevealWidth : node.depth === 1 ? config.childRevealWidth : config.deeperRevealWidth;
    const threshold = largestChildWidth > 0 ? Math.min(nominalThreshold, node.width / largestChildWidth * config.readableChildWidth) : nominalThreshold;
    const slots = Math.min(children.length, config.maxSlots);
    const rowWidth = slots * config.indicatorSize + Math.max(0, slots - 1) * config.indicatorGap;
    const buckets: PreparedBucket[] = [];
    let cursor = 0;
    for (let bucketIndex = 0; bucketIndex < slots; bucketIndex += 1) {
      const count = Math.floor(children.length / slots) + (bucketIndex < children.length % slots ? 1 : 0);
      const childIds = Object.freeze(children.slice(cursor, cursor + count).map((child) => child.id));
      buckets.push({ id: JSON.stringify([id, bucketIndex]), childIds, offset: bucketIndex * (config.indicatorSize + config.indicatorGap) + config.indicatorSize / 2 - rowWidth / 2 });
      cursor += count;
    }
    prepared.set(id, { id, threshold, layoutPosition: positions.get(id) ?? -1, geometry: node, children: [], buckets, mergedBuckets: buckets.filter((bucket) => bucket.childIds.length > 1), rowWidth });
  }
  for (const entry of prepared.values()) {
    entry.children = entry.buckets.flatMap((bucket) => bucket.childIds.map((id) => ({ node: prepared.get(id), offset: bucket.offset, grouped: bucket.childIds.length > 1 })));
  }
  const roots: PreparedNode[] = [];
  for (const root of index.childrenByParentId.get(null) ?? []) {
    const entry = prepared.get(root.id);
    if (entry) roots.push(entry);
  }
  // Parameter controls may produce indefinitely many values for the same tree.
  // Bound retained preparations without changing scene geometry or visibility.
  if (byConfig.size >= 16) {
    const oldest = byConfig.keys().next().value;
    if (oldest !== undefined) byConfig.delete(oldest);
  }
  byConfig.set(key, roots);
  return roots;
}

interface ChildFrame {
  x: number;
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

function inViewport(x: number, y: number, width: number, height: number, viewport: SpatialViewport, margin: number) {
  const originX = viewport.x ?? 0;
  const originY = viewport.y ?? 0;
  return x + width / 2 >= originX - margin && x - width / 2 <= originX + viewport.width + margin && y + height >= originY - margin && y <= originY + viewport.height + margin;
}

/**
 * One geometric representative per item; camera scale drives the reversible morph.
 * Layout/index are readonly snapshots: rebuild/replace them after topology or
 * geometry changes. Static geometry is cached by both identities and config values; in-place edits do not invalidate that cache.
 * Scene collections are fresh; group membership is immutable and shared by cache.
 * Optional viewport x/y move only the culling window, never the output geometry.
 */
export function buildSpatialScene<TNode extends TreeNode>(layout: SpatialLayout<TNode>, index: TreeIndex<TNode>, camera: SpatialCamera, viewport: SpatialViewport, options?: SpatialSceneOptions): SpatialScene<TNode> {
  const config = normalizeSceneOptions(options);
  const nodes: SpatialSceneNode<TNode>[] = [];
  const groups: SpatialIndicatorGroup[] = [];
  const regions: SpatialSceneRegion[] = [];
  const roots = prepareScene(layout, index, config);

  const { revealStart, revealRange, fullWidth, compactWidth, chipWidth, contentMinWidth, contentWidthRange, cullingMargin, previewStart, previewRange, previewMinWidth, previewWidthRange, indicatorOffsetY, splitStart, splitRange, indicatorSize, translationXStart, translationXRange, translationYRange, growthStart, growthRange } = config;

  const visit = (entry: PreparedNode, frame?: ChildFrame, grouped = false, offset = 0) => {
    const { id, children } = entry;
    const node = entry.geometry;
    const reveal = frame ? frame.reveal : 1;
    const growth = frame ? frame.growth : 1;
    const split = frame && grouped ? frame.split : 1;
    // Separate the small squares first, then grow them inside their destination regions.
    const width = frame ? lerp(frame.size, node.width * camera.scale, growth) * split : node.width * camera.scale;
    const height = frame ? lerp(frame.size, node.height * camera.scale, growth) * split : node.height * camera.scale;
    const x = frame ? lerp(frame.x + offset * frame.scale, node.x * camera.scale + camera.x, frame.translationX) : node.x * camera.scale + camera.x;
    const y = frame ? lerp(frame.y, node.y * camera.scale + camera.y, frame.translationY) : node.y * camera.scale + camera.y;
    const opacity = frame ? frame.opacity : 1;
    const expansion = children.length > 0 ? smooth((width / entry.threshold - revealStart) / revealRange) : 1;
    const visible = inViewport(x, y, width, height, viewport, cullingMargin);
    // Offscreen representatives still drive descendants, but need no output body.
    if (opacity > 0 && width > 0 && height > 0 && visible) {
      const source = layout.nodes[entry.layoutPosition] ?? layout.nodeById.get(id);
      if (source) nodes.push({
        id, node: source, x, y, width, height, reveal, opacity,
        lod: width >= fullWidth ? "full" : width >= compactWidth ? "compact" : width >= chipWidth ? "chip" : "dot",
        contentOpacity: growth * smooth((width - contentMinWidth) / contentWidthRange),
        indicatorScale: frame ? frame.scale : 1,
        aggregate: children.length > 0 && expansion < 1,
        representation: reveal === 0 ? "indicator" : "card",
      });
    }
    if (frame && reveal > 0 && visible) {
      const bounds = node.slotBounds;
      const regionX = bounds.minX * camera.scale + camera.x;
      const regionY = bounds.minY * camera.scale + camera.y;
      const regionWidth = (bounds.maxX - bounds.minX) * camera.scale;
      const regionHeight = (bounds.maxY - bounds.minY) * camera.scale;
      const originX = viewport.x ?? 0;
      const originY = viewport.y ?? 0;
      // A morphing body may be onscreen while its destination slot is offscreen.
      // Keep the original body predicate and also cull by the slot's own rectangle.
      if (regionX + regionWidth >= originX - cullingMargin && regionX <= originX + viewport.width + cullingMargin
        && regionY + regionHeight >= originY - cullingMargin && regionY <= originY + viewport.height + cullingMargin) {
        regions.push({ id, x: regionX, y: regionY, width: regionWidth, height: regionHeight, opacity: reveal * opacity });
      }
    }
    // A collapsed square does not recursively draw its descendants. Offscreen
    // parents still project children: their presented positions can be onscreen.
    if (children.length === 0) return;
    const preview = opacity * smooth((reveal - previewStart) / previewRange) * smooth((width - previewMinWidth) / previewWidthRange);
    if (preview === 0) return;
    const indicatorScale = entry.rowWidth > 0 ? Math.min(1, width / entry.rowWidth) : 1;
    const originY = y + height + indicatorOffsetY * indicatorScale;
    const groupSplit = entry.mergedBuckets.length > 0 ? smooth((expansion - splitStart) / splitRange) : 1;
    if (groupSplit < 1) {
      for (const bucket of entry.mergedBuckets) {
        const groupX = x + bucket.offset * indicatorScale;
        const groupScale = indicatorScale * (1 - groupSplit);
        if (inViewport(groupX, originY, indicatorSize * groupScale, indicatorSize * groupScale, viewport, cullingMargin)) {
          groups.push({ id: bucket.id, parentId: id, childIds: bucket.childIds, width: indicatorSize, height: indicatorSize, scale: groupScale, x: groupX, y: originY, opacity: preview });
        }
      }
    }
    const childFrame: ChildFrame = {
      x,
      reveal: expansion,
      opacity: preview,
      scale: indicatorScale,
      size: indicatorSize * indicatorScale,
      y: originY,
      translationX: smooth((expansion - translationXStart) / translationXRange),
      translationY: smooth(expansion / translationYRange),
      growth: smooth((expansion - growthStart) / growthRange),
      split: groupSplit,
    };
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (child?.node) visit(child.node, childFrame, child.grouped, child.offset);
    }
  };
  for (const root of roots) visit(root);
  return { nodes, groups, regions };
}
