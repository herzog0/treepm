import type { LeafStatusCounts, Ticket, TreeIndex, tidyTreeLayout } from "@treepm/domain";

export interface SemanticCamera { x: number; y: number; zoom: number; scale: number }
export type SemanticCardKind = "full" | "compact" | "chip" | "dot" | "summary";
export type SemanticVisualStatus = Ticket["status"] | "not_started" | "active" | "mixed";
export interface SemanticChildIndicator {
  id: string;
  ticketIds: string[];
  visualStatus: SemanticVisualStatus;
  statusColor: string;
  opacity: number;
}
export interface FocusTransition {
  fromId: string;
  toId: string;
  progress: number;
  fromScene?: SemanticSceneNode[];
}
type Layout = ReturnType<typeof tidyTreeLayout>;
type LayoutNode = Layout["nodes"][number];
type LeafCounts = LeafStatusCounts;
interface SubtreeInfo { ticketCount: number; leaves: LeafCounts }
interface SceneItem {
  node: LayoutNode;
  kind: SemanticCardKind;
  width?: number;
  height?: number;
  opacity?: number;
  aggregate?: boolean;
  representedCount?: number;
  aggregateDoneLeaves?: number;
  aggregateTotalLeaves?: number;
  visualStatus?: SemanticVisualStatus;
  statusColor?: string;
  subtreeHeight?: number;
  childIndicators?: SemanticChildIndicator[];
  indicatorSize?: number;
  compactLabel?: boolean;
}
interface ScenePosition { x: number; y: number }
interface SceneBounds { min: number; max: number }
interface LayoutLookup {
  nodeById: ReadonlyMap<string, LayoutNode>;
  orderById: ReadonlyMap<string, number>;
}
const layoutLookups = new WeakMap<Layout, LayoutLookup>();
function getLayoutLookup(layout: Layout): LayoutLookup {
  const cached = layoutLookups.get(layout);
  if (cached) return cached;
  const lookup = {
    nodeById: new Map(layout.nodes.map((node) => [node.ticket.id, node])),
    orderById: new Map(layout.nodes.map((node, index) => [node.ticket.id, index])),
  };
  layoutLookups.set(layout, lookup);
  return lookup;
}
const childrenIn = (index: TreeIndex, parentId: string | null) => index.childrenByParentId.get(parentId) ?? [];

export interface SemanticSceneNode extends SceneItem {
  position: ScenePosition;
  width: number;
  height: number;
  layoutWidth: number;
  layoutHeight: number;
  opacity: number;
  aggregate: boolean;
  representedCount: number;
  aggregateDoneLeaves: number;
  aggregateTotalLeaves: number;
  visualStatus: SemanticVisualStatus;
  statusColor: string;
  subtreeHeight: number;
  childIndicators: SemanticChildIndicator[];
  indicatorSize: number;
  compactLabel: boolean;
}

interface WheelAnchorTicket {
  ticketId: string;
  relativeX: number;
  relativeY: number;
}

interface WheelAnchorLocal {
  ticketId: string;
  relativeX: number;
  relativeY: number;
  offsetX: number;
  offsetY: number;
  ancestors: string[];
}

export interface WheelAnchor {
  cursorX: number;
  cursorY: number;
  sceneX: number;
  sceneY: number;
  kind: "card" | "indicator" | "scene";
  sourceNodePresent: boolean;
  ticketId: string | null;
  relativeX: number;
  relativeY: number;
  fallbacks: WheelAnchorTicket[];
  local?: WheelAnchorLocal;
}

export const SEMANTIC_CARD_SIZES: Record<SemanticCardKind, { width: number; height: number }> = {
  full: { width: 246, height: 142 },
  compact: { width: 198, height: 118 },
  chip: { width: 122, height: 54 },
  dot: { width: 18, height: 18 },
  summary: { width: 220, height: 112 },
};

export const CLICK_SEMANTIC_ZOOM = 1.04;
const INDICATOR_SLOT = 20;
const INDICATOR_GAP = 4;
const INDICATOR_TOP_GAP = 8;
const INDICATOR_BORDER_BOTTOM = 1;
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const sizeFor = (item: SceneItem) => ({
  width: item.width ?? SEMANTIC_CARD_SIZES[item.kind].width,
  height: item.height ?? SEMANTIC_CARD_SIZES[item.kind].height,
});
const layoutSizeFor = (item: SceneItem) => {
  const size = sizeFor(item);
  const count = item.childIndicators?.length ?? 0;
  if (!count) return size;
  return {
    width: Math.max(size.width, count * INDICATOR_SLOT + (count - 1) * INDICATOR_GAP),
    height: size.height + INDICATOR_TOP_GAP + INDICATOR_SLOT,
  };
};
const STATUS_COLORS: Record<SemanticVisualStatus, string> = {
  todo: "#625b70",
  not_started: "#625b70",
  in_progress: "#b3263a",
  active: "#b3263a",
  done: "#16734a",
  mixed: "#a65400",
};
const emptyLeaves = (): LeafCounts => ({ todo: 0, in_progress: 0, done: 0 });
const addLeaves = (target: LeafCounts, source: LeafCounts) => {
  target.todo += source.todo;
  target.in_progress += source.in_progress;
  target.done += source.done;
};
const leafTotal = (leaves: LeafCounts) => leaves.todo + leaves.in_progress + leaves.done;
const statusForLeaves = (leaves: LeafCounts): SemanticVisualStatus => {
  const present = (["todo", "in_progress", "done"] as const).filter((status) => leaves[status] > 0);
  return present.length === 1 ? present[0] ?? "mixed" : "mixed";
};
const regularStatus = (ticket: Ticket, info: SubtreeInfo): SemanticVisualStatus => {
  if (info.ticketCount === 1) return ticket.status;
  if (info.leaves.done === leafTotal(info.leaves)) return "done";
  return info.leaves.in_progress + info.leaves.done > 0 ? "active" : "not_started";
};
const mixColor = (from: string, to: string, progress: number) => {
  const channels = [1, 3, 5].map((offset) => Math.round(lerp(Number.parseInt(from.slice(offset, offset + 2), 16), Number.parseInt(to.slice(offset, offset + 2), 16), progress)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

interface MeasuredSceneNode extends SceneBounds {
  item: SceneItem;
  x: number;
  children: { node: MeasuredSceneNode; offset: number; min: number; max: number }[];
}

function layoutScene(items: SceneItem[], zoom: number, viewportWidth: number) {
  const itemById = new Map(items.map((item) => [item.node.ticket.id, item]));
  const visibleChildren = new Map<string, SceneItem[]>();
  const roots: SceneItem[] = [];
  for (const item of items) {
    const parentId = item.node.ticket.parentId;
    if (!parentId || !itemById.has(parentId)) {
      roots.push(item);
      continue;
    }
    const siblings = visibleChildren.get(parentId) ?? [];
    siblings.push(item);
    visibleChildren.set(parentId, siblings);
  }

  const layoutForest = (gap: number) => {
    const measureSubtree = (item: SceneItem): MeasuredSceneNode => {
      const children = visibleChildren.get(item.node.ticket.id) ?? [];
      const measuredChildren: MeasuredSceneNode["children"] = [];
      let right = 0;
      children.forEach((child, index) => {
        const measured = measureSubtree(child);
        const previous = children[index - 1];
        const separatesBranches = previous && ((visibleChildren.get(previous.node.ticket.id)?.length ?? 0) > 0 || (visibleChildren.get(child.node.ticket.id)?.length ?? 0) > 0);
        const offset = index === 0 ? -measured.min : right - measured.min + gap + (separatesBranches ? 8 : 0);
        const min = measured.min + offset;
        const max = measured.max + offset;
        right = max;
        measuredChildren.push({ node: measured, offset, min, max });
      });
      const firstChild = measuredChildren[0];
      const lastChild = measuredChildren[measuredChildren.length - 1];
      const firstX = firstChild ? firstChild.node.x + firstChild.offset : 0;
      const lastX = lastChild ? lastChild.node.x + lastChild.offset : 0;
      const x = (firstX + lastX) / 2;
      const { width } = layoutSizeFor(item);
      let min = x - width / 2;
      let max = x + width / 2;
      for (const child of measuredChildren) {
        min = Math.min(min, child.min);
        max = Math.max(max, child.max);
      }
      return { item, x, children: measuredChildren, min, max };
    };

    const positions = new Map<string, ScenePosition>();
    const placeSubtree = (measured: MeasuredSceneNode, offset: number) => {
      positions.set(measured.item.node.ticket.id, { x: measured.x + offset, y: 0 });
      for (const child of measured.children) placeSubtree(child.node, offset + child.offset);
    };
    const forestBounds: SceneBounds[] = [];
    let right = 0;
    roots.forEach((root, index) => {
      const measured = measureSubtree(root);
      const offset = index === 0 ? -measured.min : right - measured.min + gap + 8;
      placeSubtree(measured, offset);
      const bounds = { min: measured.min + offset, max: measured.max + offset };
      right = bounds.max;
      forestBounds.push(bounds);
    });
    return {
      positions,
      width: Math.max(0, ...forestBounds.map((bounds) => bounds.max)) - Math.min(0, ...forestBounds.map((bounds) => bounds.min)),
    };
  };

  const minimum = layoutForest(18);
  const freePerConnection = (viewportWidth - 80 - minimum.width) / Math.max(1, items.length - 1);
  const zoomProgress = Math.min(1, Math.max(0, (zoom - 0.5) / 0.9));
  const gap = 18 + Math.min(12, 4 + zoomProgress * 8, Math.max(0, freePerConnection));
  const { positions } = gap === 18 ? minimum : layoutForest(gap);
  const firstRootX = roots[0] ? positions.get(roots[0].node.ticket.id)?.x ?? 0 : 0;
  const levelHeights = new Map<number, number>();
  for (const item of items) {
    const depth = item.node.depth;
    levelHeights.set(depth, Math.max(levelHeights.get(depth) ?? 0, layoutSizeFor(item).height));
  }
  const levelTops = new Map<number, number>();
  const verticalGap = 28 + zoomProgress * 8;
  let top = 0;
  const maxDepth = Math.max(0, ...items.map((item) => item.node.depth));
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    levelTops.set(depth, top);
    top += (levelHeights.get(depth) ?? 0) + verticalGap;
  }
  return items.map((item): SemanticSceneNode => {
    const position = positions.get(item.node.ticket.id) ?? { x: 0, y: 0 };
    const size = sizeFor(item);
    const layoutSize = layoutSizeFor(item);
    return {
      ...item,
      ...size,
      layoutWidth: layoutSize.width,
      layoutHeight: layoutSize.height,
      opacity: item.opacity ?? 1,
      aggregate: item.aggregate ?? false,
      representedCount: item.representedCount ?? 1,
      aggregateDoneLeaves: item.aggregateDoneLeaves ?? 0,
      aggregateTotalLeaves: item.aggregateTotalLeaves ?? 0,
      visualStatus: item.visualStatus ?? "not_started",
      statusColor: item.statusColor ?? STATUS_COLORS.not_started,
      subtreeHeight: item.subtreeHeight ?? 0,
      childIndicators: item.childIndicators ?? [],
      indicatorSize: item.indicatorSize ?? 10,
      compactLabel: item.compactLabel ?? false,
      position: {
        x: viewportWidth / 2 + position.x - firstRootX,
        y: 28 + (levelTops.get(item.node.depth) ?? 0),
      },
    };
  });
}

function focusScene(layout: Layout, index: TreeIndex, focusId: string, zoom: number, viewportWidth: number) {
  const { nodeById, orderById } = getLayoutLookup(layout);
  const roots = childrenIn(index, null);
  const focus = index.ticketById.get(focusId) ?? roots[0] ?? index.ticketById.values().next().value;
  if (!focus) return [];
  const infoFor = (id: string): SubtreeInfo => ({
    ticketCount: index.subtreeCountById.get(id) ?? 1,
    leaves: index.leafCountsById.get(id) ?? emptyLeaves(),
  });
  const compactLabel = zoom <= CLICK_SEMANTIC_ZOOM + 1e-9;
  const makeItem = (node: LayoutNode, kind: SemanticCardKind, hiddenInfos: SubtreeInfo[] = [], dimensions?: { width: number; height: number }): SceneItem => {
    const ownInfo = infoFor(node.ticket.id);
    const hidden: SubtreeInfo = { ticketCount: 0, leaves: emptyLeaves() };
    for (const info of hiddenInfos) {
      hidden.ticketCount += info.ticketCount;
      addLeaves(hidden.leaves, info.leaves);
    }
    const aggregate = hidden.ticketCount > 0;
    const visualStatus = aggregate ? statusForLeaves(hidden.leaves) : regularStatus(node.ticket, ownInfo);
    return {
      node,
      kind: compactLabel && kind !== "dot" ? "chip" : kind,
      ...(compactLabel && kind !== "dot" ? {} : dimensions),
      aggregate,
      representedCount: 1 + hidden.ticketCount,
      aggregateDoneLeaves: hidden.leaves.done,
      aggregateTotalLeaves: leafTotal(hidden.leaves),
      visualStatus,
      statusColor: STATUS_COLORS[visualStatus],
      subtreeHeight: index.subtreeHeightById.get(node.ticket.id) ?? 0,
      compactLabel,
    };
  };

  const path: Ticket[] = [];
  let current: Ticket | undefined = focus;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? index.ticketById.get(current.parentId) : undefined;
  }
  const pathIds = new Set(path.map((ticket) => ticket.id));
  const lateralSummaries = new Set<string>();
  for (const ancestor of path) {
    for (const sibling of childrenIn(index, ancestor.parentId)) {
      if (!pathIds.has(sibling.id)) lateralSummaries.add(sibling.id);
    }
  }
  for (const root of roots) if (!pathIds.has(root.id)) lateralSummaries.add(root.id);

  const compaction = Math.max(0, (1.4 - zoom) / 0.12);
  const visit = (node: LayoutNode): { items: SceneItem[]; collapsed?: SubtreeInfo } => {
    const ownInfo = infoFor(node.ticket.id);
    const phase = Math.round((compaction - (index.subtreeHeightById.get(node.ticket.id) ?? 0)) * 1e9) / 1e9;
    if (node.ticket.id !== focus.id && phase >= 4) return { items: [], collapsed: ownInfo };
    const childResults = childrenIn(index, node.ticket.id).flatMap((child) => {
      const childNode = nodeById.get(child.id);
      return childNode ? [visit(childNode)] : [];
    });
    let kind: SemanticCardKind = phase >= 3 ? "dot" : phase >= 2 ? "chip" : phase >= 1 ? "compact" : "full";
    let dimensions: { width: number; height: number } | undefined;
    if (node.ticket.id === focus.id) kind = "full";
    else if (phase > 0 && phase < 3) {
      const kinds = ["full", "compact", "chip", "dot"] as const;
      const index = Math.floor(phase);
      const from = SEMANTIC_CARD_SIZES[kinds[index] ?? "dot"];
      const to = SEMANTIC_CARD_SIZES[kinds[index + 1] ?? "dot"];
      const fraction = phase - index;
      dimensions = { width: lerp(from.width, to.width, fraction), height: lerp(from.height, to.height, fraction) };
    }
    const hidden = childResults.flatMap((result) => result.collapsed ? [result.collapsed] : []);
    return { items: [{ ...makeItem(node, kind, hidden, dimensions) }, ...childResults.flatMap((result) => result.items)] };
  };
  const focusNode = nodeById.get(focus.id);
  const items: SceneItem[] = [];
  for (const ticket of path) {
    if (ticket.id === focus.id) continue;
    const node = nodeById.get(ticket.id);
    if (node) items.push(makeItem(node, zoom < 0.66 ? "chip" : "compact"));
  }
  if (focusNode) items.push(...visit(focusNode).items);
  for (const id of lateralSummaries) {
    const node = nodeById.get(id);
    if (!node || pathIds.has(id)) continue;
    const hidden = childrenIn(index, id).map((child) => infoFor(child.id));
    items.push(makeItem(node, "summary", hidden));
  }
  const itemById = new Map(items.map((item) => [item.node.ticket.id, item]));
  for (const item of items) {
    const parentId = item.node.ticket.id;
    const indicators = childrenIn(index, parentId).flatMap((child): SemanticChildIndicator[] => {
      const childItem = itemById.get(child.id);
      const leaves = index.leafCountsById.get(child.id);
      if (!leaves) return [];
      const visualStatus = childItem?.visualStatus ?? statusForLeaves(leaves);
      return [{
        id: child.id,
        ticketIds: [child.id],
        visualStatus,
        statusColor: STATUS_COLORS[visualStatus],
        opacity: 1,
      }];
    });
    if (indicators.length <= 8) item.childIndicators = indicators;
    else {
      const groups = new Map<SemanticVisualStatus, string[]>();
      for (const indicator of indicators.slice(6)) {
        const ids = groups.get(indicator.visualStatus) ?? [];
        ids.push(...indicator.ticketIds);
        groups.set(indicator.visualStatus, ids);
      }
      item.childIndicators = [
        ...indicators.slice(0, 6),
        ...[...groups.entries()].map(([visualStatus, ticketIds]) => ({
          id: `${parentId}:children:${visualStatus}`,
          ticketIds,
          visualStatus,
          statusColor: STATUS_COLORS[visualStatus],
          opacity: 1,
        })),
      ];
    }
    item.indicatorSize = item.kind === "dot" ? 6 : 10;
  }
  items.sort((a, b) => (orderById.get(a.node.ticket.id) ?? 0) - (orderById.get(b.node.ticket.id) ?? 0));
  return layoutScene(items, zoom, viewportWidth);
}

function blendScenes(layout: Layout, from: SemanticSceneNode[], to: SemanticSceneNode[], progress: number, zoom: number, viewportWidth: number) {
  const fromById = new Map(from.map((item) => [item.node.ticket.id, item]));
  const toById = new Map(to.map((item) => [item.node.ticket.id, item]));
  const { orderById } = getLayoutLookup(layout);
  const ids = new Set([...fromById.keys(), ...toById.keys()]);
  const orderedIds = [...ids].sort((a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0));
  const dot = SEMANTIC_CARD_SIZES.dot;
  const items = orderedIds.flatMap((id): SceneItem[] => {
    const source = fromById.get(id);
    const target = toById.get(id);
    const layoutNode = source?.node ?? target?.node;
    if (!layoutNode) return [];
    const startKind = source?.kind ?? "dot";
    const endKind = target?.kind ?? "dot";
    const presentation = progress < 0.5 ? source ?? target : target ?? source;
    const startColor = source?.statusColor ?? target?.statusColor ?? STATUS_COLORS.not_started;
    const endColor = target?.statusColor ?? startColor;
    const sourceIndicators = new Map((source?.childIndicators ?? []).map((indicator) => [indicator.id, indicator]));
    const targetIndicators = new Map((target?.childIndicators ?? []).map((indicator) => [indicator.id, indicator]));
    const indicatorIds = new Set([...sourceIndicators.keys(), ...targetIndicators.keys()]);
    const childIndicators = [...indicatorIds].flatMap((indicatorId): SemanticChildIndicator[] => {
      const start = sourceIndicators.get(indicatorId);
      const end = targetIndicators.get(indicatorId);
      const current = progress < 0.5 ? start ?? end : end ?? start;
      if (!current) return [];
      return [{
        ...current,
        statusColor: mixColor(start?.statusColor ?? end?.statusColor ?? STATUS_COLORS.not_started, end?.statusColor ?? start?.statusColor ?? STATUS_COLORS.not_started, progress),
        opacity: lerp(start?.opacity ?? 0, end?.opacity ?? 0, progress),
      }];
    });
    return [{
      node: layoutNode,
      kind: progress < 0.5 ? startKind : endKind,
      width: lerp(source?.width ?? dot.width, target?.width ?? dot.width, progress),
      height: lerp(source?.height ?? dot.height, target?.height ?? dot.height, progress),
      opacity: lerp(source?.opacity ?? 0, target?.opacity ?? 0, progress),
      aggregate: presentation?.aggregate,
      representedCount: presentation?.representedCount,
      aggregateDoneLeaves: presentation?.aggregateDoneLeaves,
      aggregateTotalLeaves: presentation?.aggregateTotalLeaves,
      visualStatus: presentation?.visualStatus,
      statusColor: mixColor(startColor, endColor, progress),
      subtreeHeight: presentation?.subtreeHeight,
      childIndicators,
      indicatorSize: lerp(source?.indicatorSize ?? target?.indicatorSize ?? 6, target?.indicatorSize ?? source?.indicatorSize ?? 6, progress),
      compactLabel: presentation?.compactLabel,
    }];
  });
  return layoutScene(items, zoom, viewportWidth);
}

export function blendSemanticScenes(layout: Layout, from: SemanticSceneNode[], to: SemanticSceneNode[], progress: number, zoom: number, viewportWidth: number) {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  return blendScenes(layout, from, to, progress, zoom, viewportWidth);
}

export function createSemanticScene(layout: Layout, index: TreeIndex, focusId: string, transition: FocusTransition | null, zoom: number, viewportWidth: number) {
  if (!transition || (transition.fromId === transition.toId && !transition.fromScene)) return focusScene(layout, index, focusId, zoom, viewportWidth);
  if (transition.progress <= 0 && transition.fromScene) return transition.fromScene;
  if (transition.progress <= 0) return focusScene(layout, index, focusId, zoom, viewportWidth);
  if (transition.progress >= 1) return focusScene(layout, index, transition.toId, zoom, viewportWidth);
  const from = transition.fromScene ?? focusScene(layout, index, transition.fromId, zoom, viewportWidth);
  const to = focusScene(layout, index, transition.toId, zoom, viewportWidth);
  return blendSemanticScenes(layout, from, to, transition.progress, zoom, viewportWidth);
}

export function semanticChildIndicatorPoint(parent: SemanticSceneNode, indicator: SemanticChildIndicator) {
  const index = parent.childIndicators.findIndex((item) => item.id === indicator.id);
  const count = parent.childIndicators.length;
  const rowWidth = count * INDICATOR_SLOT + Math.max(0, count - 1) * INDICATOR_GAP;
  return {
    x: parent.position.x - rowWidth / 2 + Math.max(0, index) * (INDICATOR_SLOT + INDICATOR_GAP) + INDICATOR_SLOT / 2,
    y: parent.position.y + parent.height - INDICATOR_BORDER_BOTTOM + INDICATOR_TOP_GAP + INDICATOR_SLOT / 2,
  };
}

const indicatorPoint = (parent: SemanticSceneNode, indicator: SemanticChildIndicator, reference: WheelAnchorTicket) => {
  const center = semanticChildIndicatorPoint(parent, indicator);
  return {
    x: center.x + (reference.relativeX - 0.5) * parent.indicatorSize,
    y: center.y + (reference.relativeY - 0.5) * parent.indicatorSize,
  };
};

const indicatorLocation = (nodes: SemanticSceneNode[], ticketId: string | null) => {
  if (!ticketId) return undefined;
  for (const parent of nodes) {
    const indicator = parent.childIndicators.find((item) => item.ticketIds.includes(ticketId));
    if (indicator) return { parent, indicator };
  }
  return undefined;
};

const localPoint = (node: SemanticSceneNode, reference: WheelAnchorLocal) => ({
  x: node.position.x - node.width / 2 + reference.relativeX * node.width + reference.offsetX,
  y: node.position.y + reference.relativeY * node.height + reference.offsetY,
});

const localIndicatorPoint = (parent: SemanticSceneNode, indicator: SemanticChildIndicator, reference: WheelAnchorLocal) => {
  const center = semanticChildIndicatorPoint(parent, indicator);
  return {
    x: center.x + (reference.relativeX - 0.5) * parent.indicatorSize + reference.offsetX,
    y: center.y + (reference.relativeY - 0.5) * parent.indicatorSize + reference.offsetY,
  };
};

export function captureWheelAnchor(clientX: number, clientY: number, stage: DOMRect, camera: SemanticCamera, nodes: SemanticSceneNode[], ticketId: string | null, preferIndicator = false): WheelAnchor {
  const cursorX = clientX - stage.left;
  const cursorY = clientY - stage.top;
  const sceneX = (cursorX - camera.x) / camera.scale;
  const sceneY = (cursorY - camera.y) / camera.scale;
  const item = ticketId && !preferIndicator ? nodes.find((node) => node.node.ticket.id === ticketId) : undefined;
  const indicator = item ? undefined : indicatorLocation(nodes, ticketId);
  const sourceNodePresent = ticketId ? nodes.some((node) => node.node.ticket.id === ticketId && node.opacity > 0) : false;
  const relative = (node: SemanticSceneNode): Omit<WheelAnchorTicket, "ticketId"> => ({
    relativeX: node.width > 0 ? (sceneX - node.position.x + node.width / 2) / node.width : 0,
    relativeY: node.height > 0 ? (sceneY - node.position.y) / node.height : 0,
  });
  const indicatorRelative = indicator ? {
    relativeX: (sceneX - semanticChildIndicatorPoint(indicator.parent, indicator.indicator).x) / indicator.parent.indicatorSize + 0.5,
    relativeY: (sceneY - semanticChildIndicatorPoint(indicator.parent, indicator.indicator).y) / indicator.parent.indicatorSize + 0.5,
  } : { relativeX: 0, relativeY: 0 };
  const fallbacks: WheelAnchorTicket[] = [];
  const visited = new Set<string>();
  let parentId: string | null | undefined = item?.node.ticket.parentId ?? indicator?.parent.node.ticket.id;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((node) => node.node.ticket.id === parentId);
    if (!parent) break;
    fallbacks.push({ ticketId: parentId, ...relative(parent) });
    parentId = parent.node.ticket.parentId;
  }
  let local: WheelAnchorLocal | undefined;
  if (!item && !indicator) {
    let nearest: { node: SemanticSceneNode; x: number; y: number; distance: number } | undefined;
    for (const node of nodes) {
      if (node.opacity < 0.05 || node.width <= 0 || node.height <= 0) continue;
      const left = node.position.x - node.width / 2;
      const right = left + node.width;
      const top = node.position.y;
      const bottom = top + node.height;
      const x = Math.min(right, Math.max(left, sceneX));
      const y = Math.min(bottom, Math.max(top, sceneY));
      const distance = Math.hypot(sceneX - x, sceneY - y);
      if (distance <= 48 / camera.scale && (!nearest || distance < nearest.distance)) nearest = { node, x, y, distance };
    }
    if (nearest) {
      const ancestors: string[] = [];
      let ancestorId = nearest.node.node.ticket.parentId;
      while (ancestorId && !ancestors.includes(ancestorId)) {
        ancestors.push(ancestorId);
        ancestorId = nodes.find((node) => node.node.ticket.id === ancestorId)?.node.ticket.parentId ?? null;
      }
      local = {
        ticketId: nearest.node.node.ticket.id,
        relativeX: (nearest.x - nearest.node.position.x + nearest.node.width / 2) / nearest.node.width,
        relativeY: (nearest.y - nearest.node.position.y) / nearest.node.height,
        offsetX: sceneX - nearest.x,
        offsetY: sceneY - nearest.y,
        ancestors,
      };
    }
  }
  return {
    cursorX,
    cursorY,
    sceneX,
    sceneY,
    kind: indicator ? "indicator" : item ? "card" : "scene",
    sourceNodePresent,
    ticketId: item || indicator ? ticketId : null,
    relativeX: item ? relative(item).relativeX : indicatorRelative.relativeX,
    relativeY: item ? relative(item).relativeY : indicatorRelative.relativeY,
    fallbacks,
    local,
  };
}

export function cameraForAnchor(anchor: WheelAnchor, nodes: SemanticSceneNode[], scale: number): Pick<SemanticCamera, "x" | "y"> {
  if (anchor.local) {
    const reference = anchor.local;
    const source = nodes.find((node) => node.node.ticket.id === reference.ticketId && node.opacity > 0 && node.width > 0 && node.height > 0);
    const replacementIndicator = indicatorLocation(nodes, reference.ticketId);
    const replacementAggregate = replacementIndicator ? undefined : reference.ancestors.map((id) => nodes.find((node) => node.node.ticket.id === id && node.aggregate && node.opacity > 0 && node.width > 0 && node.height > 0)).find((node) => node !== undefined);
    const sourcePoint = source ? localPoint(source, reference) : undefined;
    const replacementPoint = replacementIndicator
      ? localIndicatorPoint(replacementIndicator.parent, replacementIndicator.indicator, reference)
      : replacementAggregate ? localPoint(replacementAggregate, reference) : undefined;
    let resolved = sourcePoint ?? replacementPoint ?? { x: anchor.sceneX, y: anchor.sceneY };
    if (sourcePoint && replacementPoint && source) {
      resolved = {
        x: lerp(replacementPoint.x, sourcePoint.x, source.opacity),
        y: lerp(replacementPoint.y, sourcePoint.y, source.opacity),
      };
    }
    return { x: anchor.cursorX - resolved.x * scale, y: anchor.cursorY - resolved.y * scale };
  }
  const point = (item: SemanticSceneNode, reference: WheelAnchorTicket) => ({
    x: item.position.x - item.width / 2 + reference.relativeX * item.width,
    y: item.position.y + reference.relativeY * item.height,
  });
  const primaryReference = anchor.ticketId ? { ticketId: anchor.ticketId, relativeX: anchor.relativeX, relativeY: anchor.relativeY } : null;
  const primary = primaryReference && (anchor.kind !== "indicator" || !anchor.sourceNodePresent) ? nodes.find((node) => node.node.ticket.id === primaryReference.ticketId && node.width > 0 && node.height > 0) : undefined;
  const primaryIndicator = primary ? undefined : indicatorLocation(nodes, anchor.ticketId);
  const fallbackReference = anchor.fallbacks.find((reference) => nodes.some((node) => node.node.ticket.id === reference.ticketId && node.width > 0 && node.height > 0));
  const fallback = fallbackReference ? nodes.find((node) => node.node.ticket.id === fallbackReference.ticketId && node.width > 0 && node.height > 0) : undefined;
  const fallbackIndicator = fallback && primaryReference ? fallback.childIndicators.find((indicator) => indicator.ticketIds.includes(primaryReference.ticketId)) : undefined;
  const fallbackPoint = () => {
    if (fallback && fallbackIndicator && primaryReference) return indicatorPoint(fallback, fallbackIndicator, primaryReference);
    return fallback && fallbackReference ? point(fallback, fallbackReference) : { x: anchor.sceneX, y: anchor.sceneY };
  };
  let sceneX = anchor.sceneX;
  let sceneY = anchor.sceneY;
  if (primary && primaryReference) {
    const primaryPoint = point(primary, primaryReference);
    sceneX = primaryPoint.x;
    sceneY = primaryPoint.y;
    if (primary.opacity < 1) {
      sceneX = lerp(fallbackPoint().x, primaryPoint.x, primary.opacity);
      sceneY = lerp(fallbackPoint().y, primaryPoint.y, primary.opacity);
    }
  } else if (primaryIndicator && primaryReference) {
    const primaryPoint = indicatorPoint(primaryIndicator.parent, primaryIndicator.indicator, primaryReference);
    sceneX = primaryPoint.x;
    sceneY = primaryPoint.y;
    if (primaryIndicator.indicator.opacity < 1) {
      sceneX = lerp(fallbackPoint().x, primaryPoint.x, primaryIndicator.indicator.opacity);
      sceneY = lerp(fallbackPoint().y, primaryPoint.y, primaryIndicator.indicator.opacity);
    }
  } else if (fallback) {
    sceneX = fallbackPoint().x;
    sceneY = fallbackPoint().y;
  }
  return { x: anchor.cursorX - sceneX * scale, y: anchor.cursorY - sceneY * scale };
}

export function semanticEdgePath(source: SemanticSceneNode, target: SemanticSceneNode) {
  const sourceY = source.position.y + source.layoutHeight;
  const middleY = (sourceY + target.position.y) / 2;
  return `M ${source.position.x} ${sourceY} C ${source.position.x} ${middleY}, ${target.position.x} ${middleY}, ${target.position.x} ${target.position.y}`;
}
