import { useMemo, useRef } from "react";
import type { RefCallback } from "react";
import type { SpatialIndicatorGroup, SpatialSceneNode, SpatialSceneRegion } from "@treepm/engine";

export interface GeometryStyle {
  readonly width?: number;
  readonly height?: number;
  readonly opacity?: number;
  readonly transform?: string;
  readonly "--spatial-reveal"?: number;
  readonly "--spatial-indicator-scale"?: number;
}
export type NodeGeometry = Pick<SpatialSceneNode, "x" | "y" | "width" | "height" | "opacity" | "reveal" | "indicatorScale" | "contentOpacity">;
export type RegionGeometry = Pick<SpatialSceneRegion, "x" | "y" | "width" | "height" | "opacity">;
export type GroupGeometry = Pick<SpatialIndicatorGroup, "x" | "y" | "width" | "height" | "opacity" | "scale">;
export interface GeometryEntry<TElement extends HTMLElement> {
  readonly element: TElement;
  style: GeometryStyle | null;
  reveal?: number;
}
const GEOMETRY_PROPERTIES = ["width", "height", "opacity", "transform", "--spatial-reveal", "--spatial-indicator-scale"] as const;

/** Only seed geometry is ignored; every current/future semantic prop and callback is compared. */
export function equalSemanticProps<TProps extends { readonly initialGeometry: object }>(previous: TProps, next: TProps): boolean {
  const previousKeys = (Object.keys(previous) as (keyof TProps)[]).filter((key) => key !== "initialGeometry");
  const nextKeys = Object.keys(next).filter((key) => key !== "initialGeometry");
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => Object.prototype.hasOwnProperty.call(next, key) && Object.is(previous[key], next[key]));
}

/** Immutable React seed for SSR/hydration. All later geometry belongs to the parent effect. */
export function useGeometrySeed<TElement extends HTMLElement>(geometry: GeometryStyle, register: (id: string) => RefCallback<TElement>, id: string, reveal?: number) {
  const seed = useRef<{ readonly style: GeometryStyle; readonly reveal?: number } | null>(null);
  // Predictable one-time initialization, not a render-time mutation of live DOM/registry.
  if (seed.current === null) seed.current = { style: geometry, reveal };
  const ref = useMemo(() => register(id), [register, id]);
  return { ref, initialStyle: seed.current.style, initialReveal: seed.current.reveal };
}

export function nodeGeometryStyles(node: NodeGeometry) {
  const surfaceWidth = Math.max(6, node.width);
  const surfaceHeight = Math.max(6, node.height);
  return {
    article: { width: node.width, height: node.height, opacity: node.opacity, transform: `translate(${node.x}px, ${node.y}px) translateX(-50%)` },
    surface: { width: surfaceWidth, height: surfaceHeight, "--spatial-reveal": node.reveal, "--spatial-indicator-scale": node.indicatorScale,
      transform: `scale(${node.width / surfaceWidth}, ${node.height / surfaceHeight})` },
    button: { opacity: node.contentOpacity },
  };
}
export function regionGeometryStyle(region: RegionGeometry): GeometryStyle {
  return { width: region.width, height: region.height, opacity: region.opacity, transform: `translate(${region.x}px, ${region.y}px)` };
}
export function groupGeometryStyle(group: GroupGeometry): GeometryStyle {
  return { width: group.width, height: group.height, opacity: group.opacity,
    transform: `translate(${group.x - group.width * group.scale / 2}px, ${group.y}px) scale(${group.scale})` };
}

/** Writes only changed owned properties; never reads layout or modifies React semantic keys. */
export function commitGeometry<TElement extends HTMLElement>(entry: GeometryEntry<TElement> | undefined, geometry: GeometryStyle, reveal?: number) {
  if (!entry) return;
  for (const key of GEOMETRY_PROPERTIES) {
    const value = geometry[key];
    if (entry.style && Object.is(entry.style[key], value)) continue;
    if (value === undefined) {
      if (entry.style?.[key] !== undefined) entry.element.style.removeProperty(key);
    } else entry.element.style.setProperty(key, typeof value === "number" && (key === "width" || key === "height") ? `${value}px` : String(value));
  }
  if (reveal !== undefined && (entry.style === null || entry.reveal !== reveal)) entry.element.setAttribute("data-reveal", String(reveal));
  entry.style = geometry;
  entry.reveal = reveal;
}
