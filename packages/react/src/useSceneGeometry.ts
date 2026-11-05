import { useLayoutEffect, useRef } from "react";
import type { RefCallback } from "react";
import type { SpatialScene, TreeNode } from "@treepm/engine";
import { commitGeometry, groupGeometryStyle, nodeGeometryStyles, regionGeometryStyle } from "./useGeometryStyle.js";
import type { GeometryEntry } from "./useGeometryStyle.js";

function geometryRef<TElement extends HTMLElement>(entries: Map<string, GeometryEntry<TElement>>, id: string): RefCallback<TElement> {
  let attached: GeometryEntry<TElement> | undefined;
  return (element) => {
    if (!element) {
      if (attached && entries.get(id) === attached) entries.delete(id);
      attached = undefined;
      return;
    }
    const entry = { element, style: null };
    attached = entry;
    entries.set(id, entry);
    // React 19 ref cleanup; identity guard also protects same-ID replacements.
    return () => {
      if (entries.get(id) === entry) entries.delete(id);
      if (attached === entry) attached = undefined;
    };
  };
}

/** Private per-view registry. Maps are changed only by committed ref callbacks. */
export function createGeometryRegistry() {
  const articles = new Map<string, GeometryEntry<HTMLElement>>();
  const surfaces = new Map<string, GeometryEntry<HTMLDivElement>>();
  const buttons = new Map<string, GeometryEntry<HTMLButtonElement>>();
  const regions = new Map<string, GeometryEntry<HTMLDivElement>>();
  const groups = new Map<string, GeometryEntry<HTMLSpanElement>>();
  return {
    articles, surfaces, buttons, regions, groups,
    articleRef: (id: string) => geometryRef(articles, id),
    surfaceRef: (id: string) => geometryRef(surfaces, id),
    buttonRef: (id: string) => geometryRef(buttons, id),
    regionRef: (id: string) => geometryRef(regions, id),
    groupRef: (id: string) => geometryRef(groups, id),
  };
}
export type GeometryRegistry = ReturnType<typeof createGeometryRegistry>;

export function useSceneGeometry<TNode extends TreeNode>(scene: SpatialScene<TNode>, showRegions: boolean) {
  const registryRef = useRef<GeometryRegistry | null>(null);
  if (registryRef.current === null) registryRef.current = createGeometryRegistry();
  const registry = registryRef.current;
  // Host refs attach before this parent layout effect. Never publish a render-time scene.
  useLayoutEffect(() => {
    for (const node of scene.nodes) {
      const geometry = nodeGeometryStyles(node);
      commitGeometry(registry.articles.get(node.id), geometry.article, node.reveal);
      commitGeometry(registry.surfaces.get(node.id), geometry.surface);
      commitGeometry(registry.buttons.get(node.id), geometry.button);
    }
    if (showRegions) for (const region of scene.regions) commitGeometry(registry.regions.get(region.id), regionGeometryStyle(region));
    for (const group of scene.groups) commitGeometry(registry.groups.get(group.id), groupGeometryStyle(group));
    // Ref cleanup owns removal (including StrictMode/unmount). No per-frame cleanup
    // may clear these maps: memoized children correctly keep their refs attached.
  });
  return registry;
}
