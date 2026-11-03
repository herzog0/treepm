import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, WheelEvent as ReactWheelEvent } from "react";
import { childrenOf, tidyTreeLayout } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import { cameraForAnchor, captureWheelAnchor, createSemanticScene } from "./semanticScene.js";
import type { FocusTransition, SemanticCamera } from "./semanticScene.js";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  cameraX: number;
  cameraY: number;
  active: boolean;
}

const clamp = (minimum: number, maximum: number, value: number) => Math.min(maximum, Math.max(minimum, value));

export function useSemanticGestures(tickets: Ticket[]) {
  const layout = useMemo(() => tidyTreeLayout(tickets), [tickets]);
  const firstRoot = childrenOf(tickets, null)[0];
  const initialFocus = firstRoot?.id ?? tickets[0]?.id ?? "";
  const [focusId, setFocusId] = useState(initialFocus);
  const [transition, setTransition] = useState<FocusTransition | null>(null);
  const [attentionId, setAttentionId] = useState<string | null>(null);
  const [camera, setCamera] = useState<SemanticCamera>({ x: 0, y: 0, zoom: 0.82, scale: 1 });
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [isDragging, setIsDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraRef = useRef(camera);
  const focusRef = useRef(focusId);
  const transitionRef = useRef(transition);

  const sceneFor = (nextCamera: SemanticCamera, nextFocusId: string, nextTransition: FocusTransition | null) => createSemanticScene(layout, tickets, nextFocusId, nextTransition, nextCamera.zoom, size.width);
  const rendered = useMemo(() => createSemanticScene(layout, tickets, focusId, transition, camera.zoom, size.width), [layout, tickets, focusId, transition, camera.zoom, size.width]);

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

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (tickets.some((ticket) => ticket.id === focusId)) return;
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
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
  }, []);

  const focusTicket = (id: string) => {
    commitFocus(id, null);
  };
  const zoomBy = (amount: number) => {
    const current = cameraRef.current;
    const next = { ...current, zoom: clamp(0.5, 1.4, current.zoom + amount) };
    const anchor = captureWheelAnchor(size.width / 2, size.height / 2, new DOMRect(0, 0, size.width, size.height), current, rendered, null);
    const nextNodes = sceneFor(next, focusRef.current, transitionRef.current);
    commitCamera({ ...next, ...cameraForAnchor(anchor, nextNodes, next.scale) });
  };
  const fitContext = () => {
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
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      commitCamera({ ...current, x: current.x - event.deltaY - event.deltaX, y: current.y });
      return;
    }
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const target = event.target instanceof Element ? event.target.closest("[data-ticket-id]") : null;
    const ticketId = target?.getAttribute("data-ticket-id") ?? null;
    const currentFocus = focusRef.current;
    const currentTransition = transitionRef.current;
    const currentNodes = sceneFor(current, currentFocus, currentTransition);
    const anchor = captureWheelAnchor(event.clientX, event.clientY, stage, current, currentNodes, ticketId);
    const geometric = event.ctrlKey || event.metaKey;
    const direction = event.deltaY < 0 ? 1 : -1;
    const step = clamp(0.08, 0.28, Math.abs(event.deltaY) / 500);
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
          nextTransition = progress <= 0 ? null : { ...currentTransition, progress };
        }
      } else if (direction > 0 && ticketId !== currentFocus) {
        nextTransition = { fromId: currentFocus, toId: ticketId, progress: step };
      }
    }
    const next = {
      ...current,
      zoom: geometric ? current.zoom : clamp(0.5, 1.4, current.zoom - event.deltaY * 0.001),
      scale: geometric ? clamp(0.5, 1.6, current.scale - event.deltaY * 0.001) : current.scale,
    };
    const nextNodes = sceneFor(next, nextFocus, nextTransition);
    commitFocus(nextFocus, nextTransition);
    commitCamera({ ...next, ...cameraForAnchor(anchor, nextNodes, next.scale) });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    if (event.button === 1) event.preventDefault();
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
