import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTreeIndex, buildSpatialLayout, buildSpatialScene } from "@treepm/engine";
import type { SpatialLayoutOptions, SpatialSceneOptions, TreeNode } from "@treepm/engine";
import type { NodeAppearance, SpatialAppearance } from "./appearance.js";
import { defaultGetColor, defaultGetLabel } from "./appearance.js";
import { useSpatialCamera } from "./useSpatialCamera.js";
import type { SpatialCameraOptions } from "./useSpatialCamera.js";
import { useReducedMotion } from "./useReducedMotion.js";

export interface SpatialCanvasOptions<TNode extends TreeNode> extends SpatialAppearance<TNode> {
  readonly items: readonly TNode[];
  readonly appearance?: SpatialAppearance<TNode>;
  readonly layoutOptions?: SpatialLayoutOptions<TNode>;
  readonly sceneOptions?: SpatialSceneOptions;
  readonly cameraOptions?: SpatialCameraOptions;
  readonly selectedId?: string | null;
  readonly defaultSelectedId?: string | null;
  readonly defaultFilled?: boolean;
  readonly keyboardShortcuts?: boolean;
  readonly onSelectionChange?: (node: TNode | null) => void;
  readonly onFocusChange?: (node: TNode | null) => void;
}

export function useSpatialCanvas<TNode extends TreeNode>(options: SpatialCanvasOptions<TNode>) {
  const { items, layoutOptions, sceneOptions, cameraOptions, selectedId: controlledId, onSelectionChange, onFocusChange } = options;
  const getLabel = options.getLabel ?? options.appearance?.getLabel ?? defaultGetLabel;
  const getColor = options.getColor ?? options.appearance?.getColor ?? defaultGetColor;
  const mixColors = options.mixColors ?? options.appearance?.mixColors;
  const index = useMemo(() => buildTreeIndex(items), [items]);
  const dimensions = layoutOptions?.dimensions;
  const dimensionsKey = typeof dimensions === "function" ? undefined : JSON.stringify(dimensions);
  const normalization = layoutOptions?.normalization;
  // Inline value-only options must not rebuild layout/cancel motion on each hook render.
  const layout = useMemo(() => buildSpatialLayout(index, layoutOptions), [index,
    typeof dimensions === "function" ? dimensions : undefined, dimensionsKey,
    layoutOptions?.rootGap, layoutOptions?.childGap, normalization === false,
    normalization && normalization.heightStart, normalization && normalization.heightFactor,
    normalization && normalization.heightPadding, normalization && normalization.minGap,
  ]);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerInsideRef = useRef(false);
  const motion = useReducedMotion();
  const reducedMotion = cameraOptions?.reducedMotion ?? motion;
  const cameraController = useSpatialCamera(layout, stageRef, cameraOptions);
  const { camera, size } = cameraController;
  const focusId = index.itemById.has(cameraController.focusId) ? cameraController.focusId : layout.nodes[0]?.item.id ?? "";
  const [internalId, setInternalId] = useState<string | null>(options.defaultSelectedId ?? null);
  const requestedId = controlledId === undefined ? internalId : controlledId;
  const selectedId = requestedId && index.itemById.has(requestedId) ? requestedId : null;
  const invalidSelectionRef = useRef<string | null>(null);
  const selected = selectedId ? index.itemById.get(selectedId) ?? null : null;
  const [filled, setFilled] = useState(options.defaultFilled ?? true);
  const toggleFilled = useCallback(() => setFilled((current) => !current), []);
  const selectNode = useCallback((id: string | null) => {
    const node = id ? index.itemById.get(id) ?? null : null;
    if (controlledId === undefined) setInternalId(node?.id ?? null);
    onSelectionChange?.(node);
  }, [index, controlledId, onSelectionChange]);
  const appearances = useMemo(() => {
    const result = new Map<string, NodeAppearance>();
    for (const item of items) result.set(item.id, { label: getLabel(item), color: getColor(item) });
    return result;
  }, [items, getLabel, getColor]);
  const scene = useMemo(() => buildSpatialScene(layout, index,
    { x: 0, y: 0, scale: camera.scale },
    { ...size, x: -camera.x, y: -camera.y }, sceneOptions),
  [layout, index, camera.x, camera.y, camera.scale, size, sceneOptions]);
  const breadcrumb = useMemo(() => {
    const path: TNode[] = [];
    let current = index.itemById.get(focusId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? index.itemById.get(current.parentId) : undefined;
    }
    return path;
  }, [index, focusId]);

  useEffect(() => {
    if (requestedId && !index.itemById.has(requestedId)) {
      if (controlledId === undefined) setInternalId(null);
      if (invalidSelectionRef.current !== requestedId) onSelectionChange?.(null);
      invalidSelectionRef.current = requestedId;
    } else invalidSelectionRef.current = null;
  }, [index, requestedId, controlledId, onSelectionChange]);

  useEffect(() => { onFocusChange?.(index.itemById.get(focusId) ?? null); }, [index, focusId, onFocusChange]);
  useEffect(() => {
    if (options.keyboardShortcuts === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editable = (element: EventTarget | null) => element instanceof HTMLElement && (element.isContentEditable || element.closest("input, textarea, select, [contenteditable]"));
      const editing = editable(target) || editable(document.activeElement);
      if (editing || event.defaultPrevented) return;
      // A focused/target canvas always wins over another canvas under the pointer.
      const targetCanvas = target instanceof Element ? target.closest("[data-spatial-canvas]") : null;
      const focusedCanvas = document.activeElement?.closest("[data-spatial-canvas]");
      const activeCanvas = targetCanvas ?? focusedCanvas;
      const ownsKeyboard = activeCanvas ? activeCanvas === rootRef.current : pointerInsideRef.current;
      if (!ownsKeyboard) return;
      if (event.key === "Escape") selectNode(null);
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      event.preventDefault();
      toggleFilled();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options.keyboardShortcuts, selectNode, toggleFilled]);

  return { ...cameraController, index, layout, scene, focusId, stageRef, rootRef, pointerInsideRef, selectedId, selected, selectNode, filled, setFilled, toggleFilled, reducedMotion, appearances, mixColors, breadcrumb };
}
export type SpatialCanvasController<TNode extends TreeNode> = ReturnType<typeof useSpatialCanvas<TNode>>;
