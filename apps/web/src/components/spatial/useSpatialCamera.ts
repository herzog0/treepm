import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { advanceWheelCamera, cameraAtAnchor } from "./spatialCameraMotion.js";
import type { SpatialCamera, SpatialZoomAnchor } from "./spatialCameraMotion.js";
import type { SpatialBounds, SpatialLayout, SpatialLayoutNode } from "./spatialLayout.js";

export type { SpatialCamera } from "./spatialCameraMotion.js";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
}

interface FitAnimation {
  kind: "fit";
  frameId: number;
  from: SpatialCamera;
  to: SpatialCamera;
  startedAt: number;
}

interface WheelAnimation {
  kind: "wheel";
  frameId: number;
  to: SpatialCamera;
  anchor: SpatialZoomAnchor;
  lastFrameAt: number;
  lastDeltaAt: number;
}

type CameraAnimation = FitAnimation | WheelAnimation;

const READABLE_CARD_WIDTH = 140;
const WHEEL_GAIN = 0.0016;
const clamp = (minimum: number, maximum: number, value: number) => Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

export function useSpatialCamera(layout: SpatialLayout, stageRef: RefObject<HTMLDivElement | null>) {
  const maxScale = useMemo(() => {
    const minimumWidth = layout.nodes.reduce((minimum, node) => Math.min(minimum, node.width), Infinity);
    const requiredScale = READABLE_CARD_WIDTH / minimumWidth;
    return Number.isFinite(requiredScale) && minimumWidth > 0 ? Math.max(6, requiredScale) : 6;
  }, [layout]);
  const [camera, setCamera] = useState<SpatialCamera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [focusId, setFocusId] = useState(layout.nodes[0]?.ticket.id ?? "");
  const [isDragging, setIsDragging] = useState(false);
  const cameraRef = useRef(camera);
  const sizeRef = useRef(size);
  const animationRef = useRef<CameraAnimation | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const motionPreference = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const initializedRef = useRef(false);

  const commitCamera = (next: SpatialCamera) => {
    cameraRef.current = next;
    setCamera(next);
  };
  const cancelAnimation = () => {
    const animation = animationRef.current;
    if (animation) cancelAnimationFrame(animation.frameId);
    animationRef.current = null;
  };
  const tickAnimation = (now: number) => {
    const animation = animationRef.current;
    if (!animation) return;
    if (motionPreference.matches) {
      animationRef.current = null;
      commitCamera(animation.to);
      return;
    }
    let next: SpatialCamera;
    let complete: boolean;
    if (animation.kind === "wheel") {
      next = advanceWheelCamera(cameraRef.current, animation.to.scale, animation.anchor, now - animation.lastFrameAt);
      animation.lastFrameAt = now;
      const viewportRadius = Math.max(sizeRef.current.width, sizeRef.current.height, 1);
      const remainingPixels = Math.abs(animation.to.scale / next.scale - 1) * viewportRadius;
      complete = remainingPixels < 0.01 && now - animation.lastDeltaAt >= 180;
    } else {
      const progress = clamp(0, 1, (now - animation.startedAt) / 180);
      const eased = 1 - Math.pow(1 - progress, 3);
      next = {
        x: lerp(animation.from.x, animation.to.x, eased),
        y: lerp(animation.from.y, animation.to.y, eased),
        scale: lerp(animation.from.scale, animation.to.scale, eased),
      };
      complete = progress >= 1;
    }
    commitCamera(complete ? animation.to : next);
    if (complete) animationRef.current = null;
    else animation.frameId = requestAnimationFrame(tickAnimation);
  };
  const animateTo = (target: SpatialCamera) => {
    cancelAnimation();
    if (motionPreference.matches) {
      commitCamera(target);
      return;
    }
    const animation: FitAnimation = { kind: "fit", frameId: 0, from: cameraRef.current, to: target, startedAt: performance.now() };
    animationRef.current = animation;
    animation.frameId = requestAnimationFrame(tickAnimation);
  };
  const fitBounds = (bounds: SpatialBounds, immediate = false, minimum = 0.02, requiredScale = 0, targetNode?: SpatialLayoutNode) => {
    const width = Math.max(1, bounds.maxX - bounds.minX + 100);
    const height = Math.max(1, bounds.maxY - bounds.minY + 100);
    const fitScale = Math.min(4, Math.min(sizeRef.current.width / width, sizeRef.current.height / height) * 0.9);
    const scale = clamp(minimum, maxScale, Math.max(fitScale, requiredScale));
    const centerTarget = targetNode && requiredScale > fitScale;
    const centerX = centerTarget ? targetNode.x : (bounds.minX + bounds.maxX) / 2;
    const centerY = centerTarget ? targetNode.y + targetNode.height / 2 : (bounds.minY + bounds.maxY) / 2;
    const target = { x: sizeRef.current.width / 2 - centerX * scale, y: sizeRef.current.height / 2 - centerY * scale, scale };
    if (immediate) commitCamera(target);
    else animateTo(target);
  };
  const fitInitial = (immediate = false) => {
    const root = layout.nodes[0];
    if (!root) return fitBounds(layout.initialBounds, immediate, 0.45);
    const narrow = sizeRef.current.width < 700;
    const scale = clamp(
      narrow ? 0.2 : 0.45,
      1.2,
      Math.min(
        (sizeRef.current.width - (narrow ? 24 : 120)) / (2 * root.subtreeRadius),
        (sizeRef.current.height - (narrow ? 80 : 120)) / (2 * root.subtreeRadius),
      ),
    );
    const centerX = (layout.initialBounds.minX + layout.initialBounds.maxX) / 2;
    const centerY = (layout.initialBounds.minY + layout.initialBounds.maxY) / 2;
    const target = { x: sizeRef.current.width / 2 - centerX * scale, y: sizeRef.current.height / 2 - centerY * scale, scale };
    if (immediate) commitCamera(target);
    else animateTo(target);
  };
  const focusTicket = (id: string) => {
    const node = layout.nodeById.get(id);
    if (!node) return;
    setFocusId(id);
    fitBounds(node.subtreeBounds, false, 0.02, READABLE_CARD_WIDTH / node.width, node);
  };
  const pointFor = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const current = cameraRef.current;
    return { worldX: (cursorX - current.x) / current.scale, worldY: (cursorY - current.y) / current.scale, cursorX, cursorY };
  };
  const zoomAt = (clientX: number, clientY: number, deltaY: number) => {
    const measuredAnchor = pointFor(clientX, clientY);
    if (!measuredAnchor) return;
    const animation = animationRef.current;
    const wheel = animation?.kind === "wheel" ? animation : null;
    const samePoint = wheel?.anchor.cursorX === measuredAnchor.cursorX && wheel.anchor.cursorY === measuredAnchor.cursorY;
    const anchor = samePoint && wheel ? wheel.anchor : measuredAnchor;
    // Keep the accumulated scale target even when the pointer moves during the gesture.
    const baseScale = wheel?.to.scale ?? cameraRef.current.scale;
    const scale = clamp(0.02, maxScale, baseScale * Math.exp(-deltaY * WHEEL_GAIN));
    const target = cameraAtAnchor(scale, anchor);
    const now = performance.now();
    if (motionPreference.matches) {
      cancelAnimation();
      commitCamera(target);
    } else if (wheel) {
      wheel.to = target;
      wheel.anchor = anchor;
      wheel.lastDeltaAt = now;
    } else {
      cancelAnimation();
      const next: WheelAnimation = { kind: "wheel", frameId: 0, to: target, anchor, lastFrameAt: now, lastDeltaAt: now };
      animationRef.current = next;
      next.frameId = requestAnimationFrame(tickAnimation);
    }
  };

  const zoomBy = (direction: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const point = lastPointerRef.current ?? (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
    if (point) zoomAt(point.x, point.y, direction > 0 ? -180 : 180);
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = (width: number, height: number) => {
      const next = { width, height };
      sizeRef.current = next;
      setSize(next);
      if (!initializedRef.current && width > 0 && height > 0) {
        initializedRef.current = true;
        fitInitial(true);
      }
    };
    const rect = stage.getBoundingClientRect();
    update(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layout]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const listener = (event: WheelEvent) => {
      event.preventDefault();
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      zoomAt(event.clientX, event.clientY, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sizeRef.current.height : 1));
    };
    stage.addEventListener("wheel", listener, { passive: false });
    return () => stage.removeEventListener("wheel", listener);
  }, [layout]);
  useEffect(() => () => {
    cancelAnimation();
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    // A new grab owns the displayed camera immediately; never finish an old zoom first.
    cancelAnimation();
    if (event.button === 1) event.preventDefault();
    suppressClickRef.current = false;
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, active: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      if (drag.active) suppressClickRef.current = true;
      dragRef.current = null;
      setIsDragging(false);
      return;
    }
    let deltaX = event.clientX - drag.lastX;
    let deltaY = event.clientY - drag.lastY;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    if (!drag.active) {
      drag.active = true;
      deltaX = event.clientX - drag.startX;
      deltaY = event.clientY - drag.startY;
      setIsDragging(true);
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!event.currentTarget.hasPointerCapture(drag.pointerId)) event.currentTarget.setPointerCapture(drag.pointerId);
    event.preventDefault();
    const animation = animationRef.current;
    if (animation?.kind === "wheel") {
      // Move the current frame and future zoom frames together, keeping the grabbed world point.
      animation.anchor = {
        ...animation.anchor,
        cursorX: animation.anchor.cursorX + deltaX,
        cursorY: animation.anchor.cursorY + deltaY,
      };
      animation.to = cameraAtAnchor(animation.to.scale, animation.anchor);
    } else cancelAnimation();
    const current = cameraRef.current;
    commitCamera({ ...current, x: current.x + deltaX, y: current.y + deltaY });
  };
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) suppressClickRef.current = true;
    dragRef.current = null;
    setIsDragging(false);
  };
  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current && event.buttons !== 0) return;
    finishPointer(event);
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.detail === 0) {
      suppressClickRef.current = false;
      return;
    }
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };
  const onDragStartCapture = (event: ReactDragEvent<HTMLDivElement>) => event.preventDefault();

  return {
    camera,
    size,
    focusId,
    isDragging,
    zoomBy,
    fitInitial,
    focusTicket,
    gestureHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPointer,
      onPointerCancel: finishPointer,
      onLostPointerCapture,
      onClickCapture,
      onDragStartCapture,
    },
  };
}
