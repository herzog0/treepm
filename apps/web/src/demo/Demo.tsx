import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { RenderNodeContent, SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { demoItems } from "./data.js";
import type { DemoNode } from "./data.js";
import "@treepm/react/styles.css";
import "./Demo.css";

const getLabel = (node: DemoNode) => node.label;
const getColor = (node: DemoNode) => node.color;
const labels: SpatialCanvasLabels = { canvas: "Demo de navegação espacial", toolbar: "Câmera e cores", zoomOut: "Reduzir zoom", reset: "Restaurar enquadramento", zoomIn: "Ampliar zoom", colors: "Cores" };
const getNodeAriaLabel = ({ node, childCount, descendantCount }: SpatialNodeContent<DemoNode>) => `${node.id} · ${node.label}. ${childCount} filhos, ${descendantCount} descendentes.`;
const getGroupAriaLabel = (members: readonly DemoNode[]) => `${members.length} nós agrupados: ${members.map((node) => `${node.id} · ${node.label}`).join(", ")}. Amplie para revelar.`;
const renderNodeContent: RenderNodeContent<DemoNode> = ({ node, lod, depth, aggregate, childCount, descendantCount }) => lod === "dot" ? null : <>
  <span className="spatial-key">{node.id}</span>
  <strong>{node.label}</strong>
  {lod === "full" && <span className="spatial-card-meta" title={`Dado do consumidor: ${node.sampleValue}`}>{childCount} filhos · nível {depth}</span>}
  {aggregate && <span className="spatial-aggregate-count">{descendantCount} descendentes</span>}
</>;

export function Demo() {
  const canvas = useSpatialCanvas({ items: demoItems, getLabel, getColor });
  const { index, selected, focusId, breadcrumb, scene, camera, focusNode, selectNode } = canvas;
  const visibleCount = scene.nodes.filter((node) => node.representation === "card").length;
  return <SpatialCanvasView controller={canvas} labels={labels} renderNodeContent={renderNodeContent}
    getNodeAriaLabel={getNodeAriaLabel} getGroupAriaLabel={getGroupAriaLabel}
    renderContext={() => <section className="spatial-context">
      <nav className="spatial-breadcrumb" aria-label="Caminho do foco">
        {breadcrumb.map((item, position) => <span key={item.id}>
          {position > 0 && <i aria-hidden="true">›</i>}
          <button className={item.id === focusId ? "is-current" : ""} aria-current={item.id === focusId ? "location" : undefined} title={item.id} onClick={() => focusNode(item.id)}>{item.label}</button>
        </span>)}
      </nav>
      <div className="spatial-metrics"><span>{visibleCount} na cena · {demoItems.length} nós locais</span><span>zoom {Math.round(camera.scale * 100)}%</span></div>
    </section>}
    renderOverlay={() => <>
      {selected && <aside className="spatial-selection" aria-label="Nó selecionado" onPointerDown={(event) => event.stopPropagation()}>
        <div><code>{selected.id}</code><button onClick={() => selectNode(null)} aria-label="Fechar seleção">×</button></div>
        <strong>{selected.label}</strong>
        <p>{index.childrenByParentId.get(selected.id)?.length ?? 0} filhos · {index.descendantCountById.get(selected.id) ?? 0} descendentes · nível {index.depthById.get(selected.id) ?? 0}</p>
        <button onClick={() => focusNode(selected.id)}>Explorar ramo</button>
      </aside>}
      <div className="spatial-help">Wheel para zoom · arraste para pan · combine os dois · clique para selecionar · Explorar ramo para focar · C cores · Esc limpar</div>
    </>} />;
}
