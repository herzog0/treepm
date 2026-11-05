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

export interface SpatialCameraOptions {
  readonly responseMs?: number;
}

export const DEFAULT_SPATIAL_CAMERA_OPTIONS = Object.freeze({ responseMs: 32 });

export function cameraAtAnchor(scale: number, anchor: SpatialZoomAnchor): SpatialCamera {
  return { x: anchor.cursorX - anchor.worldX * scale, y: anchor.cursorY - anchor.worldY * scale, scale };
}

/** Smooth the current frame toward the latest target, without an expiring easing origin. */
export function advanceWheelCamera(current: SpatialCamera, targetScale: number, anchor: SpatialZoomAnchor, elapsedMs: number, options?: SpatialCameraOptions): SpatialCamera {
  const responseMs = options?.responseMs ?? DEFAULT_SPATIAL_CAMERA_OPTIONS.responseMs;
  if (!Number.isFinite(responseMs) || responseMs <= 0) throw new RangeError("responseMs must be finite and positive");
  const response = -Math.expm1(-Math.max(0, elapsedMs) / responseMs);
  const scale = Math.exp(Math.log(current.scale) + Math.log(targetScale / current.scale) * response);
  return cameraAtAnchor(scale, anchor);
}
