import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { advanceWheelCamera, cameraAtAnchor } from "@treepm/engine";
import type { SpatialCamera, SpatialZoomAnchor, SpatialBounds, SpatialLayout, SpatialLayoutNode, TreeNode, SpatialCameraOptions as EngineCameraOptions } from "@treepm/engine";

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
}

type CameraAnimation = FitAnimation | WheelAnimation;

export interface SpatialCameraOptions extends EngineCameraOptions {
  readonly wheelGain?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly readableWidth?: number;
  readonly focusDurationMs?: number;
  readonly panThreshold?: number;
  readonly zoomStep?: number;
  readonly reducedMotion?: boolean;
}
const EMPTY_CAMERA_OPTIONS: SpatialCameraOptions = {};

const clamp = (minimum: number, maximum: number, value: number) => Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

export function useSpatialCamera<TNode extends TreeNode>(layout: SpatialLayout<TNode>, stageRef: RefObject<HTMLDivElement | null>, options: SpatialCameraOptions = EMPTY_CAMERA_OPTIONS) {
  const { wheelGain = 0.0016, minScale = 0.02, maxScale: explicitMaxScale, readableWidth = 140, focusDurationMs = 180, panThreshold = 5, zoomStep = 180, responseMs, reducedMotion } = options;
  const config = useMemo(() => {
    const positive = { wheelGain, minScale, readableWidth, zoomStep };
    for (const [name, value] of Object.entries(positive)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
    }
    if (!Number.isFinite(focusDurationMs) || focusDurationMs < 0 || !Number.isFinite(panThreshold) || panThreshold < 0) throw new Error("Focus duration and pan threshold must be nonnegative and finite");
    if (explicitMaxScale !== undefined && (!Number.isFinite(explicitMaxScale) || explicitMaxScale < minScale)) throw new Error("maxScale must be finite and at least minScale");
    if (responseMs !== undefined && (!Number.isFinite(responseMs) || responseMs <= 0)) throw new Error("responseMs must be positive and finite");
    return { wheelGain, minScale, explicitMaxScale, readableWidth, focusDurationMs, panThreshold, zoomStep, responseMs, reducedMotion };
  }, [wheelGain, minScale, explicitMaxScale, readableWidth, focusDurationMs, panThreshold, zoomStep, responseMs, reducedMotion]);
  const maxScale = useMemo(() => {
    const minimumWidth = layout.nodes.reduce((minimum, node) => Math.min(minimum, node.width), Infinity);
    const requiredScale = config.readableWidth / minimumWidth;
    return config.explicitMaxScale ?? Math.max(config.minScale, Number.isFinite(requiredScale) && minimumWidth > 0 ? Math.max(6, requiredScale) : 6);
  }, [layout, config]);
  const [camera, setCamera] = useState<SpatialCamera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [focusId, setFocusId] = useState(layout.nodes[0]?.item.id ?? "");
  const [isDragging, setIsDragging] = useState(false);
  const cameraRef = useRef(camera);
  const sizeRef = useRef(size);
  const animationRef = useRef<CameraAnimation | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const motionPreference = useMemo(() => typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const initializedRef = useRef(false);
  const stageBoundsRef = useRef<DOMRect | null>(null);

  const stageBounds = () => {
    // Layout is stable between resizes/scrolls. Reading it for every wheel delta
    // would synchronously flush the preceding camera frame's style changes.
    stageBoundsRef.current ??= stageRef.current?.getBoundingClientRect() ?? null;
    return stageBoundsRef.current;
  };

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
    if ((config.reducedMotion ?? motionPreference?.matches ?? false)) {
      animationRef.current = null;
      commitCamera(animation.to);
      return;
    }
    let next: SpatialCamera;
    let complete: boolean;
    if (animation.kind === "wheel") {
      next = advanceWheelCamera(cameraRef.current, animation.to.scale, animation.anchor, now - animation.lastFrameAt, config);
      animation.lastFrameAt = now;
      const viewportRadius = Math.max(sizeRef.current.width, sizeRef.current.height, 1);
      const remainingPixels = Math.abs(animation.to.scale / next.scale - 1) * viewportRadius;
      complete = remainingPixels < 0.05;
    } else {
      const progress = clamp(0, 1, (now - animation.startedAt) / config.focusDurationMs);
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
    if ((config.reducedMotion ?? motionPreference?.matches ?? false) || config.focusDurationMs === 0) {
      commitCamera(target);
      return;
    }
    const animation: FitAnimation = { kind: "fit", frameId: 0, from: cameraRef.current, to: target, startedAt: performance.now() };
    animationRef.current = animation;
    animation.frameId = requestAnimationFrame(tickAnimation);
  };
  const fitBounds = (bounds: SpatialBounds, immediate = false, minimum = config.minScale, requiredScale = 0, targetNode?: SpatialLayoutNode<TNode>) => {
    const width = Math.max(1, bounds.maxX - bounds.minX + 100);
    const height = Math.max(1, bounds.maxY - bounds.minY + 100);
    const fitScale = Math.min(4, Math.min(sizeRef.current.width / width, sizeRef.current.height / height) * 0.9);
    const scale = clamp(Math.max(config.minScale, Math.min(minimum, maxScale)), maxScale, Math.max(fitScale, requiredScale));
    const centerTarget = targetNode && requiredScale > fitScale;
    const centerX = centerTarget ? targetNode.x : (bounds.minX + bounds.maxX) / 2;
    const centerY = centerTarget ? targetNode.y + targetNode.height / 2 : (bounds.minY + bounds.maxY) / 2;
    const target = { x: sizeRef.current.width / 2 - centerX * scale, y: sizeRef.current.height / 2 - centerY * scale, scale };
    if (immediate) commitCamera(target);
    else animateTo(target);
  };
  const fitInitial = (immediate = false) => {
    const root = layout.nodes[0];
    setFocusId(root?.item.id ?? "");
    if (!root) return fitBounds(layout.initialBounds, immediate, 0.45);
    const narrow = sizeRef.current.width < 700;
    const desiredScale = clamp(
      narrow ? 0.2 : 0.45,
      1.2,
      Math.min(
        (sizeRef.current.width - (narrow ? 24 : 120)) / (2 * root.subtreeRadius),
        (sizeRef.current.height - (narrow ? 80 : 120)) / (2 * root.subtreeRadius),
      ),
    );
    const scale = clamp(config.minScale, maxScale, desiredScale);
    const centerX = (layout.initialBounds.minX + layout.initialBounds.maxX) / 2;
    const centerY = (layout.initialBounds.minY + layout.initialBounds.maxY) / 2;
    const target = { x: sizeRef.current.width / 2 - centerX * scale, y: sizeRef.current.height / 2 - centerY * scale, scale };
    if (immediate) commitCamera(target);
    else animateTo(target);
  };
  const focusNode = (id: string) => {
    const node = layout.nodeById.get(id);
    if (!node) return;
    setFocusId(id);
    fitBounds(node.subtreeBounds, false, config.minScale, config.readableWidth / node.width, node);
  };
  const pointFor = (clientX: number, clientY: number) => {
    const rect = stageBounds();
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
    const scale = clamp(config.minScale, maxScale, baseScale * Math.exp(-deltaY * config.wheelGain));
    const target = cameraAtAnchor(scale, anchor);
    const now = performance.now();
    if ((config.reducedMotion ?? motionPreference?.matches ?? false)) {
      cancelAnimation();
      commitCamera(target);
    } else if (wheel) {
      wheel.to = target;
      wheel.anchor = anchor;
    } else {
      cancelAnimation();
      const next: WheelAnimation = { kind: "wheel", frameId: 0, to: target, anchor, lastFrameAt: now };
      animationRef.current = next;
      next.frameId = requestAnimationFrame(tickAnimation);
    }
  };

  const zoomBy = (direction: number) => {
    const rect = stageBounds();
    const point = lastPointerRef.current ?? (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
    if (point) zoomAt(point.x, point.y, direction > 0 ? -config.zoomStep : config.zoomStep);
  };

  useLayoutEffect(() => {
    // Runtime layout/options take ownership before the next animation frame.
    cancelAnimation();
    dragRef.current = null;
    setIsDragging(false);
    stageBoundsRef.current = null;
    if (!layout.nodeById.has(focusId)) {
      fitInitial(true);
    } else {
      const current = cameraRef.current;
      const scale = clamp(config.minScale, maxScale, current.scale);
      if (scale !== current.scale) {
        const cursorX = sizeRef.current.width / 2;
        const cursorY = sizeRef.current.height / 2;
        commitCamera(cameraAtAnchor(scale, {
          cursorX, cursorY,
          worldX: (cursorX - current.x) / current.scale,
          worldY: (cursorY - current.y) / current.scale,
        }));
      }
    }
    return cancelAnimation;
  }, [layout, config, maxScale]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = (width: number, height: number) => {
      stageBoundsRef.current = null;
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
  }, [layout, config]);
  useEffect(() => {
    const invalidateBounds = () => { stageBoundsRef.current = null; };
    window.addEventListener("resize", invalidateBounds);
    window.addEventListener("scroll", invalidateBounds, true);
    return () => {
      window.removeEventListener("resize", invalidateBounds);
      window.removeEventListener("scroll", invalidateBounds, true);
    };
  }, []);
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
  }, [layout, config]);
  useEffect(() => () => {
    cancelAnimation();
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    stageBoundsRef.current = null;
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
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < config.panThreshold) return;
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
    focusNode,
    fitBounds,
    zoomAt,
    cancelMotion: cancelAnimation,
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
