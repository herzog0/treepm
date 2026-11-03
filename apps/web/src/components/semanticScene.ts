import { childrenOf } from "@treepm/domain";
import type { Ticket, tidyTreeLayout } from "@treepm/domain";

export interface SemanticCamera { x: number; y: number; zoom: number; scale: number }
export type SemanticCardKind = "full" | "compact" | "chip" | "dot" | "summary";
export type SemanticVisualStatus = Ticket["status"] | "not_started" | "active" | "mixed";
export interface FocusTransition {
  fromId: string;
  toId: string;
  progress: number;
  fromScene?: SemanticSceneNode[];
}
type Layout = ReturnType<typeof tidyTreeLayout>;
type LayoutNode = Layout["nodes"][number];
interface LeafCounts { todo: number; in_progress: number; done: number }
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
}
interface ScenePosition { x: number; y: number }
interface SceneBounds { min: number; max: number; ids: string[] }

export interface SemanticSceneNode extends SceneItem {
  position: ScenePosition;
  width: number;
  height: number;
  opacity: number;
  aggregate: boolean;
  representedCount: number;
  aggregateDoneLeaves: number;
  aggregateTotalLeaves: number;
  visualStatus: SemanticVisualStatus;
  statusColor: string;
  subtreeHeight: number;
}

interface WheelAnchorTicket {
  ticketId: string;
  relativeX: number;
  relativeY: number;
}

export interface WheelAnchor {
  cursorX: number;
  cursorY: number;
  sceneX: number;
  sceneY: number;
  ticketId: string | null;
  relativeX: number;
  relativeY: number;
  fallbacks: WheelAnchorTicket[];
}

export const SEMANTIC_CARD_SIZES: Record<SemanticCardKind, { width: number; height: number }> = {
  full: { width: 246, height: 142 },
  compact: { width: 198, height: 118 },
  chip: { width: 122, height: 54 },
  dot: { width: 18, height: 18 },
  summary: { width: 220, height: 112 },
};

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const sizeFor = (item: SceneItem) => ({
  width: item.width ?? SEMANTIC_CARD_SIZES[item.kind].width,
  height: item.height ?? SEMANTIC_CARD_SIZES[item.kind].height,
});
const STATUS_COLORS: Record<SemanticVisualStatus, string> = {
  todo: "#68616f",
  not_started: "#68616f",
  in_progress: "#9e493f",
  active: "#9e493f",
  done: "#326b4d",
  mixed: "#925400",
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
    const positions = new Map<string, ScenePosition>();
    const placeSubtree = (item: SceneItem): SceneBounds => {
      const id = item.node.ticket.id;
      const children = visibleChildren.get(id) ?? [];
      const childBounds: SceneBounds[] = [];
      let right = 0;
      children.forEach((child, index) => {
        let bounds = placeSubtree(child);
        const previous = children[index - 1];
        const separatesBranches = previous && ((visibleChildren.get(previous.node.ticket.id)?.length ?? 0) > 0 || (visibleChildren.get(child.node.ticket.id)?.length ?? 0) > 0);
        const offset = index === 0 ? -bounds.min : right - bounds.min + gap + (separatesBranches ? 8 : 0);
        if (offset !== 0) {
          for (const childId of bounds.ids) {
            const position = positions.get(childId);
            if (position) position.x += offset;
          }
          bounds = { ...bounds, min: bounds.min + offset, max: bounds.max + offset };
        }
        right = bounds.max;
        childBounds.push(bounds);
      });

      const firstChild = children[0];
      const lastChild = children[children.length - 1];
      const firstX = firstChild ? positions.get(firstChild.node.ticket.id)?.x ?? 0 : 0;
      const lastX = lastChild ? positions.get(lastChild.node.ticket.id)?.x ?? 0 : 0;
      const x = (firstX + lastX) / 2;
      const { width } = sizeFor(item);
      positions.set(id, { x, y: 0 });
      return {
        min: Math.min(x - width / 2, ...childBounds.map((bounds) => bounds.min)),
        max: Math.max(x + width / 2, ...childBounds.map((bounds) => bounds.max)),
        ids: [id, ...childBounds.flatMap((bounds) => bounds.ids)],
      };
    };

    const forestBounds: SceneBounds[] = [];
    let right = 0;
    roots.forEach((root, index) => {
      let bounds = placeSubtree(root);
      const offset = index === 0 ? -bounds.min : right - bounds.min + gap + 8;
      if (offset !== 0) {
        for (const id of bounds.ids) {
          const position = positions.get(id);
          if (position) position.x += offset;
        }
        bounds = { ...bounds, min: bounds.min + offset, max: bounds.max + offset };
      }
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
    levelHeights.set(depth, Math.max(levelHeights.get(depth) ?? 0, sizeFor(item).height));
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
    return {
      ...item,
      ...size,
      opacity: item.opacity ?? 1,
      aggregate: item.aggregate ?? false,
      representedCount: item.representedCount ?? 1,
      aggregateDoneLeaves: item.aggregateDoneLeaves ?? 0,
      aggregateTotalLeaves: item.aggregateTotalLeaves ?? 0,
      visualStatus: item.visualStatus ?? "not_started",
      statusColor: item.statusColor ?? STATUS_COLORS.not_started,
      subtreeHeight: item.subtreeHeight ?? 0,
      position: {
        x: viewportWidth / 2 + position.x - firstRootX,
        y: 28 + (levelTops.get(item.node.depth) ?? 0),
      },
    };
  });
}

function focusScene(layout: Layout, tickets: Ticket[], focusId: string, zoom: number, viewportWidth: number) {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const firstRoot = childrenOf(tickets, null)[0];
  const focus = ticketById.get(focusId) ?? firstRoot ?? tickets[0];
  if (!focus) return [];
  const infoById = new Map<string, SubtreeInfo>();
  const heightById = new Map<string, number>();
  for (const node of [...layout.nodes].sort((a, b) => b.depth - a.depth)) {
    const children = childrenOf(tickets, node.ticket.id);
    const info: SubtreeInfo = { ticketCount: 1, leaves: emptyLeaves() };
    let height = 0;
    if (!children.length) info.leaves[node.ticket.status] += 1;
    for (const child of children) {
      const childInfo = infoById.get(child.id);
      if (!childInfo) continue;
      info.ticketCount += childInfo.ticketCount;
      addLeaves(info.leaves, childInfo.leaves);
      height = Math.max(height, (heightById.get(child.id) ?? 0) + 1);
    }
    infoById.set(node.ticket.id, info);
    heightById.set(node.ticket.id, height);
  }
  const makeItem = (node: LayoutNode, kind: SemanticCardKind, hiddenInfos: SubtreeInfo[] = [], dimensions?: { width: number; height: number }): SceneItem => {
    const ownInfo = infoById.get(node.ticket.id) ?? { ticketCount: 1, leaves: emptyLeaves() };
    const hidden: SubtreeInfo = { ticketCount: 0, leaves: emptyLeaves() };
    for (const info of hiddenInfos) {
      hidden.ticketCount += info.ticketCount;
      addLeaves(hidden.leaves, info.leaves);
    }
    const aggregate = hidden.ticketCount > 0;
    const visualStatus = aggregate ? statusForLeaves(hidden.leaves) : regularStatus(node.ticket, ownInfo);
    return {
      node,
      kind,
      ...dimensions,
      aggregate,
      representedCount: 1 + hidden.ticketCount,
      aggregateDoneLeaves: hidden.leaves.done,
      aggregateTotalLeaves: leafTotal(hidden.leaves),
      visualStatus,
      statusColor: STATUS_COLORS[visualStatus],
      subtreeHeight: heightById.get(node.ticket.id) ?? 0,
    };
  };

  const path: Ticket[] = [];
  let current: Ticket | undefined = focus;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? ticketById.get(current.parentId) : undefined;
  }
  const pathIds = new Set(path.map((ticket) => ticket.id));
  const lateralSummaries = new Set<string>();
  for (const ancestor of path) {
    for (const sibling of childrenOf(tickets, ancestor.parentId)) {
      if (!pathIds.has(sibling.id)) lateralSummaries.add(sibling.id);
    }
  }
  for (const root of childrenOf(tickets, null)) if (!pathIds.has(root.id)) lateralSummaries.add(root.id);

  const compaction = Math.max(0, (1.4 - zoom) / 0.12);
  const visit = (node: LayoutNode): { items: SceneItem[]; collapsed?: SubtreeInfo } => {
    const ownInfo = infoById.get(node.ticket.id) ?? { ticketCount: 1, leaves: emptyLeaves() };
    const phase = Math.round((compaction - (heightById.get(node.ticket.id) ?? 0)) * 1e9) / 1e9;
    if (node.ticket.id !== focus.id && phase >= 4) return { items: [], collapsed: ownInfo };
    const childResults = childrenOf(tickets, node.ticket.id).flatMap((child) => {
      const childNode = layout.nodes.find((item) => item.ticket.id === child.id);
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
  const focusNode = layout.nodes.find((node) => node.ticket.id === focus.id);
  const items: SceneItem[] = [];
  for (const ticket of path) {
    if (ticket.id === focus.id) continue;
    const node = layout.nodes.find((item) => item.ticket.id === ticket.id);
    if (node) items.push(makeItem(node, zoom < 0.66 ? "chip" : "compact"));
  }
  if (focusNode) items.push(...visit(focusNode).items);
  for (const id of lateralSummaries) {
    const node = layout.nodes.find((item) => item.ticket.id === id);
    if (!node || pathIds.has(id)) continue;
    const hidden = childrenOf(tickets, id).flatMap((child) => {
      const info = infoById.get(child.id);
      return info ? [info] : [];
    });
    items.push(makeItem(node, "summary", hidden));
  }
  const order = new Map(layout.nodes.map((node, index) => [node.ticket.id, index]));
  items.sort((a, b) => (order.get(a.node.ticket.id) ?? 0) - (order.get(b.node.ticket.id) ?? 0));
  return layoutScene(items, zoom, viewportWidth);
}

function blendScenes(layout: Layout, from: SemanticSceneNode[], to: SemanticSceneNode[], progress: number, zoom: number, viewportWidth: number) {
  const fromById = new Map(from.map((item) => [item.node.ticket.id, item]));
  const toById = new Map(to.map((item) => [item.node.ticket.id, item]));
  const dot = SEMANTIC_CARD_SIZES.dot;
  const items = layout.nodes.flatMap((layoutNode): SceneItem[] => {
    const id = layoutNode.ticket.id;
    const source = fromById.get(id);
    const target = toById.get(id);
    if (!source && !target) return [];
    const startKind = source?.kind ?? "dot";
    const endKind = target?.kind ?? "dot";
    const presentation = progress < 0.5 ? source ?? target : target ?? source;
    const startColor = source?.statusColor ?? target?.statusColor ?? STATUS_COLORS.not_started;
    const endColor = target?.statusColor ?? startColor;
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
    }];
  });
  return layoutScene(items, zoom, viewportWidth);
}

export function blendSemanticScenes(layout: Layout, from: SemanticSceneNode[], to: SemanticSceneNode[], progress: number, zoom: number, viewportWidth: number) {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  return blendScenes(layout, from, to, progress, zoom, viewportWidth);
}

export function createSemanticScene(layout: Layout, tickets: Ticket[], focusId: string, transition: FocusTransition | null, zoom: number, viewportWidth: number) {
  if (!transition || (transition.fromId === transition.toId && !transition.fromScene)) return focusScene(layout, tickets, focusId, zoom, viewportWidth);
  if (transition.progress <= 0 && transition.fromScene) return transition.fromScene;
  if (transition.progress <= 0) return focusScene(layout, tickets, focusId, zoom, viewportWidth);
  if (transition.progress >= 1) return focusScene(layout, tickets, transition.toId, zoom, viewportWidth);
  const from = transition.fromScene ?? focusScene(layout, tickets, transition.fromId, zoom, viewportWidth);
  const to = focusScene(layout, tickets, transition.toId, zoom, viewportWidth);
  return blendSemanticScenes(layout, from, to, transition.progress, zoom, viewportWidth);
}

export function captureWheelAnchor(clientX: number, clientY: number, stage: DOMRect, camera: SemanticCamera, nodes: SemanticSceneNode[], ticketId: string | null): WheelAnchor {
  const cursorX = clientX - stage.left;
  const cursorY = clientY - stage.top;
  const sceneX = (cursorX - camera.x) / camera.scale;
  const sceneY = (cursorY - camera.y) / camera.scale;
  const item = ticketId ? nodes.find((node) => node.node.ticket.id === ticketId) : undefined;
  const relative = (node: SemanticSceneNode): Omit<WheelAnchorTicket, "ticketId"> => ({
    relativeX: node.width > 0 ? (sceneX - node.position.x + node.width / 2) / node.width : 0,
    relativeY: node.height > 0 ? (sceneY - node.position.y) / node.height : 0,
  });
  const fallbacks: WheelAnchorTicket[] = [];
  const visited = new Set<string>();
  let parentId = item?.node.ticket.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((node) => node.node.ticket.id === parentId);
    if (!parent) break;
    fallbacks.push({ ticketId: parentId, ...relative(parent) });
    parentId = parent.node.ticket.parentId;
  }
  return {
    cursorX,
    cursorY,
    sceneX,
    sceneY,
    ticketId: item ? ticketId : null,
    relativeX: item ? relative(item).relativeX : 0,
    relativeY: item ? relative(item).relativeY : 0,
    fallbacks,
  };
}

export function cameraForAnchor(anchor: WheelAnchor, nodes: SemanticSceneNode[], scale: number): Pick<SemanticCamera, "x" | "y"> {
  const point = (item: SemanticSceneNode, reference: WheelAnchorTicket) => ({
    x: item.position.x - item.width / 2 + reference.relativeX * item.width,
    y: item.position.y + reference.relativeY * item.height,
  });
  const primaryReference = anchor.ticketId ? { ticketId: anchor.ticketId, relativeX: anchor.relativeX, relativeY: anchor.relativeY } : null;
  const primary = primaryReference ? nodes.find((node) => node.node.ticket.id === primaryReference.ticketId && node.width > 0 && node.height > 0) : undefined;
  const fallbackReference = anchor.fallbacks.find((reference) => nodes.some((node) => node.node.ticket.id === reference.ticketId && node.width > 0 && node.height > 0));
  const fallback = fallbackReference ? nodes.find((node) => node.node.ticket.id === fallbackReference.ticketId && node.width > 0 && node.height > 0) : undefined;
  let sceneX = anchor.sceneX;
  let sceneY = anchor.sceneY;
  if (primary && primaryReference) {
    const primaryPoint = point(primary, primaryReference);
    sceneX = primaryPoint.x;
    sceneY = primaryPoint.y;
    if (fallback && fallbackReference && primary.opacity < 1) {
      const fallbackPoint = point(fallback, fallbackReference);
      sceneX = lerp(fallbackPoint.x, primaryPoint.x, primary.opacity);
      sceneY = lerp(fallbackPoint.y, primaryPoint.y, primary.opacity);
    }
  } else if (fallback && fallbackReference) {
    const fallbackPoint = point(fallback, fallbackReference);
    sceneX = fallbackPoint.x;
    sceneY = fallbackPoint.y;
  }
  return { x: anchor.cursorX - sceneX * scale, y: anchor.cursorY - sceneY * scale };
}

export function semanticEdgePath(source: SemanticSceneNode, target: SemanticSceneNode) {
  const sourceY = source.position.y + source.height;
  const middleY = (sourceY + target.position.y) / 2;
  return `M ${source.position.x} ${sourceY} C ${source.position.x} ${middleY}, ${target.position.x} ${middleY}, ${target.position.x} ${target.position.y}`;
}
