import { memo, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import type { SpatialLod, SpatialSceneNode, SpatialSceneRegion, SpatialTreeIndex } from "@treepm/engine";

interface SpatialNodeProps extends SpatialSceneNode {
  selected: boolean;
  index: SpatialTreeIndex;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
}

export const SpatialRegion = memo(function SpatialRegion(props: SpatialSceneRegion) {
  return <div className="spatial-region" aria-hidden="true" data-region-id={props.id} style={{ width: props.width, height: props.height, opacity: props.opacity, transform: `translate3d(${props.x}px, ${props.y}px, 0)` }} />;
});

interface NodeContentProps {
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
const NodeContent = memo(function NodeContent(props: NodeContentProps) {
  const { id, label, depth, childCount, descendantCount, lod, aggregate, reducedMotion } = props;
  return <span key={`${lod}:${aggregate}`} className="spatial-lod-content" data-lod-transition="stable"
    style={reducedMotion ? { animation: "none" } : undefined}>
    {lod === "dot" ? <span className="spatial-sr-only">{id} · {label}. {childCount} filhos, {descendantCount} descendentes.</span> : <>
      <span className="spatial-key">{id}</span>
      <strong>{label}</strong>
      {lod === "full" && <span className="spatial-card-meta">{childCount} filhos · nível {depth}</span>}
      {aggregate && <span className="spatial-aggregate-count">{descendantCount} descendentes</span>}
    </>}
  </span>;
});

export const SpatialNode = memo(function SpatialNode(props: SpatialNodeProps) {
  const { node, lod, aggregate, reveal, representation } = props;
  const item = node.item;
  const childCount = props.index.childrenByParentId.get(item.id)?.length ?? 0;
  const descendantCount = props.index.descendantCountById.get(item.id) ?? 0;
  const indicator = representation === "indicator";
  const interactive = !indicator && props.width >= 20 && reveal >= 0.5;
  const style: CSSProperties & { "--spatial-color": string } = {
    "--spatial-color": item.color,
    width: props.width, height: props.height, opacity: props.opacity,
    transform: `translate3d(${props.x}px, ${props.y}px, 0) translateX(-50%)`,
  };
  // Keep the same positive local surface through the indicator/card morph.
  const surfaceWidth = Math.max(6, props.width);
  const surfaceHeight = Math.max(6, props.height);
  const surfaceStyle: CSSProperties & { "--spatial-reveal": number; "--spatial-indicator-scale": number } = {
    "--spatial-reveal": reveal,
    "--spatial-indicator-scale": props.indicatorScale,
    width: surfaceWidth,
    height: surfaceHeight,
    transform: `scale(${props.width / surfaceWidth}, ${props.height / surfaceHeight})`,
  };

  const label = useMemo(
    () => `${item.id} · ${item.label}. ${childCount} filhos, ${descendantCount} descendentes.`,
    [item.id, item.label, childCount, descendantCount],
  );
  const content = useMemo(() => <NodeContent id={item.id} label={item.label} depth={node.depth}
    childCount={childCount} descendantCount={descendantCount} lod={lod} aggregate={aggregate} reducedMotion={props.reducedMotion} />,
  [item.id, item.label, node.depth, childCount, descendantCount, lod, aggregate, props.reducedMotion]);
  const { onSelect } = props;
  const select = useCallback(() => {
    if (interactive) onSelect(item.id);
  }, [interactive, onSelect, item.id]);
  const contentStyle = useMemo(() => ({ opacity: props.contentOpacity }), [props.contentOpacity]);
  const button = useMemo(() => <button className="spatial-card-button" style={contentStyle}
    tabIndex={interactive ? 0 : -1} aria-hidden={indicator ? true : undefined}
    aria-label={label} aria-pressed={props.selected} onClick={select}>
    {content}
  </button>, [contentStyle, interactive, indicator, label, props.selected, select, content]);
  return <article className={`spatial-node spatial-lod-${lod} ${aggregate ? "is-aggregate" : ""} ${props.selected ? "is-selected" : ""}`}
    data-spatial-id={item.id} data-depth={node.depth} data-lod={lod}
    data-representation={representation} data-reveal={reveal}
    data-lod-transition="stable"
    data-aggregate={aggregate ? "true" : "false"}
    style={style} role={indicator ? "img" : undefined}
    title={indicator ? label : undefined} aria-label={label}>
    <div className="spatial-card-visual" style={surfaceStyle}>
      {button}
    </div>
  </article>;
});
