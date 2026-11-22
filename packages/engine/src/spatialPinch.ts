import { cameraAtAnchor } from "./spatialCameraMotion.js";
import type { SpatialCamera, SpatialZoomAnchor } from "./spatialCameraMotion.js";

/** Two contact points in stage coordinates (pixels relative to the stage's top-left corner). */
export type PinchPoints = readonly [{ readonly x: number; readonly y: number }, { readonly x: number; readonly y: number }];

export interface PinchLimits {
  readonly minScale: number;
  readonly maxScale: number;
}

/** Baseline of one pinch: the world point under the fingers' midpoint, the scale and the finger distance when it began. */
export interface PinchStart {
  readonly anchor: Pick<SpatialZoomAnchor, "worldX" | "worldY">;
  readonly scale: number;
  readonly distance: number;
}

// Fingers closer than this are treated as this far apart, so a zero distance never divides.
const MIN_DISTANCE = 1;

const midpoint = (points: PinchPoints) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
const distanceOf = (points: PinchPoints) => Math.max(MIN_DISTANCE, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));

/**
 * Begin (or re-baseline) a pinch from the camera currently shown. Call it whenever the set of fingers changes
 * (1→2, or one finger swapped), so the next update starts exactly where the camera is: no jump.
 */
export function startPinch(camera: SpatialCamera, points: PinchPoints): PinchStart {
  const center = midpoint(points);
  return {
    anchor: { worldX: (center.x - camera.x) / camera.scale, worldY: (center.y - camera.y) / camera.scale },
    scale: camera.scale,
    distance: distanceOf(points),
  };
}

/**
 * Camera for the fingers' current positions: the scale follows the ratio of finger distances (within the limits)
 * and the world point first under the midpoint stays under the midpoint's current position, so moving both fingers
 * pans while the distance zooms.
 */
export function pinchCamera(start: PinchStart, points: PinchPoints, limits: PinchLimits): SpatialCamera {
  const center = midpoint(points);
  const scale = Math.min(limits.maxScale, Math.max(limits.minScale, start.scale * (distanceOf(points) / start.distance)));
  return cameraAtAnchor(scale, { ...start.anchor, cursorX: center.x, cursorY: center.y });
}
