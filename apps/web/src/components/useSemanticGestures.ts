import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, WheelEvent as ReactWheelEvent } from "react";
import { flushSync } from "react-dom";
import { childrenOf, tidyTreeLayout } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import { blendSemanticScenes, cameraForAnchor, captureWheelAnchor, createSemanticScene } from "./semanticScene.js";
import type { FocusTransition, SemanticCamera, SemanticSceneNode, WheelAnchor } from "./semanticScene.js";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  cameraX: number;
  cameraY: number;
  active: boolean;
}

interface FocusAnimation {
  type: "focus";
  toId: string;
  startCamera: SemanticCamera;
  endCamera: SemanticCamera;
  frameId: number;
}

interface WheelAnimation {
  type: "wheel";
  fromScene: SemanticSceneNode[];
  fromCamera: SemanticCamera;
  toCamera: SemanticCamera;
  toFocusId: string;
  toTransition: FocusTransition | null;
  anchor: WheelAnchor;
  frameId: number;
  timerId?: number;
}

type SemanticAnimation = FocusAnimation | WheelAnimation;

const clamp = (minimum: number, maximum: number, value: number) => Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const focusEase = (progress: number) => progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
const wheelEase = (progress: number) => 1 - Math.pow(1 - progress, 3);
const FOCUS_DURATION = 220;
const WHEEL_DURATION = 180;

export function useSemanticGestures(tickets: Ticket[]) {
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
    if (animation?.type === "wheel" && animation.timerId !== undefined) clearTimeout(animation.timerId);
    animationRef.current = null;
  };
  const completeWheelAnimation = (animation: WheelAnimation) => {
    const finalNodes = sceneFor(animation.toCamera, animation.toFocusId, animation.toTransition);
    const finalCamera = { ...animation.toCamera, ...cameraForAnchor(animation.anchor, finalNodes, animation.toCamera.scale) };
    animationRef.current = null;
    commitScene(null);
    commitFocus(animation.toFocusId, animation.toTransition);
    commitCamera(finalCamera);
  };
  const startWheelAnimation = (toFocusId: string, toTransition: FocusTransition | null, toCamera: SemanticCamera, anchor: WheelAnchor) => {
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
    const animation: WheelAnimation = { type: "wheel", fromScene, fromCamera, toCamera: targetCamera, toFocusId, toTransition, anchor, frameId: 0 };
    animationRef.current = animation;
    const startedAt = performance.now();
    let firstFrame = true;
    const tick = (timestamp: number) => {
      if (animationRef.current !== animation) return;
      const linear = clamp(0, 1, (timestamp - startedAt) / WHEEL_DURATION);
      if (linear >= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        completeWheelAnimation(animation);
        return;
      }
      const progress = wheelEase(linear);
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

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      const widthDelta = (nextSize.width - sizeRef.current.width) / 2;
      sizeRef.current = nextSize;
      const animation = animationRef.current;
      if (animation?.type === "focus" && widthDelta !== 0) {
        animation.startCamera = { ...animation.startCamera, x: animation.startCamera.x - widthDelta };
        const finalNodes = sceneFor(animation.endCamera, animation.toId, null, nextSize.width);
        const focused = finalNodes.find((node) => node.node.ticket.id === animation.toId);
        if (focused) {
          const margin = Math.min(140, nextSize.width * 0.25);
          const center = animation.endCamera.x + focused.position.x * animation.endCamera.scale;
          const visibleCenter = clamp(margin, nextSize.width - margin, center);
          animation.endCamera = { ...animation.endCamera, x: animation.endCamera.x + visibleCenter - center };
        }
        const current = cameraRef.current;
        commitCamera({ ...current, x: current.x - widthDelta });
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

  const focusTicket = (id: string) => {
    if (animationRef.current?.type === "focus" && animationRef.current.toId === id) return;
    if (!sceneOverrideRef.current && !transitionRef.current && focusRef.current === id) return;
    cancelAnimation();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      commitScene(null);
      commitFocus(id, null);
      return;
    }
    const current = cameraRef.current;
    const currentFocus = focusRef.current;
    const currentNodes = currentScene();
    if (!currentNodes.some((node) => node.node.ticket.id === id)) {
      commitScene(null);
      commitFocus(id, null);
      return;
    }
    const startedAt = performance.now();
    const initialTransition: FocusTransition = { fromId: currentFocus, toId: id, progress: 0, fromScene: currentNodes };
    const animation: FocusAnimation = { type: "focus", toId: id, startCamera: current, endCamera: current, frameId: 0 };
    animationRef.current = animation;
    commitScene(null);
    commitFocus(currentFocus, initialTransition);

    const complete = () => {
      animationRef.current = null;
      commitScene(null);
      commitFocus(id, null);
      commitCamera(animation.endCamera);
    };
    const tick = (timestamp: number) => {
      if (animationRef.current !== animation) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        complete();
        return;
      }
      const linear = clamp(0, 1, (timestamp - startedAt) / FOCUS_DURATION);
      if (linear >= 1) {
        complete();
        return;
      }
      const progress = focusEase(linear);
      const nextTransition = { ...initialTransition, progress };
      commitFocus(currentFocus, nextTransition);
      commitCamera({
        ...current,
        x: lerp(animation.startCamera.x, animation.endCamera.x, progress),
        y: lerp(animation.startCamera.y, animation.endCamera.y, progress),
      });
      animation.frameId = requestAnimationFrame(tick);
    };
    animation.frameId = requestAnimationFrame(tick);
  };
  const zoomBy = (amount: number) => {
    const active = animationRef.current?.type === "wheel" ? animationRef.current : null;
    const current = cameraRef.current;
    const baseCamera = active?.toCamera ?? current;
    const next = { ...baseCamera, zoom: clamp(0.5, 1.4, baseCamera.zoom + amount) };
    const viewport = sizeRef.current;
    const anchor = captureWheelAnchor(viewport.width / 2, viewport.height / 2, new DOMRect(0, 0, viewport.width, viewport.height), current, currentScene(), null);
    startWheelAnimation(active?.toFocusId ?? focusRef.current, active?.toTransition ?? transitionRef.current, next, anchor);
  };
  const fitContext = () => {
    cancelAnimation();
    const visible = rendered.filter((node) => node.opacity > 0.05 && node.width > 0);
    if (!visible.length) return;
    const minX = Math.min(...visible.map((node) => node.position.x - node.width / 2));
    const maxX = Math.max(...visible.map((node) => node.position.x + node.width / 2));
    const minY = Math.min(...visible.map((node) => node.position.y));
    const maxY = Math.max(...visible.map((node) => node.position.y + node.height));
    const current = cameraRef.current;
    commitCamera({
      ...current,
      x: size.width / 2 - ((minX + maxX) / 2) * current.scale,
      y: Math.max(24, (size.height - (maxY - minY) * current.scale) / 2 - minY * current.scale),
    });
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
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
    const target = event.target instanceof Element ? event.target.closest("[data-ticket-id]") : null;
    const ticketId = target?.getAttribute("data-ticket-id") ?? null;
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
    startWheelAnimation(nextFocus, nextTransition, next, anchor);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    if (event.button === 1) event.preventDefault();
    if (event.button === 0 && event.target instanceof Element && event.target.closest("[data-ticket-id]")) cancelAnimation();
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
