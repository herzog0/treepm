import { memo, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { equalSemanticProps, nodeGeometryStyles, regionGeometryStyle, useGeometrySeed } from "./useGeometryStyle.js";
import type { NodeGeometry, RegionGeometry } from "./useGeometryStyle.js";
import type { GeometryRegistry } from "./useSceneGeometry.js";
import type { SpatialLod, SpatialSceneNode, SpatialLayoutNode, TreeIndex, TreeNode } from "@treepm/engine";

import type { NodeAppearance, RenderNodeContent, SpatialNodeContent } from "./appearance.js";

interface SpatialNodeProps<TNode extends TreeNode> {
  id: string;
  node: SpatialLayoutNode<TNode>;
  lod: SpatialLod;
  aggregate: boolean;
  representation: SpatialSceneNode<TNode>["representation"];
  interactive: boolean;
  initialGeometry: NodeGeometry;
  registry: GeometryRegistry;
  selected: boolean;
  index: TreeIndex<TNode>;
  appearance: NodeAppearance;
  renderNodeContent?: RenderNodeContent<TNode>;
  getNodeAriaLabel?: (context: SpatialNodeContent<TNode>) => string;
  className?: string;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
}

interface SpatialRegionProps {
  id: string;
  className?: string;
  initialGeometry: RegionGeometry;
  registry: GeometryRegistry;
}
export const SpatialRegion = memo(function SpatialRegion(props: SpatialRegionProps) {
  const { ref, initialStyle } = useGeometrySeed(regionGeometryStyle(props.initialGeometry), props.registry.regionRef, props.id);
  return useMemo(() => <div ref={ref} className={`spatial-region ${props.className ?? ""}`} aria-hidden="true" data-region-id={props.id} style={initialStyle} />,
    [ref, initialStyle, props.id, props.className]);
}, equalSemanticProps);

interface NodeContentProps<TNode extends TreeNode> {
  node: TNode;
  renderNodeContent?: RenderNodeContent<TNode>;
  id: string;
  label: string;
  depth: number;
  childCount: number;
  descendantCount: number;
  lod: SpatialLod;
  aggregate: boolean;
  reducedMotion: boolean;
}

// Camera coordinates, selection and callbacks never invalidate semantic content.
function NodeContentView<TNode extends TreeNode>(props: NodeContentProps<TNode>) {
  const { id, label, depth, childCount, descendantCount, lod, aggregate, reducedMotion } = props;
  return <span key={`${lod}:${aggregate}`} className="spatial-lod-content" data-lod-transition="stable"
    style={reducedMotion ? { animation: "none" } : undefined}>
    {props.renderNodeContent ? props.renderNodeContent({ node: props.node, label, lod, aggregate, depth, childCount, descendantCount }) : lod === "dot" ? null : <>
      <span className="spatial-key">{id}</span>
      <strong>{label}</strong>
      {lod === "full" && <span className="spatial-card-meta">{childCount} children · depth {depth}</span>}
      {aggregate && <span className="spatial-aggregate-count">{descendantCount} descendants</span>}
    </>}
  </span>;
}
// React.memo retains runtime shallow equality; this signature retains consumer inference.
const NodeContent = memo(NodeContentView) as typeof NodeContentView;

function SpatialNodeView<TNode extends TreeNode>(props: SpatialNodeProps<TNode>) {
  const { node, lod, aggregate, representation, interactive } = props;
  const item = node.item;
  const childCount = props.index.childrenByParentId.get(item.id)?.length ?? 0;
  const descendantCount = props.index.descendantCountById.get(item.id) ?? 0;
  const indicator = representation === "indicator";
  const initial = nodeGeometryStyles(props.initialGeometry);
  const articleGeometry = useGeometrySeed(initial.article, props.registry.articleRef, props.id, props.initialGeometry.reveal);
  const surfaceGeometry = useGeometrySeed(initial.surface, props.registry.surfaceRef, props.id);
  const style: CSSProperties & { "--spatial-color": string } = useMemo(() => ({
    ...articleGeometry.initialStyle,
    "--spatial-color": props.appearance.color,
  }), [articleGeometry.initialStyle, props.appearance.color]);

  const label = useMemo(
    () => props.getNodeAriaLabel?.({ node: item, label: props.appearance.label, lod, aggregate, depth: node.depth, childCount, descendantCount }) ?? `${item.id} · ${props.appearance.label}. ${childCount} children, ${descendantCount} descendants.`,
    [item, props.appearance.label, props.getNodeAriaLabel, lod, aggregate, node.depth, childCount, descendantCount],
  );
  const content = useMemo(() => <NodeContent id={item.id} node={item} renderNodeContent={props.renderNodeContent} label={props.appearance.label} depth={node.depth}
    childCount={childCount} descendantCount={descendantCount} lod={lod} aggregate={aggregate} reducedMotion={props.reducedMotion} />,
  [item, props.appearance.label, props.renderNodeContent, node.depth, childCount, descendantCount, lod, aggregate, props.reducedMotion]);
  const { onSelect } = props;
  const select = useCallback(() => {
    if (interactive) onSelect(item.id);
  }, [interactive, onSelect, item.id]);
  const buttonGeometry = useGeometrySeed(initial.button, props.registry.buttonRef, props.id);
  const button = useMemo(() => <button ref={buttonGeometry.ref} type="button" className="spatial-card-button" style={buttonGeometry.initialStyle}
    tabIndex={interactive ? 0 : -1} aria-hidden={indicator ? true : undefined}
    aria-label={label} aria-pressed={props.selected} onClick={select}>
    {content}
  </button>, [buttonGeometry.ref, buttonGeometry.initialStyle, interactive, indicator, label, props.selected, select, content]);
  return useMemo(() => <article ref={articleGeometry.ref} className={`spatial-node spatial-lod-${lod} ${aggregate ? "is-aggregate" : ""} ${props.selected ? "is-selected" : ""} ${props.className ?? ""}`}
    data-spatial-id={item.id} data-depth={node.depth} data-lod={lod}
    data-representation={representation} data-reveal={articleGeometry.initialReveal}
    data-lod-transition="stable"
    data-aggregate={aggregate ? "true" : "false"}
    style={style} role={indicator ? "img" : undefined}
    title={indicator ? label : undefined} aria-label={label}>
    <div ref={surfaceGeometry.ref} className="spatial-card-visual" style={surfaceGeometry.initialStyle}>
      {button}
    </div>
  </article>, [articleGeometry.ref, articleGeometry.initialReveal, surfaceGeometry.ref, surfaceGeometry.initialStyle,
    item.id, node.depth, lod, aggregate, props.selected, props.className, representation, indicator, label, style, button]);
}

export const SpatialNode = memo(SpatialNodeView, equalSemanticProps) as typeof SpatialNodeView;
