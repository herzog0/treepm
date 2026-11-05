export interface SpatialCamera {
  x: number;
  y: number;
  scale: number;
}

export interface SpatialZoomAnchor {
  worldX: number;
  worldY: number;
  cursorX: number;
  cursorY: number;
}

const WHEEL_RESPONSE_MS = 32;

export function cameraAtAnchor(scale: number, anchor: SpatialZoomAnchor): SpatialCamera {
  return { x: anchor.cursorX - anchor.worldX * scale, y: anchor.cursorY - anchor.worldY * scale, scale };
}

/** Smooth the current frame toward the latest target, without an expiring easing origin. */
export function advanceWheelCamera(current: SpatialCamera, targetScale: number, anchor: SpatialZoomAnchor, elapsedMs: number): SpatialCamera {
  const response = -Math.expm1(-Math.max(0, elapsedMs) / WHEEL_RESPONSE_MS);
  const scale = Math.exp(Math.log(current.scale) + Math.log(targetScale / current.scale) * response);
  return cameraAtAnchor(scale, anchor);
}
