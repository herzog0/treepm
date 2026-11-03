import { useEffect, useState } from "react";
import { getProgress, ticketIdentifier } from "@treepm/domain";
import type { Progress, Ticket, TicketEdge, User } from "@treepm/domain";
import { Avatars } from "./Avatars.js";
import { semanticEdgePath } from "./semanticScene.js";
import { useSemanticGestures } from "./useSemanticGestures.js";

function statusText(ticket: Ticket, progress: Progress, isLeaf: boolean): string {
  if (!isLeaf) return progress.label;
  return { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" }[ticket.status];
}

interface TreeCanvasProps {
  tickets: Ticket[];
  edges: TicketEdge[];
  users: User[];
  projectKey: string;
  selectedTicketId: string | null;
  selectedEdgeId: string | null;
  linkSourceId: string | null;
  onSelectTicket: (ticketId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onConnect: (sourceId: string, targetId: string) => void;
}

export function TreeCanvas(props: TreeCanvasProps) {
  const [colorMode, setColorMode] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const {
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
    gestureHandlers,
  } = useSemanticGestures(props.tickets);
  const focus = props.tickets.find((ticket) => ticket.id === focusId) ?? props.tickets[0];
  const transitionTarget = transition ? props.tickets.find((ticket) => ticket.id === transition.toId) : undefined;
  const connectionSource = connectionSourceId ? props.tickets.find((ticket) => ticket.id === connectionSourceId) : undefined;
  const nodeById = new Map(rendered.map((node) => [node.node.ticket.id, node]));
  const visibleEdges = props.edges.flatMap((edge) => {
    const source = nodeById.get(edge.sourceId);
    const target = nodeById.get(edge.targetId);
    if (!source || !target || Math.min(source.opacity, target.opacity) < 0.02) return [];
    return [{ edge, source, target }];
  });
  const path: Ticket[] = [];
  const visited = new Set<string>();
  let current = focus;
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = props.tickets.find((ticket) => ticket.id === current?.parentId);
  }
  const visibleCount = rendered.filter((node) => node.opacity > 0.05).length;
  const sceneBounds = rendered.length ? {
    minX: Math.min(...rendered.map((node) => node.position.x - node.width / 2)),
    minY: Math.min(...rendered.map((node) => node.position.y)),
    maxX: Math.max(...rendered.map((node) => node.position.x + node.width / 2)),
    maxY: Math.max(...rendered.map((node) => node.position.y + node.height)),
  } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const minimapViewBox = `${sceneBounds.minX - 30} ${sceneBounds.minY - 30} ${Math.max(1, sceneBounds.maxX - sceneBounds.minX + 60)} ${Math.max(1, sceneBounds.maxY - sceneBounds.minY + 60)}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"));
      if (event.key === "Escape" && !editing) setConnectionSourceId(null);
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || editing) return;
      event.preventDefault();
      setColorMode((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activateTicket = (ticketId: string) => {
    if (connectionSourceId) {
      if (connectionSourceId !== ticketId) props.onConnect(connectionSourceId, ticketId);
      setConnectionSourceId(null);
      return;
    }
    focusTicket(ticketId);
    props.onSelectTicket(ticketId);
  };

  if (!focus) return null;
  return <section className={`canvas-shell semantic-tree ${colorMode ? "is-color-mode" : ""}`} aria-label="Árvore interativa do projeto">
    <div className="semantic-tree-toolbar">
      <div className="semantic-focus-copy"><span>FOCO EXPLÍCITO · ZOOM ANCORADO</span><strong>{ticketIdentifier(focus, props.projectKey)} · {focus.title}</strong></div>
      <div className="semantic-tree-metrics">
        {transitionTarget && transition && <span>atenção {Math.round(transition.progress * 100)}% → {transitionTarget.title}</span>}
        <span>{visibleCount} visíveis · {props.tickets.length - visibleCount} resumidos</span>
        <button type="button" className="semantic-color-toggle" data-color-mode={colorMode ? "on" : "off"} aria-pressed={colorMode} aria-keyshortcuts="C" onClick={() => setColorMode((current) => !current)}>Cores {colorMode ? "ativas" : "neutras"} <kbd>C</kbd></button>
      </div>
    </div>
    <nav className="semantic-breadcrumb" aria-label="Caminho do foco">{path.map((ticket, index) => <span key={ticket.id}>{index > 0 && "›"}<button className={ticket.id === focusId ? "current" : ""} onClick={() => focusTicket(ticket.id)}>{ticket.title}</button></span>)}</nav>
    {(connectionSource || props.linkSourceId) && <div className="semantic-linking" role="status">
      {connectionSource ? <>Dependência de <strong>{connectionSource.title}</strong>: selecione o destino.</> : <>Selecione o destino da dependência iniciada no painel.</>}
      {connectionSource && <button onClick={() => setConnectionSourceId(null)}>Cancelar</button>}
    </div>}
    <div className={`semantic-tree-stage ${isDragging ? "is-dragging" : ""}`} ref={stageRef} {...gestureHandlers}>
      <div className="semantic-tree-scene" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}>
        <svg className="semantic-tree-lines" aria-label="Conexões entre tickets">
          <defs>{visibleEdges.map(({ edge }) => <marker key={edge.id} id={`semantic-arrow-${edge.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={edge.style.color} /></marker>)}</defs>
          {visibleEdges.map(({ edge, source, target }) => {
            const selected = props.selectedEdgeId === edge.id;
            const pathValue = semanticEdgePath(source, target);
            const markerId = `semantic-arrow-${edge.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return <g key={edge.id} data-edge-id={edge.id} data-source-id={edge.sourceId} data-target-id={edge.targetId} opacity={Math.min(source.opacity, target.opacity)} className={`semantic-edge semantic-edge-${edge.type} ${selected ? "is-selected" : ""}`}>
              <path className="semantic-edge-hit" d={pathValue} tabIndex={0} role="button" aria-label={`${edge.type === "dependency" ? "Dependência" : "Hierarquia"}: ${source.node.ticket.title} para ${target.node.ticket.title}`} onClick={(event) => { event.stopPropagation(); props.onSelectEdge(edge.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelectEdge(edge.id); } }} />
              <path className="semantic-edge-visible" d={pathValue} style={{ stroke: selected ? "#49386f" : edge.style.color, strokeWidth: edge.style.width + (selected ? 1.5 : 0), strokeDasharray: edge.style.dashed ? "7 6" : undefined }} markerEnd={edge.type === "dependency" ? `url(#${markerId})` : undefined} />
              {edge.type === "dependency" && <text className="semantic-edge-label" x={(source.position.x + target.position.x) / 2} y={(source.position.y + source.height + target.position.y) / 2 - 7}>dependência</text>}
            </g>;
          })}
        </svg>
        {rendered.map((node) => {
          const ticket = node.node.ticket;
          const progress = getProgress(props.tickets, ticket.id);
          const childCount = props.tickets.filter((item) => item.parentId === ticket.id).length;
          const isLeaf = childCount === 0;
          const status = isLeaf ? ticket.status : progress.status;
          const selected = props.selectedTicketId === ticket.id;
          return <article key={ticket.id} data-ticket-id={ticket.id} className={`semantic-tree-node semantic-card-${node.kind} semantic-status-${status} ${ticket.id === focusId ? "is-focus" : ""} ${ticket.id === attentionId ? "is-attention" : ""} ${selected ? "is-selected" : ""}`}
            style={{
              width: node.width,
              height: node.height,
              opacity: node.opacity,
              pointerEvents: node.opacity < 0.05 ? "none" : "auto",
              transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0) translateX(-50%)`,
            }}
            aria-hidden={node.opacity < 0.05}
            onPointerEnter={() => setAttentionId(ticket.id)}
            onPointerLeave={() => setAttentionId((currentId) => currentId === ticket.id ? null : currentId)}>
            <span className="semantic-color-wash" aria-hidden="true" />
            <button className="semantic-card-main" tabIndex={node.opacity < 0.05 ? -1 : 0} title={`${ticket.title} — ${statusText(ticket, progress, isLeaf)}`} aria-label={`${ticketIdentifier(ticket, props.projectKey)} ${ticket.title}. ${statusText(ticket, progress, isLeaf)}. ${node.kind === "summary" ? `${node.node.descendantCount} descendentes resumidos` : "Clique para foco e detalhes"}`} onClick={() => activateTicket(ticket.id)}>
              {node.kind === "dot" ? <span className="semantic-sr-only">{ticket.title}</span> : <>
                <span className="semantic-tree-key">{ticketIdentifier(ticket, props.projectKey)}</span>
                <strong>{ticket.title}</strong>
                {(node.kind === "full" || node.kind === "compact") && <span className="semantic-card-meta"><Avatars userIds={ticket.assigneeIds} users={props.users} compact /><span>{childCount > 0 ? `${childCount} ${childCount === 1 ? "filho" : "filhos"}` : "folha"}</span></span>}
                {node.kind === "full" && ticket.components.length > 0 && <span className="semantic-card-components">{ticket.components.slice(0, 3).map((component) => component.name).join(" · ")}</span>}
                {node.kind === "summary" && <span className="semantic-summary-count">{node.node.descendantCount} descendentes</span>}
                <span className="semantic-card-progress">{statusText(ticket, progress, isLeaf)}</span>
                <span className="semantic-mini-track" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><i style={{ width: `${progress.percent}%` }} /></span>
              </>}
            </button>
            {(node.kind === "full" || node.kind === "compact") && <button className="semantic-connect-handle" aria-label={`Criar dependência a partir de ${ticket.title}`} title="Criar dependência" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setConnectionSourceId(ticket.id); }}>↗</button>}
          </article>;
        })}
      </div>
      <div className="semantic-lod-indicator" aria-live="polite"><span>SEMÂNTICA</span>{Math.round(camera.zoom * 100)}% · escala {Math.round(camera.scale * 100)}%</div>
      <div className="semantic-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(-0.08)} aria-label="Reduzir nível semântico">−</button>
        <button onClick={fitContext} aria-label="Enquadrar contexto atual">⌂</button>
        <button onClick={() => zoomBy(0.08)} aria-label="Ampliar nível semântico">+</button>
      </div>
      <svg className="semantic-minimap" viewBox={minimapViewBox} aria-label="Minimapa do contexto visível">
        <rect className="semantic-minimap-viewport" x={-camera.x / camera.scale} y={-camera.y / camera.scale} width={size.width / camera.scale} height={size.height / camera.scale} />
        {visibleEdges.map(({ edge, source, target }) => <path key={edge.id} d={semanticEdgePath(source, target)} />)}
        {rendered.filter((node) => node.opacity > 0.05).map((node) => <rect key={node.node.ticket.id} x={node.position.x - node.width / 2} y={node.position.y} width={Math.max(4, node.width)} height={Math.max(4, node.height)} rx={4} />)}
      </svg>
      <div className="semantic-help">Wheel no cursor · zoom+ sobre outro card transfere atenção · <kbd>Shift</kbd> + wheel pan horizontal · arraste para pan · <kbd>C</kbd> cores</div>
    </div>
  </section>;
}
