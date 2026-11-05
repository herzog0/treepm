export interface TreeNodeIdentity {
  readonly id: string;
}

export interface TreeNodeHierarchy {
  readonly parentId: string | null;
}

export interface TreeNode extends TreeNodeIdentity, TreeNodeHierarchy {}

/** Migration alias; presentation fields are supplied by the consumer. */
export type SpatialItem = TreeNode;

export interface TreeIndex<TNode extends TreeNode = TreeNode> {
  readonly itemById: ReadonlyMap<string, TNode>;
  readonly childrenByParentId: ReadonlyMap<string | null, readonly TNode[]>;
  readonly depthById: ReadonlyMap<string, number>;
  readonly subtreeHeightById: ReadonlyMap<string, number>;
  readonly subtreeCountById: ReadonlyMap<string, number>;
  readonly descendantCountById: ReadonlyMap<string, number>;
}

/** Validate a forest and index it without sorting or mutating the input. */
export function buildTreeIndex<TNode extends TreeNode>(items: readonly TNode[]): TreeIndex<TNode> {
  const itemById = new Map<string, TNode>();
  const mutableChildren = new Map<string | null, TNode[]>();
  for (const item of items) {
    if (itemById.has(item.id)) throw new Error(`Duplicate spatial item ID: "${item.id}"`);
    if (item.parentId === item.id) throw new Error(`Spatial item "${item.id}" cannot be its own parent`);
    itemById.set(item.id, item);
    const siblings = mutableChildren.get(item.parentId) ?? [];
    siblings.push(item);
    mutableChildren.set(item.parentId, siblings);
  }
  for (const item of items) {
    if (item.parentId !== null && !itemById.has(item.parentId)) {
      throw new Error(`Missing parent "${item.parentId}" for spatial item "${item.id}"`);
    }
  }

  const childrenByParentId = new Map<string | null, readonly TNode[]>();
  for (const [parentId, children] of mutableChildren) childrenByParentId.set(parentId, Object.freeze(children));

  // Breadth-first traversal keeps depth computation iterative even for deep inputs.
  const ordered = [...(childrenByParentId.get(null) ?? [])];
  const depthById = new Map<string, number>();
  for (const root of ordered) depthById.set(root.id, 0);
  for (let position = 0; position < ordered.length; position += 1) {
    const item = ordered[position];
    if (!item) continue;
    const depth = depthById.get(item.id) ?? 0;
    for (const child of childrenByParentId.get(item.id) ?? []) {
      depthById.set(child.id, depth + 1);
      ordered.push(child);
    }
  }
  if (ordered.length !== items.length) {
    const cyclicItem = items.find((item) => !depthById.has(item.id));
    throw new Error(`Cycle detected in spatial hierarchy connected to "${cyclicItem?.id ?? ""}"`);
  }

  const subtreeHeightById = new Map<string, number>();
  const subtreeCountById = new Map<string, number>();
  const descendantCountById = new Map<string, number>();
  for (let position = ordered.length - 1; position >= 0; position -= 1) {
    const item = ordered[position];
    if (!item) continue;
    let count = 1;
    let height = 0;
    for (const child of childrenByParentId.get(item.id) ?? []) {
      count += subtreeCountById.get(child.id) ?? 1;
      height = Math.max(height, (subtreeHeightById.get(child.id) ?? 0) + 1);
    }
    subtreeHeightById.set(item.id, height);
    subtreeCountById.set(item.id, count);
    descendantCountById.set(item.id, count - 1);
  }
  return { itemById, childrenByParentId, depthById, subtreeHeightById, subtreeCountById, descendantCountById };
}

export type SpatialTreeIndex<TNode extends TreeNode = TreeNode> = TreeIndex<TNode>;
export const buildSpatialIndex = buildTreeIndex;
