import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, WheelEvent as ReactWheelEvent } from "react";
import { flushSync } from "react-dom";
import { childrenOf, tidyTreeLayout } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import { blendSemanticScenes, CLICK_SEMANTIC_ZOOM, cameraForAnchor, captureWheelAnchor, createSemanticScene } from "./semanticScene.js";
import type { FocusTransition, SemanticCamera, SemanticSceneNode, WheelAnchor } from "./semanticScene.js";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  cameraX: number;
  cameraY: number;
  active: boolean;
}

interface AnchoredAnimation {
  type: "focus" | "wheel";
  fromScene: SemanticSceneNode[];
  fromCamera: SemanticCamera;
  toCamera: SemanticCamera;
  toFocusId: string;
  toTransition: FocusTransition | null;
  anchor: WheelAnchor;
  frameId: number;
  timerId?: number;
}

type SemanticAnimation = AnchoredAnimation;

const clamp = (minimum: number, maximum: number, value: number) => Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const focusEase = (progress: number) => progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
const wheelEase = (progress: number) => 1 - Math.pow(1 - progress, 3);
const FOCUS_DURATION = 220;
const WHEEL_DURATION = 180;

export function useSemanticGestures(tickets: Ticket[], focusOnClick: boolean) {
  const layout = useMemo(() => tidyTreeLayout(tickets), [tickets]);
  const firstRoot = childrenOf(tickets, null)[0];
  const initialFocus = firstRoot?.id ?? tickets[0]?.id ?? "";
  const [focusId, setFocusId] = useState(initialFocus);
  const [transition, setTransition] = useState<FocusTransition | null>(null);
  const [sceneOverride, setSceneOverride] = useState<SemanticSceneNode[] | null>(null);
  const [attentionId, setAttentionId] = useState<string | null>(null);
  const [camera, setCamera] = useState<SemanticCamera>({ x: 0, y: 0, zoom: 1.28, scale: 1 });
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [isDragging, setIsDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationRef = useRef<SemanticAnimation | null>(null);
  const cameraRef = useRef(camera);
  const focusRef = useRef(focusId);
  const transitionRef = useRef(transition);
  const sceneOverrideRef = useRef(sceneOverride);
  const sizeRef = useRef(size);

  const sceneFor = (nextCamera: SemanticCamera, nextFocusId: string, nextTransition: FocusTransition | null, viewportWidth = sizeRef.current.width) => createSemanticScene(layout, tickets, nextFocusId, nextTransition, nextCamera.zoom, viewportWidth);
  const generated = useMemo(() => createSemanticScene(layout, tickets, focusId, transition, camera.zoom, size.width), [layout, tickets, focusId, transition, camera.zoom, size.width]);
  const rendered = sceneOverride ?? generated;

  const commitCamera = (next: SemanticCamera) => {
    cameraRef.current = next;
    setCamera(next);
  };
  const commitFocus = (nextFocusId: string, nextTransition: FocusTransition | null) => {
    focusRef.current = nextFocusId;
    transitionRef.current = nextTransition;
    setFocusId(nextFocusId);
    setTransition(nextTransition);
  };
  const commitScene = (next: SemanticSceneNode[] | null) => {
    sceneOverrideRef.current = next;
    setSceneOverride(next);
  };
  const currentScene = () => sceneOverrideRef.current ?? sceneFor(cameraRef.current, focusRef.current, transitionRef.current);
  const cancelAnimation = () => {
    const animation = animationRef.current;
    if (animation) cancelAnimationFrame(animation.frameId);
    if (animation?.timerId !== undefined) clearTimeout(animation.timerId);
    animationRef.current = null;
  };
  const completeAnchoredAnimation = (animation: AnchoredAnimation) => {
    const finalNodes = sceneFor(animation.toCamera, animation.toFocusId, animation.toTransition);
    const finalCamera = { ...animation.toCamera, ...cameraForAnchor(animation.anchor, finalNodes, animation.toCamera.scale) };
    animationRef.current = null;
    commitScene(null);
    commitFocus(animation.toFocusId, animation.toTransition);
    commitCamera(finalCamera);
  };
  const startAnchoredAnimation = (type: "focus" | "wheel", toFocusId: string, toTransition: FocusTransition | null, toCamera: SemanticCamera, anchor: WheelAnchor) => {
    const fromScene = currentScene();
    const fromCamera = cameraRef.current;
    cancelAnimation();
    const targetNodes = sceneFor(toCamera, toFocusId, toTransition);
    const targetCamera = { ...toCamera, ...cameraForAnchor(anchor, targetNodes, toCamera.scale) };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      commitScene(null);
      commitFocus(toFocusId, toTransition);
      commitCamera(targetCamera);
      return;
    }
    const animation: AnchoredAnimation = { type, fromScene, fromCamera, toCamera: targetCamera, toFocusId, toTransition, anchor, frameId: 0 };
    animationRef.current = animation;
    const startedAt = performance.now();
    let firstFrame = true;
    const tick = (timestamp: number) => {
      if (animationRef.current !== animation) return;
      const duration = type === "focus" ? FOCUS_DURATION : WHEEL_DURATION;
      const linear = clamp(0, 1, (timestamp - startedAt) / duration);
      if (linear >= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        completeAnchoredAnimation(animation);
        return;
      }
      const progress = type === "focus" ? focusEase(linear) : wheelEase(linear);
      const zoom = lerp(fromCamera.zoom, animation.toCamera.zoom, progress);
      const scale = lerp(fromCamera.scale, animation.toCamera.scale, progress);
      const targetNodes = sceneFor(animation.toCamera, animation.toFocusId, animation.toTransition);
      const nextNodes = blendSemanticScenes(layout, fromScene, targetNodes, progress, zoom, sizeRef.current.width);
      const commitFrame = () => {
        commitScene(nextNodes);
        commitCamera({ zoom, scale, ...cameraForAnchor(anchor, nextNodes, scale) });
      };
      if (firstFrame) {
        firstFrame = false;
        flushSync(commitFrame);
      } else commitFrame();
      animation.frameId = requestAnimationFrame(tick);
    };
    animation.timerId = window.setTimeout(() => tick(performance.now()), 0);
  };
  const capturePointerAnchor = (point?: { clientX: number; clientY: number }, ticketId?: string) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return captureWheelAnchor(0, 0, new DOMRect(), cameraRef.current, currentScene(), null);
    const candidate = point ?? lastPointerRef.current;
    const resolved = candidate ?? { clientX: stage.left + stage.width / 2, clientY: stage.top + stage.height / 2 };
    let resolvedTicketId = point && ticketId ? ticketId : null;
    if (!resolvedTicketId) {
      const target = document.elementFromPoint(resolved.clientX, resolved.clientY)?.closest("[data-indicator-ticket-id], [data-ticket-id]");
      resolvedTicketId = target?.getAttribute("data-indicator-ticket-id") ?? target?.getAttribute("data-ticket-id") ?? null;
    }
    return captureWheelAnchor(resolved.clientX, resolved.clientY, stage, cameraRef.current, currentScene(), resolvedTicketId);
  };

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      const current = cameraRef.current;
      const anchor = !animationRef.current && lastPointerRef.current ? capturePointerAnchor() : null;
      sizeRef.current = nextSize;
      if (anchor) {
        const nextNodes = sceneFor(current, focusRef.current, transitionRef.current, nextSize.width);
        commitCamera({ ...current, ...cameraForAnchor(anchor, nextNodes, current.scale) });
      }
      setSize(nextSize);
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [layout, tickets]);
  useEffect(() => {
    if (tickets.some((ticket) => ticket.id === focusId)) return;
    cancelAnimation();
    commitScene(null);
    commitFocus(initialFocus, null);
  }, [tickets, focusId, initialFocus]);
  useEffect(() => {
    const preventNativeGesture = (event: Event) => {
      if (dragRef.current) event.preventDefault();
    };
    document.addEventListener("selectstart", preventNativeGesture, true);
    document.addEventListener("dragstart", preventNativeGesture, true);
    return () => {
      document.removeEventListener("selectstart", preventNativeGesture, true);
      document.removeEventListener("dragstart", preventNativeGesture, true);
    };
  }, []);
  useEffect(() => () => {
    cancelAnimation();
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
  }, []);

  const focusTicket = (id: string, point?: { clientX: number; clientY: number }) => {
    if (animationRef.current?.type === "focus" && animationRef.current.toFocusId === id) return;
    if (!sceneOverrideRef.current && !transitionRef.current && focusRef.current === id && Math.abs(cameraRef.current.zoom - CLICK_SEMANTIC_ZOOM) < 1e-9) return;
    const current = cameraRef.current;
    const anchor = capturePointerAnchor(point, id);
    startAnchoredAnimation("focus", id, null, { ...current, zoom: CLICK_SEMANTIC_ZOOM }, anchor);
  };
  const zoomBy = (amount: number) => {
    const active = animationRef.current;
    const current = cameraRef.current;
    const baseCamera = active?.toCamera ?? current;
    const next = { ...baseCamera, zoom: clamp(0.5, 1.4, baseCamera.zoom + amount) };
    const anchor = capturePointerAnchor();
    startAnchoredAnimation("wheel", active?.toFocusId ?? focusRef.current, active?.toTransition ?? transitionRef.current, next, anchor);
  };
  const fitContext = () => {
    cancelAnimation();
    const visible = rendered.filter((node) => node.opacity > 0.05 && node.width > 0);
    if (!visible.length) return;
    const minX = Math.min(...visible.map((node) => node.position.x - node.layoutWidth / 2));
    const maxX = Math.max(...visible.map((node) => node.position.x + node.layoutWidth / 2));
    const minY = Math.min(...visible.map((node) => node.position.y));
    const maxY = Math.max(...visible.map((node) => node.position.y + node.layoutHeight));
    const current = cameraRef.current;
    commitCamera({
      ...current,
      x: size.width / 2 - ((minX + maxX) / 2) * current.scale,
      y: Math.max(24, (size.height - (maxY - minY) * current.scale) / 2 - minY * current.scale),
    });
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    const current = cameraRef.current;
    const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sizeRef.current.height : 1;
    const deltaY = event.deltaY * deltaUnit;
    const deltaX = event.deltaX * deltaUnit;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      cancelAnimation();
      commitCamera({ ...current, x: current.x - deltaY - deltaX, y: current.y });
      return;
    }
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const target = event.target instanceof Element ? event.target.closest("[data-indicator-ticket-id], [data-ticket-id]") : null;
    const ticketId = target?.getAttribute("data-indicator-ticket-id") ?? target?.getAttribute("data-ticket-id") ?? null;
    const active = animationRef.current?.type === "wheel" ? animationRef.current : null;
    const baseCamera = active?.toCamera ?? current;
    const currentFocus = active?.toFocusId ?? focusRef.current;
    const currentTransition = active?.toTransition ?? transitionRef.current;
    const anchor = captureWheelAnchor(event.clientX, event.clientY, stage, current, currentScene(), ticketId);
    const geometric = event.ctrlKey || event.metaKey;
    const direction = deltaY < 0 ? 1 : -1;
    const step = clamp(0.08, 0.28, Math.abs(deltaY) / 500);
    let nextFocus = currentFocus;
    let nextTransition = currentTransition;
    if (!geometric && ticketId) {
      if (currentTransition) {
        const focusDirection = ticketId === currentTransition.toId ? 1 : ticketId === currentTransition.fromId ? -1 : 0;
        const progress = clamp(0, 1, currentTransition.progress + direction * focusDirection * step);
        if (progress >= 1) {
          nextFocus = currentTransition.toId;
          nextTransition = null;
        } else {
          nextTransition = progress <= 0 && !currentTransition.fromScene ? null : { ...currentTransition, progress };
        }
      } else if (direction > 0 && ticketId !== currentFocus) {
        nextTransition = { fromId: currentFocus, toId: ticketId, progress: step };
      }
    }
    const next = {
      ...baseCamera,
      zoom: geometric ? baseCamera.zoom : clamp(0.5, 1.4, baseCamera.zoom - deltaY * 0.001),
      scale: geometric ? clamp(0.5, 1.6, baseCamera.scale - deltaY * 0.001) : baseCamera.scale,
    };
    if (!geometric && direction > 0 && next.zoom === 1.4 && nextTransition && ticketId === nextTransition.toId) {
      nextFocus = nextTransition.toId;
      nextTransition = null;
    }
    startAnchoredAnimation("wheel", nextFocus, nextTransition, next, anchor);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (event.button === 1) event.preventDefault();
    if (focusOnClick && event.button === 0 && event.target instanceof Element && event.target.closest("[data-ticket-id]")) cancelAnimation();
    const current = cameraRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: current.x,
      cameraY: current.y,
      active: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      dragRef.current = null;
      setIsDragging(false);
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.active && Math.hypot(deltaX, deltaY) < 5) return;
    if (!drag.active) {
      drag.active = true;
      cancelAnimation();
      setIsDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const current = cameraRef.current;
    commitCamera({ ...current, x: drag.cameraX + deltaX, y: drag.cameraY + deltaY });
  };
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, releaseCapture: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (releaseCapture && drag.active && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (releaseCapture && drag.active) {
      suppressClickRef.current = true;
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };
  const preventNativeGesture = (event: SyntheticEvent) => {
    if (dragRef.current) event.preventDefault();
  };

  return {
    camera,
    focusId,
    transition,
    attentionId,
    rendered,
    size,
    stageRef,
    isDragging,
    focusTicket,
    setAttentionId,
    zoomBy,
    fitContext,
    gestureHandlers: {
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, true),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, false),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, false),
      onClickCapture,
      onSelectStart: preventNativeGesture,
      onDragStart: preventNativeGesture,
    },
  };
}
