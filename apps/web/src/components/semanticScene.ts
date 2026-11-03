import { childrenOf, descendantsOf } from "@treepm/domain";
import type { Ticket, tidyTreeLayout } from "@treepm/domain";

export interface SemanticCamera { x: number; y: number; zoom: number; scale: number }
export type SemanticCardKind = "full" | "compact" | "chip" | "dot" | "summary";
export interface FocusTransition { fromId: string; toId: string; progress: number }
type Layout = ReturnType<typeof tidyTreeLayout>;
type LayoutNode = Layout["nodes"][number];
interface SceneItem {
  node: LayoutNode;
  kind: SemanticCardKind;
  width?: number;
  height?: number;
  opacity?: number;
}
interface ScenePosition { x: number; y: number }
interface SceneBounds { min: number; max: number; ids: string[] }

export interface SemanticSceneNode extends SceneItem {
  position: ScenePosition;
  width: number;
  height: number;
  opacity: number;
}

export interface WheelAnchor {
  cursorX: number;
  cursorY: number;
  sceneX: number;
  sceneY: number;
  ticketId: string | null;
  relativeX: number;
  relativeY: number;
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
      opacity: 1,
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
  const path: Ticket[] = [];
  let current: Ticket | undefined = focus;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? ticketById.get(current.parentId) : undefined;
  }
  const pathIds = new Set(path.map((ticket) => ticket.id));
  const focusDepth = path.length - 1;
  const focusDescendants = new Set([focus.id, ...descendantsOf(tickets, focus.id).map((ticket) => ticket.id)]);
  const focusSiblings = new Set(childrenOf(tickets, focus.parentId).map((ticket) => ticket.id));
  const lateralSummaries = new Set<string>();
  for (const ancestor of path) {
    for (const sibling of childrenOf(tickets, ancestor.parentId)) {
      if (!pathIds.has(sibling.id)) lateralSummaries.add(sibling.id);
    }
  }
  for (const root of childrenOf(tickets, null)) if (!pathIds.has(root.id)) lateralSummaries.add(root.id);

  const items = layout.nodes.flatMap((node): SceneItem[] => {
    const id = node.ticket.id;
    const relevant = focusDescendants.has(id) || pathIds.has(id) || focusSiblings.has(id) || lateralSummaries.has(id);
    if (!relevant) return [];
    const summary = lateralSummaries.has(id) && !focusSiblings.has(id);
    const relativeDepth = node.depth - focusDepth;
    let kind: SemanticCardKind = "compact";
    if (summary) kind = "summary";
    else if (id === focus.id) kind = "full";
    else if (focusDescendants.has(id)) {
      if (zoom < 0.62 && relativeDepth > 1) kind = "dot";
      else if (zoom < 0.82 && relativeDepth > 0) kind = "chip";
      else kind = relativeDepth <= 1 ? "full" : "compact";
    } else if (zoom < 0.66) kind = "chip";
    return [{ node, kind }];
  });
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
    return [{
      node: layoutNode,
      kind: progress < 0.5 ? startKind : endKind,
      width: lerp(source?.width ?? dot.width, target?.width ?? dot.width, progress),
      height: lerp(source?.height ?? dot.height, target?.height ?? dot.height, progress),
      opacity: 1,
    }];
  });
  return layoutScene(items, zoom, viewportWidth);
}

export function createSemanticScene(layout: Layout, tickets: Ticket[], focusId: string, transition: FocusTransition | null, zoom: number, viewportWidth: number) {
  if (!transition || transition.progress <= 0 || transition.fromId === transition.toId) return focusScene(layout, tickets, focusId, zoom, viewportWidth);
  if (transition.progress >= 1) return focusScene(layout, tickets, transition.toId, zoom, viewportWidth);
  const from = focusScene(layout, tickets, transition.fromId, zoom, viewportWidth);
  const to = focusScene(layout, tickets, transition.toId, zoom, viewportWidth);
  return blendScenes(layout, from, to, transition.progress, zoom, viewportWidth);
}

export function captureWheelAnchor(clientX: number, clientY: number, stage: DOMRect, camera: SemanticCamera, nodes: SemanticSceneNode[], ticketId: string | null): WheelAnchor {
  const cursorX = clientX - stage.left;
  const cursorY = clientY - stage.top;
  const sceneX = (cursorX - camera.x) / camera.scale;
  const sceneY = (cursorY - camera.y) / camera.scale;
  const item = ticketId ? nodes.find((node) => node.node.ticket.id === ticketId) : undefined;
  return {
    cursorX,
    cursorY,
    sceneX,
    sceneY,
    ticketId: item ? ticketId : null,
    relativeX: item && item.width > 0 ? (sceneX - item.position.x + item.width / 2) / item.width : 0,
    relativeY: item && item.height > 0 ? (sceneY - item.position.y) / item.height : 0,
  };
}

export function cameraForAnchor(anchor: WheelAnchor, nodes: SemanticSceneNode[], scale: number): Pick<SemanticCamera, "x" | "y"> {
  const item = anchor.ticketId ? nodes.find((node) => node.node.ticket.id === anchor.ticketId && node.width > 0 && node.height > 0) : undefined;
  const sceneX = item ? item.position.x - item.width / 2 + anchor.relativeX * item.width : anchor.sceneX;
  const sceneY = item ? item.position.y + anchor.relativeY * item.height : anchor.sceneY;
  return { x: anchor.cursorX - sceneX * scale, y: anchor.cursorY - sceneY * scale };
}

export function semanticEdgePath(source: SemanticSceneNode, target: SemanticSceneNode) {
  const sourceY = source.position.y + source.height;
  const middleY = (sourceY + target.position.y) / 2;
  return `M ${source.position.x} ${sourceY} C ${source.position.x} ${middleY}, ${target.position.x} ${middleY}, ${target.position.x} ${target.position.y}`;
}
