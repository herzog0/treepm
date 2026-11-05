import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { SpatialSceneNode, SpatialSceneRegion, SpatialTreeIndex } from "@treepm/engine";

interface SpatialNodeProps extends SpatialSceneNode {
  selected: boolean;
  index: SpatialTreeIndex;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
}

export function SpatialRegion(props: SpatialSceneRegion) {
  return <div className="spatial-region" aria-hidden="true" data-region-id={props.id} style={{ width: props.width, height: props.height, opacity: props.opacity, transform: `translate3d(${props.x}px, ${props.y}px, 0)` }} />;
}

export function SpatialNode(props: SpatialNodeProps) {
  const { node, lod, aggregate, reveal, representation } = props;
  const item = node.item;
  const [content, setContent] = useState({ lod, aggregate });
  const [contentVisible, setContentVisible] = useState(true);
  const childCount = props.index.childrenByParentId.get(item.id)?.length ?? 0;
  const descendantCount = props.index.descendantCountById.get(item.id) ?? 0;
  const indicator = representation === "indicator";
  const interactive = !indicator && props.width >= 20 && reveal >= 0.5;
  const style: CSSProperties & { "--spatial-reveal": number; "--spatial-indicator-scale": number; "--spatial-color": string } = {
    "--spatial-reveal": reveal,
    "--spatial-indicator-scale": props.indicatorScale,
    "--spatial-color": item.color,
    width: props.width, height: props.height, opacity: props.opacity,
    transform: `translate3d(${props.x}px, ${props.y}px, 0) translateX(-50%)`,
  };
  // Keep the same positive local surface through the indicator/card morph.
  const surfaceWidth = Math.max(6, props.width);
  const surfaceHeight = Math.max(6, props.height);
  const surfaceStyle: CSSProperties = {
    width: surfaceWidth,
    height: surfaceHeight,
    transform: `scale(${props.width / surfaceWidth}, ${props.height / surfaceHeight})`,
  };

  useEffect(() => {
    if (content.lod === lod && content.aggregate === aggregate) {
      setContentVisible(true);
      return;
    }
    if (props.reducedMotion) {
      setContent({ lod, aggregate });
      setContentVisible(true);
      return;
    }
    setContentVisible(false);
    const timer = window.setTimeout(() => {
      setContent({ lod, aggregate });
      setContentVisible(true);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [lod, aggregate, content.lod, content.aggregate, props.reducedMotion]);

  const label = `${item.id} · ${item.label}. ${childCount} filhos, ${descendantCount} descendentes.`;
  return <article className={`spatial-node spatial-lod-${lod} ${aggregate ? "is-aggregate" : ""} ${props.selected ? "is-selected" : ""}`}
    data-spatial-id={item.id} data-depth={node.depth} data-lod={lod}
    data-representation={representation} data-reveal={reveal}
    data-lod-transition={contentVisible ? "stable" : "changing"}
    data-aggregate={aggregate ? "true" : "false"}
    style={style} role={indicator ? "img" : undefined}
    title={indicator ? label : undefined} aria-label={label}>
    <div className="spatial-card-visual" style={surfaceStyle}>
      <button className="spatial-card-button" style={{ opacity: props.contentOpacity }}
        tabIndex={interactive ? 0 : -1} aria-hidden={indicator ? true : undefined}
        aria-label={label} aria-pressed={props.selected}
        onClick={() => { if (interactive) props.onSelect(item.id); }}>
        <span className="spatial-lod-content" data-lod-transition={contentVisible ? "stable" : "changing"}>
          {content.lod === "dot" ? <span className="spatial-sr-only">{label}</span> : <>
            <span className="spatial-key">{item.id}</span>
            <strong>{item.label}</strong>
            {content.lod === "full" && <span className="spatial-card-meta">{childCount} filhos · nível {node.depth}</span>}
            {content.aggregate && <span className="spatial-aggregate-count">{descendantCount} descendentes</span>}
          </>}
        </span>
      </button>
    </div>
  </article>;
}
