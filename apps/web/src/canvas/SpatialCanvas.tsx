import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { buildSpatialIndex, buildSpatialLayout, buildSpatialScene } from "@treepm/engine";
import type { SpatialItem } from "@treepm/engine";
import { SpatialNode, SpatialRegion } from "./SpatialNode.js";
import { useSpatialCamera } from "./useSpatialCamera.js";
import { useReducedMotion } from "./useReducedMotion.js";
import "./SpatialCanvas.css";

export function SpatialCanvas({ items }: { items: readonly SpatialItem[] }) {
  const index = useMemo(() => buildSpatialIndex(items), [items]);
  const layout = useMemo(() => buildSpatialLayout(index), [index]);
  const stageRef = useRef<HTMLDivElement>(null);
  const { camera, size, focusId, isDragging, zoomBy, fitInitial, focusNode, gestureHandlers } = useSpatialCamera(layout, stageRef);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState(true);
  const selected = selectedId ? index.itemById.get(selectedId) : undefined;
  const reducedMotion = useReducedMotion();
  const scene = useMemo(() => {
    const viewport = { ...size, x: -camera.x, y: -camera.y };
    return buildSpatialScene(layout, index, { x: 0, y: 0, scale: camera.scale }, viewport);
  }, [layout, index, camera.x, camera.y, camera.scale, size]);
  const visibleCount = scene.nodes.filter((node) => node.representation === "card").length;
  const breadcrumb = useMemo(() => {
    const path: SpatialItem[] = [];
    let current = index.itemById.get(focusId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? index.itemById.get(current.parentId) : undefined;
    }
    return path;
  }, [focusId, index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"));
      if (event.key === "Escape" && !editing) setSelectedId(null);
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || editing) return;
      event.preventDefault();
      setColorMode((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const clearBackground = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setSelectedId(null);
  };

  return <main className={`spatial-shell ${colorMode ? "is-color-mode" : ""}`}>
    <section className="spatial-context">
      <nav className="spatial-breadcrumb" aria-label="Caminho do foco">
        {breadcrumb.map((item, position) => <span key={item.id}>
          {position > 0 && <i aria-hidden="true">›</i>}
          <button className={item.id === focusId ? "is-current" : ""} aria-current={item.id === focusId ? "location" : undefined} title={item.id} onClick={() => focusNode(item.id)}>{item.label}</button>
        </span>)}
      </nav>
      <div className="spatial-metrics"><span>{visibleCount} na cena · {items.length} nós locais</span><span>zoom {Math.round(camera.scale * 100)}%</span></div>
    </section>
    <section className={`spatial-stage ${isDragging ? "is-dragging" : ""}`} ref={stageRef} aria-label="Demo de navegação espacial" onClick={clearBackground} {...gestureHandlers}>
      <div className="spatial-constellation" aria-hidden="true" />
      <div className="spatial-scene" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0)` }}>
        {scene.regions.map((region) => <SpatialRegion key={region.id} {...region} />)}
        {scene.nodes.map((node) => <SpatialNode key={node.id} {...node} selected={selectedId === node.id} index={index} reducedMotion={reducedMotion} onSelect={setSelectedId} />)}
        {scene.groups.map((group) => <span key={group.parentId} className="spatial-indicator-group" role="img"
          aria-label={`${group.childIds.length} outros filhos imediatos; amplie para revelar`}
          style={{ "--spatial-color": index.itemById.get(group.parentId)?.color ?? "#6853a5", width: group.width, opacity: group.opacity, transform: `translate3d(${group.x}px, ${group.y}px, 0) translateX(-50%) scale(${group.scale})` } as CSSProperties}>+{group.childIds.length}</span>)}
      </div>
      <div className="spatial-toolbar" role="toolbar" aria-label="Câmera e cores" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(-1)} aria-label="Reduzir zoom">−</button>
        <button onClick={() => fitInitial()} aria-label="Restaurar enquadramento">⌂</button>
        <button onClick={() => zoomBy(1)} aria-label="Ampliar zoom">+</button>
        <button className="spatial-color-toggle" onClick={() => setColorMode((current) => !current)} aria-pressed={colorMode} aria-keyshortcuts="C" title="Preencher nós pela cor (C)">Cores</button>
      </div>
      {selected && <aside className="spatial-selection" aria-label="Nó selecionado" onPointerDown={(event) => event.stopPropagation()}>
        <div><code>{selected.id}</code><button onClick={() => setSelectedId(null)} aria-label="Fechar seleção">×</button></div>
        <strong>{selected.label}</strong>
        <p>{index.childrenByParentId.get(selected.id)?.length ?? 0} filhos · {index.descendantCountById.get(selected.id) ?? 0} descendentes · nível {index.depthById.get(selected.id) ?? 0}</p>
        <button onClick={() => focusNode(selected.id)}>Explorar ramo</button>
      </aside>}
      <div className="spatial-help">Wheel para zoom · arraste para pan · combine os dois · clique para selecionar · Explorar ramo para focar · C cores · Esc limpar</div>
    </section>
  </main>;
}
