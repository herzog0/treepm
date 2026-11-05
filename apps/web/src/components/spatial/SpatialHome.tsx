import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Project, Ticket, TreeIndex, User } from "@treepm/domain";
import { api } from "../../api.js";
import { TicketPanel } from "../TicketPanel.js";
import { TicketForm } from "../TicketForm.js";
import { SpatialNode, SpatialRegion, visualStatus } from "./SpatialNode.js";
import { useSpatialCamera } from "./useSpatialCamera.js";
import { buildSpatialLayout } from "./spatialLayout.js";
import { useReducedMotion } from "./useReducedMotion.js";
import { buildSpatialScene } from "./spatialScene.js";
import "./SpatialHome.css";

interface SpatialHomeProps {
  project: Project;
  tickets: Ticket[];
  treeIndex: TreeIndex;
  users: User[];
  onRefresh: () => Promise<void>;
  onNavigateLegacy: () => void;
}

export function SpatialHome({ project, tickets, treeIndex, users, onRefresh, onNavigateLegacy }: SpatialHomeProps) {
  const layout = useMemo(() => buildSpatialLayout(treeIndex), [treeIndex]);
  const stageRef = useRef<HTMLDivElement>(null);
  const { camera, size, focusId, isDragging, zoomBy, fitInitial, focusTicket, gestureHandlers } = useSpatialCamera(layout, stageRef);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [colorMode, setColorMode] = useState(true);
  const selectedTicket = selectedTicketId ? treeIndex.ticketById.get(selectedTicketId) : undefined;
  const firstRoot = tickets.find((ticket) => ticket.parentId === null);
  const activeFocusId = focusId || firstRoot?.id || "";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"));
      if (event.key === "Escape" && !editing) setSelectedTicketId(null);
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || editing) return;
      event.preventDefault();
      setColorMode((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reducedMotion = useReducedMotion();
  const scene = useMemo(() => buildSpatialScene(layout, treeIndex, camera, size), [layout, treeIndex, camera, size]);
  const visibleTicketCount = scene.nodes.filter((item) => item.representation === "ticket").length;

  const breadcrumb = useMemo(() => {
    const path: Ticket[] = [];
    const visited = new Set<string>();
    let current = treeIndex.ticketById.get(activeFocusId);
    while (current && !visited.has(current.id)) {
      path.unshift(current);
      visited.add(current.id);
      current = current.parentId ? treeIndex.ticketById.get(current.parentId) : undefined;
    }
    return path;
  }, [activeFocusId, treeIndex]);

  const selectTicket = (id: string) => setSelectedTicketId(id);
  const clearBackground = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target === event.currentTarget || (target instanceof Element && target.classList.contains("spatial-constellation"))) setSelectedTicketId(null);
  };
  const showError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "A operação falhou.");
  const refresh = async (_message: string) => {
    void _message;
    try {
      await onRefresh();
      setError("");
    } catch (cause) {
      showError(cause);
    }
  };

  return <main className={`spatial-shell ${colorMode ? "is-color-mode" : ""}`}>
    <header className="spatial-header">
      <div className="spatial-brand"><span className="spatial-mark">T</span><div><strong>TreePM</strong><span>{project.name} · {tickets.length} tickets</span></div></div>
      <div className="spatial-header-actions"><a href="/legacy" onClick={(event) => { event.preventDefault(); onNavigateLegacy(); }}>Legado</a><button className="spatial-primary" onClick={() => { setFormParentId(null); setFormOpen(true); }}>+ Novo ticket</button></div>
    </header>
    <section className="spatial-context">
      <nav className="spatial-breadcrumb" aria-label="Contexto espacial">{breadcrumb.map((ticket, index) => <span key={ticket.id}>{index > 0 && <i>›</i>}<button className={ticket.id === activeFocusId ? "is-current" : ""} onClick={() => focusTicket(ticket.id)}>{ticket.title}</button></span>)}</nav>
      <div className="spatial-metrics"><span>{visibleTicketCount} na cena · {tickets.length} no projeto</span><span>zoom {Math.round(camera.scale * 100)}%</span></div>
    </section>
    <section className={`spatial-stage ${isDragging ? "is-dragging" : ""}`} ref={stageRef} aria-label="Mapa espacial de tickets" onClick={clearBackground} {...gestureHandlers}>
      <div className="spatial-constellation" aria-hidden="true" />
      {scene.regions.map((region) => <SpatialRegion key={region.id} {...region} />)}
      {scene.nodes.map((item) => <SpatialNode key={item.id}
        {...item}
        status={visualStatus(item.node.ticket, treeIndex)}
        selected={selectedTicketId === item.id}
        projectKey={project.key}
        treeIndex={treeIndex}
        users={users}
        reducedMotion={reducedMotion}
        onSelect={selectTicket} />)}
      {scene.groups.map((group) => {
        const statuses = new Set(group.childIds.map((id) => {
          const ticket = treeIndex.ticketById.get(id);
          return ticket ? visualStatus(ticket, treeIndex) : "mixed";
        }));
        const status = statuses.size === 1 ? [...statuses][0] : "mixed";
        return <span key={group.parentId} className={`spatial-indicator-group spatial-status-${status}`} role="img"
          aria-label={`${group.childIds.length} outros filhos imediatos; amplie para revelar`}
          style={{ width: group.width, opacity: group.opacity, transform: `translate3d(${group.x}px, ${group.y}px, 0) translateX(-50%) scale(${group.scale})` }}>+{group.childIds.length}</span>;
      })}
      <div className="spatial-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(-1)} aria-label="Reduzir zoom">−</button>
        <button onClick={() => fitInitial()} aria-label="Restaurar enquadramento">⌂</button>
        <button onClick={() => zoomBy(1)} aria-label="Ampliar zoom">+</button>
        <button className="spatial-color-toggle" onClick={() => setColorMode((current) => !current)} aria-pressed={colorMode} aria-keyshortcuts="C" title="Preencher cards pela cor de status (C)">Cores</button>
      </div>
      <div className="spatial-help">Wheel para zoom · arraste para pan · combine os dois · clique para detalhes · Explorar ramo no painel para mergulhar · C cores</div>
    </section>
    {error && <div className="spatial-error" role="status">{error}<button onClick={() => setError("")} aria-label="Dispensar">×</button></div>}
    {selectedTicket && <div className="spatial-panel-wrap">
      <button className="spatial-panel-focus" onClick={() => focusTicket(selectedTicket.id)}>Explorar ramo</button>
      <TicketPanel key={selectedTicket.id} ticket={selectedTicket} tickets={tickets} users={users} projectKey={project.key} onClose={() => setSelectedTicketId(null)} onSave={async (input) => { await api.updateTicket(selectedTicket.id, input); await refresh("Ticket atualizado."); }} onDelete={async (recursive) => { await api.deleteTicket(selectedTicket.id, recursive); setSelectedTicketId(null); await refresh("Exclusão concluída."); }} onAddSubticket={() => { setFormParentId(selectedTicket.id); setFormOpen(true); }} onStartLink={onNavigateLegacy} />
    </div>}
    {formOpen && <TicketForm project={project} tickets={tickets} users={users} initialParentId={formParentId} onClose={() => setFormOpen(false)} onCreated={() => refresh("Ticket criado.")} />}
  </main>;
}
