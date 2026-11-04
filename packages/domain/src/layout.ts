import { buildTreeIndex } from "./treeIndex.js";
import type { TreeIndex } from "./treeIndex.js";
import type { Ticket } from "./types.js";

export interface TreeLayoutNode {
  ticket: Ticket;
  x: number;
  y: number;
  depth: number;
  descendantCount: number;
}

export interface TreeLayout {
  nodes: TreeLayoutNode[];
  width: number;
  height: number;
}

const NODE_WIDTH = 272;
const LEVEL_HEIGHT = 224;
const SIBLING_GAP = 42;
const ROOT_GAP = 96;

interface MeasuredNode {
  ticket: Ticket;
  depth: number;
  width: number;
  descendantCount: number;
  children: MeasuredNode[];
}

function measure(ticket: Ticket, depth: number, index: TreeIndex): MeasuredNode {
  const children = (index.childrenByParentId.get(ticket.id) ?? []).map((child) => measure(child, depth + 1, index));
  const childrenWidth = children.reduce((sum, child) => sum + child.width, 0)
    + Math.max(0, children.length - 1) * SIBLING_GAP;
  return {
    ticket,
    depth,
    width: Math.max(NODE_WIDTH, childrenWidth),
    descendantCount: index.descendantCountById.get(ticket.id) ?? 0,
    children,
  };
}

export function tidyTreeLayout(tickets: Ticket[], treeIndex?: TreeIndex): TreeLayout {
  const index = treeIndex ?? buildTreeIndex(tickets);
  const roots = (index.childrenByParentId.get(null) ?? []).map((ticket) => measure(ticket, 0, index));
  const nodes: TreeLayoutNode[] = [];
  const totalWidth = roots.reduce((sum, root) => sum + root.width, 0)
    + Math.max(0, roots.length - 1) * ROOT_GAP;
  let rootOffset = -totalWidth / 2;

  const place = (node: MeasuredNode, left: number) => {
    const childrenWidth = node.children.reduce((sum, child) => sum + child.width, 0)
      + Math.max(0, node.children.length - 1) * SIBLING_GAP;
    const ownX = left + node.width / 2;
    nodes.push({
      ticket: node.ticket,
      x: ownX - NODE_WIDTH / 2,
      y: node.depth * LEVEL_HEIGHT,
      depth: node.depth,
      descendantCount: node.descendantCount,
    });
    let childOffset = ownX - childrenWidth / 2;
    for (const child of node.children) {
      place(child, childOffset);
      childOffset += child.width + SIBLING_GAP;
    }
  };

  let maxDepth = 0;
  for (const root of roots) {
    place(root, rootOffset);
    rootOffset += root.width + ROOT_GAP;
  }
  for (const node of nodes) maxDepth = Math.max(maxDepth, node.depth);

  return {
    nodes,
    width: Math.max(NODE_WIDTH, totalWidth),
    height: (maxDepth + 1) * LEVEL_HEIGHT,
  };
}
