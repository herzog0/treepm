import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { RenderNodeContent, SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createDemoItems } from "./data.js";
import type { DemoNode } from "./data.js";
import "@treepm/react/styles.css";
import "./Demo.css";

const getLabel = (node: DemoNode) => node.label;
const getColor = (node: DemoNode) => node.color;

const childrenText = (t: TFunction<"demo">, count: number) => t("node.children", { count });
const descendantsText = (t: TFunction<"demo">, count: number) => t("node.descendants", { count });

export function Demo() {
  const { t } = useTranslation("demo");
  const items = useMemo(() => createDemoItems(t), [t]);
  const labels: SpatialCanvasLabels = { canvas: t("canvas.label"), toolbar: t("canvas.toolbar"), zoomOut: t("canvas.zoomOut"), reset: t("canvas.reset"), zoomIn: t("canvas.zoomIn"), colors: t("canvas.colors") };
  const getNodeAriaLabel = ({ node, childCount, descendantCount }: SpatialNodeContent<DemoNode>) =>
    t("node.label", { id: node.id, label: node.label, children: childrenText(t, childCount), descendants: descendantsText(t, descendantCount) });
  const getGroupAriaLabel = (members: readonly DemoNode[]) => t("node.grouped", { count: members.length, list: members.map((node) => `${node.id} · ${node.label}`).join(", ") });
  const renderNodeContent: RenderNodeContent<DemoNode> = ({ node, lod, depth, aggregate, childCount, descendantCount }) => lod === "dot" ? null : <>
    <span className="spatial-key">{node.id}</span>
    <strong>{node.label}</strong>
    {lod === "full" && <span className="spatial-card-meta" title={t("node.consumerData", { value: node.sampleValue })}>{t("node.meta", { children: childrenText(t, childCount), depth })}</span>}
    {aggregate && <span className="spatial-aggregate-count">{descendantsText(t, descendantCount)}</span>}
  </>;
  const canvas = useSpatialCanvas({ items, getLabel, getColor });
  const { index, selected, focusId, breadcrumb, scene, camera, focusNode, selectNode } = canvas;
  const visibleCount = scene.nodes.filter((node) => node.representation === "card").length;
  return <SpatialCanvasView controller={canvas} labels={labels} renderNodeContent={renderNodeContent}
    getNodeAriaLabel={getNodeAriaLabel} getGroupAriaLabel={getGroupAriaLabel}
    renderContext={() => <section className="spatial-context">
      <nav className="spatial-breadcrumb" aria-label={t("breadcrumb")}>
        {breadcrumb.map((item, position) => <span key={item.id}>
          {position > 0 && <i aria-hidden="true">›</i>}
          <button className={item.id === focusId ? "is-current" : ""} aria-current={item.id === focusId ? "location" : undefined} title={item.id} onClick={() => focusNode(item.id)}>{item.label}</button>
        </span>)}
      </nav>
      <div className="spatial-metrics"><span>{t("metrics.scene", { visible: visibleCount, total: items.length })}</span><span>{t("metrics.zoom", { percent: Math.round(camera.scale * 100) })}</span></div>
    </section>}
    renderOverlay={() => <>
      {selected && <aside className="spatial-selection" aria-label={t("selection.region")} onPointerDown={(event) => event.stopPropagation()}>
        <div><code>{selected.id}</code><button onClick={() => selectNode(null)} aria-label={t("selection.close")}>×</button></div>
        <strong>{selected.label}</strong>
        <p>{t("selection.summary", { children: childrenText(t, index.childrenByParentId.get(selected.id)?.length ?? 0), descendants: descendantsText(t, index.descendantCountById.get(selected.id) ?? 0), depth: index.depthById.get(selected.id) ?? 0 })}</p>
        <button onClick={() => focusNode(selected.id)}>{t("selection.explore")}</button>
      </aside>}
      <div className="spatial-help">{t("help")}</div>
    </>} />;
}
