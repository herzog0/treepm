import type { CSSProperties, ReactNode } from "react";
import type { TreeNode } from "@treepm/engine";
import type { RenderNodeContent, SpatialNodeContent } from "./appearance.js";
import { IndicatorGroup } from "./IndicatorGroup.js";
import { SpatialNode, SpatialRegion } from "./SpatialNode.js";
import { useSpatialCanvas } from "./useSpatialCanvas.js";
import type { SpatialCanvasController, SpatialCanvasOptions } from "./useSpatialCanvas.js";

export interface SpatialCanvasClassNames {
  readonly root?: string;
  readonly stage?: string;
  readonly scene?: string;
  readonly background?: string;
  readonly region?: string;
  readonly node?: string;
  readonly group?: string;
  readonly toolbar?: string;
}
export interface SpatialCanvasLabels {
  readonly canvas: string;
  readonly toolbar: string;
  readonly zoomOut: string;
  readonly reset: string;
  readonly zoomIn: string;
  readonly colors: string;
}
export type SpatialCanvasStyle = CSSProperties & { [token: `--${string}`]: string | number };
export interface SpatialCanvasViewProps<TNode extends TreeNode> {
  readonly className?: string;
  readonly classNames?: SpatialCanvasClassNames;
  readonly style?: SpatialCanvasStyle;
  readonly labels?: Partial<SpatialCanvasLabels>;
  readonly controls?: boolean;
  readonly showBackground?: boolean;
  readonly showRegions?: boolean;
  readonly renderNodeContent?: RenderNodeContent<TNode>;
  readonly getNodeAriaLabel?: (context: SpatialNodeContent<TNode>) => string;
  readonly getGroupAriaLabel?: (members: readonly TNode[]) => string;
  readonly renderContext?: (controller: SpatialCanvasController<TNode>) => ReactNode;
  readonly renderOverlay?: (controller: SpatialCanvasController<TNode>) => ReactNode;
  readonly renderControls?: (controller: SpatialCanvasController<TNode>) => ReactNode;
  readonly children?: ReactNode;
}
export interface SpatialCanvasProps<TNode extends TreeNode> extends SpatialCanvasOptions<TNode>, SpatialCanvasViewProps<TNode> {}

/** Hook + view convenience component. CSS is opt-in through @treepm/react/styles.css. */
export function SpatialCanvas<TNode extends TreeNode>(props: SpatialCanvasProps<TNode>) {
  const controller = useSpatialCanvas(props);
  return <SpatialCanvasView {...props} controller={controller} />;
}

/** Compose this view with useSpatialCanvas when commands are needed outside render slots. */
export function SpatialCanvasView<TNode extends TreeNode>({ controller, ...props }: SpatialCanvasViewProps<TNode> & { readonly controller: SpatialCanvasController<TNode> }) {
  const { scene, camera, index, filled, selectedId, selectNode, appearances, reducedMotion, mixColors } = controller;
  const classes = props.classNames;
  const labels: SpatialCanvasLabels = { canvas: "Spatial canvas", toolbar: "Camera and colors", zoomOut: "Zoom out", reset: "Reset view", zoomIn: "Zoom in", colors: "Colors", ...props.labels };
  return <div data-spatial-canvas="" ref={controller.rootRef}
    className={`spatial-shell ${filled ? "is-color-mode" : ""} ${classes?.root ?? ""} ${props.className ?? ""}`} style={props.style}
    onPointerEnter={() => { controller.pointerInsideRef.current = true; }}
    onPointerLeave={() => { controller.pointerInsideRef.current = false; }}>
    {props.renderContext?.(controller)}
    <div className={`spatial-stage ${controller.isDragging ? "is-dragging" : ""} ${classes?.stage ?? ""}`}
      ref={controller.stageRef} role="region" aria-label={labels.canvas} tabIndex={0}
      onClick={(event) => { if (event.target === event.currentTarget) selectNode(null); }} {...controller.gestureHandlers}>
      {props.showBackground !== false && <div className={`spatial-constellation ${classes?.background ?? ""}`} aria-hidden="true" />}
      <div className={`spatial-scene ${classes?.scene ?? ""}`} style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0)` }}>
        {props.showRegions !== false && scene.regions.map((region) => <SpatialRegion key={region.id} {...region} className={classes?.region} />)}
        {scene.nodes.map((node) => <SpatialNode key={node.id} {...node} selected={selectedId === node.id} index={index}
          appearance={appearances.get(node.id) ?? { label: node.id, color: "#6853a5" }}
          reducedMotion={reducedMotion} onSelect={selectNode} className={classes?.node}
          renderNodeContent={props.renderNodeContent} getNodeAriaLabel={props.getNodeAriaLabel} />)}
        {scene.groups.map((group) => <IndicatorGroup key={group.id} {...group} index={index} appearances={appearances}
          mixColors={mixColors} className={classes?.group} getGroupAriaLabel={props.getGroupAriaLabel} />)}
      </div>
      {props.controls !== false && (props.renderControls ? props.renderControls(controller) : <div className={`spatial-toolbar ${classes?.toolbar ?? ""}`} role="toolbar" aria-label={labels.toolbar} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => controller.zoomBy(-1)} aria-label={labels.zoomOut}>−</button>
        <button type="button" onClick={() => controller.fitInitial()} aria-label={labels.reset}>⌂</button>
        <button type="button" onClick={() => controller.zoomBy(1)} aria-label={labels.zoomIn}>+</button>
        <button type="button" className="spatial-color-toggle" onClick={controller.toggleFilled} aria-pressed={filled} aria-keyshortcuts="C">{labels.colors}</button>
      </div>)}
      {props.renderOverlay?.(controller)}
      {props.children}
    </div>
  </div>;
}
