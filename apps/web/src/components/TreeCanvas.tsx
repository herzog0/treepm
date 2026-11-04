import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { ticketIdentifier } from "@treepm/domain";
import type { Progress, Ticket, TicketEdge, TreeIndex, User } from "@treepm/domain";
import { Avatars } from "./Avatars.js";
import { semanticEdgePath } from "./semanticScene.js";
import type { SemanticSceneNode } from "./semanticScene.js";
import { useSemanticGestures } from "./useSemanticGestures.js";

const EMPTY_PROGRESS: Progress = { doneLeaves: 0, totalLeaves: 0, percent: 0, status: "not_started", label: "Sem folhas" };

function statusText(ticket: Ticket, progress: Progress, isLeaf: boolean, node: SemanticSceneNode): string {
  const mixed = node.visualStatus === "mixed" ? " · estado misto" : "";
  if (node.aggregate && node.aggregateTotalLeaves > 0) {
    const percent = Math.round((node.aggregateDoneLeaves / node.aggregateTotalLeaves) * 100);
    return `${node.aggregateDoneLeaves} de ${node.aggregateTotalLeaves} folhas agregadas concluídas · ${percent}%${mixed}`;
  }
  if (!isLeaf) return `${progress.label}${mixed}`;
  return { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" }[ticket.status];
}

function minimapNodePath(node: SemanticSceneNode) {
  const x = node.position.x - node.layoutWidth / 2;
  const y = node.position.y;
  const width = Math.max(4, node.layoutWidth);
  const height = Math.max(4, node.layoutHeight);
  const radius = Math.min(4, width / 2, height / 2);
  return `M ${x + radius} ${y} H ${x + width - radius} A ${radius} ${radius} 0 0 1 ${x + width} ${y + radius} V ${y + height - radius} A ${radius} ${radius} 0 0 1 ${x + width - radius} ${y + height} H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${y + height - radius} V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
}

interface SemanticCardContentProps {
  node: SemanticSceneNode;
  ticket: Ticket;
  progress: Progress;
  childCount: number;
  treeIndex: TreeIndex;
  users: User[];
  projectKey: string;
  focusOnClick: boolean;
  connectionSourceId: string | null;
  onActivate: (ticketId: string, point?: { clientX: number; clientY: number }) => void;
  onStartConnection: (ticketId: string) => void;
}

function sameIndicators(from: SemanticSceneNode["childIndicators"], to: SemanticSceneNode["childIndicators"]) {
  if (from.length !== to.length) return false;
  for (let index = 0; index < from.length; index += 1) {
    const a = from[index];
    const b = to[index];
    if (!a || !b || a.id !== b.id || a.visualStatus !== b.visualStatus || (a.opacity >= 0.05) !== (b.opacity >= 0.05) || a.ticketIds.length !== b.ticketIds.length) return false;
    if (a.ticketIds.length === 1 && a.ticketIds[0] !== b.ticketIds[0]) return false;
  }
  return true;
}

const SemanticCardContent = memo(function SemanticCardContent(props: SemanticCardContentProps) {
  const { node, ticket, progress, childCount } = props;
  const isLeaf = childCount === 0;
  const label = statusText(ticket, progress, isLeaf, node);
  const aggregationText = node.aggregate ? `${node.representedCount - 1} descendentes agregados` : "";
  const accessibleStatus = [label, aggregationText].filter(Boolean).join(". ");
  const displayPercent = node.aggregateTotalLeaves > 0 ? Math.round((node.aggregateDoneLeaves / node.aggregateTotalLeaves) * 100) : progress.percent;
  return <>
    <span className="semantic-card-surface">
      <span className="semantic-color-wash" aria-hidden="true" />
      <button className="semantic-card-main" tabIndex={node.opacity < 0.05 ? -1 : 0} title={`${ticket.title} — ${accessibleStatus}`} aria-label={`${ticketIdentifier(ticket, props.projectKey)} ${ticket.title}. ${accessibleStatus}. ${props.focusOnClick ? "Clique para foco e detalhes" : "Clique para abrir detalhes sem mudar a cena"}`} onClick={(event) => props.onActivate(ticket.id, event.clientX || event.clientY ? { clientX: event.clientX, clientY: event.clientY } : undefined)}>
        <span className="semantic-sr-only">{ticket.title}. {accessibleStatus}</span>
        <span className="semantic-tree-key semantic-card-normal">{ticketIdentifier(ticket, props.projectKey)}</span>
        <strong className="semantic-card-normal">{ticket.title}</strong>
        <span className="semantic-card-meta semantic-card-normal"><Avatars userIds={ticket.assigneeIds} users={props.users} compact /><span>{childCount > 0 ? `${childCount} ${childCount === 1 ? "filho" : "filhos"}` : "folha"}</span></span>
        {ticket.components.length > 0 && <span className="semantic-card-components semantic-card-normal">{ticket.components.slice(0, 3).map((component) => component.name).join(" · ")}</span>}
        {node.aggregate && <span className="semantic-summary-count semantic-card-normal">{aggregationText}</span>}
        <span className="semantic-card-progress semantic-card-normal">{label}</span>
        <span className="semantic-mini-track semantic-card-normal" role="progressbar" aria-label={accessibleStatus} aria-valuemin={0} aria-valuemax={100} aria-valuenow={displayPercent}><i style={{ width: `${displayPercent}%` }} /></span>
      </button>
    </span>
    {node.childIndicators.length > 0 && <span className="semantic-child-indicators" aria-label="Filhos imediatos">
      {node.childIndicators.map((indicator) => {
        const childId = indicator.ticketIds.length === 1 ? indicator.ticketIds[0] : undefined;
        const child = childId ? props.treeIndex.ticketById.get(childId) : undefined;
        const statusLabel = { todo: "A fazer", not_started: "Não iniciado", in_progress: "Em andamento", active: "Em andamento", done: "Concluído", mixed: "Estado misto" }[indicator.visualStatus];
        const indicatorLabel = child ? `${ticketIdentifier(child, props.projectKey)} ${child.title}. ${statusLabel}` : `${indicator.ticketIds.length} filhos agrupados. ${statusLabel}`;
        return <button type="button" key={indicator.id} className={`semantic-child-indicator ${child ? "is-single" : "is-group"}`} data-indicator-ticket-id={childId} data-parent-ticket-id={ticket.id} data-visual-status={indicator.visualStatus} title={indicatorLabel} aria-label={indicatorLabel} tabIndex={node.opacity < 0.05 || indicator.opacity < 0.05 ? -1 : 0} style={{ opacity: indicator.opacity, pointerEvents: indicator.opacity < 0.05 ? "none" : "auto" }} onClick={(event) => { event.stopPropagation(); props.onActivate(childId ?? ticket.id, event.clientX || event.clientY ? { clientX: event.clientX, clientY: event.clientY } : undefined); }}>
          {child ? <i style={{ backgroundColor: indicator.statusColor }} /> : <span style={{ backgroundColor: indicator.statusColor }}>{indicator.ticketIds.length}</span>}
        </button>;
      })}
    </span>}
    <button className="semantic-connect-handle" aria-label={`Criar dependência a partir de ${ticket.title}`} title="Criar dependência" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onStartConnection(ticket.id); }}>↗</button>
  </>;
}, sameSemanticCardContent);

function sameNodeSemantics(from: SemanticSceneNode, to: SemanticSceneNode) {
  return from.aggregate === to.aggregate
    && from.representedCount === to.representedCount
    && from.aggregateDoneLeaves === to.aggregateDoneLeaves
    && from.aggregateTotalLeaves === to.aggregateTotalLeaves
    && from.visualStatus === to.visualStatus
    && (from.opacity >= 0.05) === (to.opacity >= 0.05)
    && sameIndicators(from.childIndicators, to.childIndicators);
}

function sameSemanticCardContent(previous: SemanticCardContentProps, next: SemanticCardContentProps) {
  return previous.ticket === next.ticket
    && previous.progress === next.progress
    && previous.childCount === next.childCount
    && previous.treeIndex === next.treeIndex
    && previous.users === next.users
    && previous.projectKey === next.projectKey
    && previous.focusOnClick === next.focusOnClick
    && previous.connectionSourceId === next.connectionSourceId
    && sameNodeSemantics(previous.node, next.node);
}

interface SemanticTreeNodeProps extends SemanticCardContentProps {
  focused: boolean;
  attention: boolean;
  selected: boolean;
  nodeElements: Map<string, HTMLElement>;
  onAttention: (value: string | null | ((current: string | null) => string | null)) => void;
}

const SemanticTreeNode = memo(function SemanticTreeNode(props: SemanticTreeNodeProps) {
  const { node, ticket } = props;
  const status = node.visualStatus;
  return <article ref={(element) => { if (element) props.nodeElements.set(ticket.id, element); else props.nodeElements.delete(ticket.id); }} data-ticket-id={ticket.id} data-aggregate={node.aggregate ? "true" : "false"} data-represented-count={node.representedCount} data-aggregate-leaves={node.aggregateTotalLeaves} data-subtree-height={node.subtreeHeight} data-visual-status={status} data-compact-label={node.compactLabel ? "true" : "false"} className={`semantic-tree-node semantic-card-${node.kind} semantic-status-${status} ${props.focused ? "is-focus" : ""} ${props.attention ? "is-attention" : ""} ${props.selected ? "is-selected" : ""}`}
    style={{
      width: node.width,
      height: node.height,
      opacity: node.opacity,
      pointerEvents: node.opacity < 0.05 ? "none" : "auto",
      transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0) translateX(-50%)`,
      "--semantic-status": node.statusColor,
      "--semantic-indicator-size": `${node.indicatorSize}px`,
    } as CSSProperties}
    aria-hidden={node.opacity < 0.05}
    onPointerEnter={() => props.onAttention(ticket.id)}
    onPointerLeave={() => props.onAttention((currentId) => currentId === ticket.id ? null : currentId)}>
    <SemanticCardContent {...props} />
  </article>;
}, (previous, next) => sameSemanticCardContent(previous, next)
  && previous.focused === next.focused
  && previous.attention === next.attention
  && previous.selected === next.selected
  && previous.nodeElements === next.nodeElements);

interface EdgeElementRegistration {
  group: SVGGElement;
  hit: SVGPathElement;
  visible: SVGPathElement;
  label: SVGTextElement | null;
}
interface SemanticEdgeProps {
  edge: TicketEdge;
  source: SemanticSceneNode;
  target: SemanticSceneNode;
  path: string;
  selected: boolean;
  edgeElements: Map<string, EdgeElementRegistration>;
  onSelect: (edgeId: string) => void;
}

const SemanticEdge = memo(function SemanticEdge(props: SemanticEdgeProps) {
  const { edge, source, target } = props;
  const pathValue = props.path;
  const markerId = `semantic-arrow-${edge.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <g ref={(group) => {
    if (!group) {
      props.edgeElements.delete(edge.id);
      return;
    }
    const hit = group.querySelector<SVGPathElement>(".semantic-edge-hit");
    const visible = group.querySelector<SVGPathElement>(".semantic-edge-visible");
    if (hit && visible) props.edgeElements.set(edge.id, { group, hit, visible, label: group.querySelector<SVGTextElement>("text") });
  }} data-edge-id={edge.id} data-source-id={edge.sourceId} data-target-id={edge.targetId} opacity={Math.min(source.opacity, target.opacity)} className={`semantic-edge semantic-edge-${edge.type} ${props.selected ? "is-selected" : ""}`}>
    <path className="semantic-edge-hit" d={pathValue} tabIndex={0} role="button" aria-label={`${edge.type === "dependency" ? "Dependência" : "Hierarquia"}: ${source.node.ticket.title} para ${target.node.ticket.title}`} onClick={(event) => { event.stopPropagation(); props.onSelect(edge.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect(edge.id); } }} />
    <path className="semantic-edge-visible" d={pathValue} style={{ stroke: props.selected ? "#49386f" : edge.style.color, strokeWidth: edge.style.width + (props.selected ? 1.5 : 0), strokeDasharray: edge.style.dashed ? "7 6" : undefined }} markerEnd={edge.type === "dependency" ? `url(#${markerId})` : undefined} />
    {edge.type === "dependency" && <text className="semantic-edge-label" x={(source.position.x + target.position.x) / 2} y={(source.position.y + source.height + target.position.y) / 2 - 7}>dependência</text>}
  </g>;
}, (previous, next) => previous.edge === next.edge
  && previous.source.node.ticket === next.source.node.ticket
  && previous.target.node.ticket === next.target.node.ticket
  && previous.selected === next.selected
  && previous.edgeElements === next.edgeElements);

const SEMANTIC_CHUNK_SIZE = 64;
function chunkItems<T>(items: T[]) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += SEMANTIC_CHUNK_SIZE) chunks.push(items.slice(index, index + SEMANTIC_CHUNK_SIZE));
  return chunks;
}

interface SemanticNodeChunkProps {
  nodes: SemanticSceneNode[];
  treeIndex: TreeIndex;
  users: User[];
  projectKey: string;
  focusOnClick: boolean;
  connectionSourceId: string | null;
  focusId: string;
  attentionId: string | null;
  selectedTicketId: string | null;
  nodeElements: Map<string, HTMLElement>;
  onAttention: SemanticTreeNodeProps["onAttention"];
  onActivate: SemanticTreeNodeProps["onActivate"];
  onStartConnection: SemanticTreeNodeProps["onStartConnection"];
}

const SemanticNodeChunk = memo(function SemanticNodeChunk(props: SemanticNodeChunkProps) {
  return <>{props.nodes.map((node) => {
    const ticket = node.node.ticket;
    return <SemanticTreeNode key={ticket.id} node={node} ticket={ticket} progress={props.treeIndex.progressById.get(ticket.id) ?? EMPTY_PROGRESS} childCount={props.treeIndex.childrenByParentId.get(ticket.id)?.length ?? 0} treeIndex={props.treeIndex} users={props.users} projectKey={props.projectKey} focusOnClick={props.focusOnClick} connectionSourceId={props.connectionSourceId} onActivate={props.onActivate} onStartConnection={props.onStartConnection} focused={ticket.id === props.focusId} attention={ticket.id === props.attentionId} selected={props.selectedTicketId === ticket.id} nodeElements={props.nodeElements} onAttention={props.onAttention} />;
  })}</>;
}, (previous, next) => {
  if (previous.treeIndex !== next.treeIndex || previous.users !== next.users || previous.projectKey !== next.projectKey || previous.focusOnClick !== next.focusOnClick || previous.connectionSourceId !== next.connectionSourceId || previous.nodeElements !== next.nodeElements || previous.nodes.length !== next.nodes.length) return false;
  for (let index = 0; index < previous.nodes.length; index += 1) {
    const from = previous.nodes[index];
    const to = next.nodes[index];
    if (!from || !to || from.node.ticket !== to.node.ticket || !sameNodeSemantics(from, to)) return false;
  }
  return true;
});

interface VisibleEdge {
  edge: TicketEdge;
  source: SemanticSceneNode;
  target: SemanticSceneNode;
  path: string;
}
interface SemanticEdgeChunkProps {
  edges: VisibleEdge[];
  selectedEdgeId: string | null;
  edgeElements: Map<string, EdgeElementRegistration>;
  onSelect: (edgeId: string) => void;
}
const SemanticEdgeChunk = memo(function SemanticEdgeChunk(props: SemanticEdgeChunkProps) {
  return <>{props.edges.map(({ edge, source, target, path }) => <SemanticEdge key={edge.id} edge={edge} source={source} target={target} path={path} selected={props.selectedEdgeId === edge.id} edgeElements={props.edgeElements} onSelect={props.onSelect} />)}</>;
}, (previous, next) => {
  if (previous.selectedEdgeId !== next.selectedEdgeId || previous.edgeElements !== next.edgeElements || previous.edges.length !== next.edges.length) return false;
  for (let index = 0; index < previous.edges.length; index += 1) {
    const from = previous.edges[index];
    const to = next.edges[index];
    if (!from || !to || from.edge !== to.edge || from.source.node.ticket !== to.source.node.ticket || from.target.node.ticket !== to.target.node.ticket) return false;
  }
  return true;
});

interface TreeCanvasProps {
  tickets: Ticket[];
  treeIndex: TreeIndex;
  edges: TicketEdge[];
  users: User[];
  projectKey: string;
  selectedTicketId: string | null;
  selectedEdgeId: string | null;
  linkSourceId: string | null;
  onClearSelection: () => void;
  onSelectTicket: (ticketId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onConnect: (sourceId: string, targetId: string) => void;
}

export function TreeCanvas(props: TreeCanvasProps) {
  const [colorMode, setColorMode] = useState(false);
  const [focusOnClick, setFocusOnClick] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const edgeElements = useRef(new Map<string, EdgeElementRegistration>());
  const indicatorColors = useRef(new WeakMap<HTMLElement, string>());
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
    clearInteraction,
    zoomBy,
    fitContext,
    gestureHandlers,
  } = useSemanticGestures(props.tickets, props.treeIndex);
  const focus = props.treeIndex.ticketById.get(focusId) ?? props.tickets[0];
  const transitionTarget = transition ? props.treeIndex.ticketById.get(transition.toId) : undefined;
  const connectionSource = connectionSourceId ? props.treeIndex.ticketById.get(connectionSourceId) : undefined;
  const nodeById = new Map(rendered.map((node) => [node.node.ticket.id, node]));
  const visibleEdges = props.edges.flatMap((edge) => {
    const source = nodeById.get(edge.sourceId);
    const target = nodeById.get(edge.targetId);
    if (!source || !target || Math.min(source.opacity, target.opacity) < 0.02) return [];
    return [{ edge, source, target, path: semanticEdgePath(source, target) }];
  });
  const path: Ticket[] = [];
  const visited = new Set<string>();
  let current = focus;
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? props.treeIndex.ticketById.get(current.parentId) : undefined;
  }
  const visibleCount = rendered.filter((node) => node.opacity > 0.05).length;
  const sceneBounds = rendered.length ? {
    minX: Math.min(...rendered.map((node) => node.position.x - node.layoutWidth / 2)),
    minY: Math.min(...rendered.map((node) => node.position.y)),
    maxX: Math.max(...rendered.map((node) => node.position.x + node.layoutWidth / 2)),
    maxY: Math.max(...rendered.map((node) => node.position.y + node.layoutHeight)),
  } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const minimapViewBox = `${sceneBounds.minX - 30} ${sceneBounds.minY - 30} ${Math.max(1, sceneBounds.maxX - sceneBounds.minX + 60)} ${Math.max(1, sceneBounds.maxY - sceneBounds.minY + 60)}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"));
      if (event.key === "Escape" && !editing) {
        clearInteraction();
        setConnectionSourceId(null);
      }
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || editing) return;
      event.preventDefault();
      setColorMode((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useLayoutEffect(() => {
    for (const node of rendered) {
      const element = nodeElements.current.get(node.node.ticket.id);
      if (!element) continue;
      const width = `${node.width}px`;
      const height = `${node.height}px`;
      const opacity = String(node.opacity);
      const pointerEvents = node.opacity < 0.05 ? "none" : "auto";
      const transform = `translate3d(${node.position.x}px, ${node.position.y}px, 0) translateX(-50%)`;
      const indicatorSize = `${node.indicatorSize}px`;
      const ariaHidden = String(node.opacity < 0.05);
      const ticketId = node.node.ticket.id;
      const className = `semantic-tree-node semantic-card-${node.kind} semantic-status-${node.visualStatus} ${ticketId === focusId ? "is-focus" : ""} ${ticketId === attentionId ? "is-attention" : ""} ${props.selectedTicketId === ticketId ? "is-selected" : ""}`;
      const compactLabel = node.compactLabel ? "true" : "false";
      if (element.className !== className) element.className = className;
      if (element.getAttribute("data-compact-label") !== compactLabel) element.setAttribute("data-compact-label", compactLabel);
      if (element.style.width !== width) element.style.width = width;
      if (element.style.height !== height) element.style.height = height;
      if (element.style.opacity !== opacity) element.style.opacity = opacity;
      if (element.style.pointerEvents !== pointerEvents) element.style.pointerEvents = pointerEvents;
      if (element.style.transform !== transform) element.style.transform = transform;
      if (element.style.getPropertyValue("--semantic-status") !== node.statusColor) element.style.setProperty("--semantic-status", node.statusColor);
      if (element.style.getPropertyValue("--semantic-indicator-size") !== indicatorSize) element.style.setProperty("--semantic-indicator-size", indicatorSize);
      if (element.getAttribute("aria-hidden") !== ariaHidden) element.setAttribute("aria-hidden", ariaHidden);
      const indicatorElements = node.childIndicators.length > 0 ? element.querySelectorAll<HTMLButtonElement>(".semantic-child-indicator") : [];
      for (let index = 0; index < node.childIndicators.length; index += 1) {
        const indicator = node.childIndicators[index];
        const indicatorElement = indicatorElements[index];
        if (!indicator || !indicatorElement) continue;
        const indicatorOpacity = String(indicator.opacity);
        const indicatorPointerEvents = indicator.opacity < 0.05 ? "none" : "auto";
        const tabIndex = node.opacity < 0.05 || indicator.opacity < 0.05 ? -1 : 0;
        if (indicatorElement.style.opacity !== indicatorOpacity) indicatorElement.style.opacity = indicatorOpacity;
        if (indicatorElement.style.pointerEvents !== indicatorPointerEvents) indicatorElement.style.pointerEvents = indicatorPointerEvents;
        if (indicatorElement.tabIndex !== tabIndex) indicatorElement.tabIndex = tabIndex;
        const colorElement = indicatorElement.firstElementChild as HTMLElement | null;
        if (colorElement && indicatorColors.current.get(colorElement) !== indicator.statusColor) {
          colorElement.style.backgroundColor = indicator.statusColor;
          indicatorColors.current.set(colorElement, indicator.statusColor);
        }
      }
    }
    for (const { edge, source, target, path } of visibleEdges) {
      const element = edgeElements.current.get(edge.id);
      if (!element) continue;
      const pathValue = path;
      const opacity = String(Math.min(source.opacity, target.opacity));
      if (element.group.getAttribute("opacity") !== opacity) element.group.setAttribute("opacity", opacity);
      if (element.hit.getAttribute("d") !== pathValue) element.hit.setAttribute("d", pathValue);
      if (element.visible.getAttribute("d") !== pathValue) element.visible.setAttribute("d", pathValue);
      if (element.label) {
        const x = String((source.position.x + target.position.x) / 2);
        const y = String((source.position.y + source.height + target.position.y) / 2 - 7);
        if (element.label.getAttribute("x") !== x) element.label.setAttribute("x", x);
        if (element.label.getAttribute("y") !== y) element.label.setAttribute("y", y);
      }
    }
  }, [rendered, visibleEdges, focusId, attentionId, props.selectedTicketId]);

  const activateTicket = (ticketId: string, point?: { clientX: number; clientY: number }) => {
    if (connectionSourceId) {
      if (connectionSourceId !== ticketId) props.onConnect(connectionSourceId, ticketId);
      setConnectionSourceId(null);
      return;
    }
    if (focusOnClick) focusTicket(ticketId, point);
    props.onSelectTicket(ticketId);
  };
  const clearBackground = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const background = target === event.currentTarget || (target instanceof Element && (target.classList.contains("semantic-tree-scene") || target.classList.contains("semantic-tree-lines")));
    if (!background) return;
    setAttentionId(null);
    props.onClearSelection();
  };

  if (!focus) return null;
  return <section className={`canvas-shell semantic-tree ${colorMode ? "is-color-mode" : ""}`} aria-label="Árvore interativa do projeto">
    <div className="semantic-tree-toolbar">
      <div className="semantic-focus-copy"><span>{focusOnClick ? "FOCO EXPLÍCITO · ZOOM ANCORADO" : "SOMENTE DETALHES · CENA PRESERVADA"}</span><strong>{ticketIdentifier(focus, props.projectKey)} · {focus.title}</strong></div>
      <div className="semantic-tree-metrics">
        {transitionTarget && transition && <span>atenção {Math.round(transition.progress * 100)}% → {transitionTarget.title}</span>}
        <span>{visibleCount} visíveis · {props.tickets.length - visibleCount} resumidos</span>
        <button type="button" className="semantic-focus-toggle" data-focus-on-click={focusOnClick ? "on" : "off"} aria-pressed={focusOnClick} title="Desligado: clique abre somente detalhes. Ligado: clique focaliza a subárvore no LOD de três passos." onClick={() => setFocusOnClick((current) => !current)}>Foco no clique {focusOnClick ? "ligado" : "desligado"}</button>
        <button type="button" className="semantic-color-toggle" data-color-mode={colorMode ? "on" : "off"} aria-pressed={colorMode} aria-keyshortcuts="C" onClick={() => setColorMode((current) => !current)}>Cores {colorMode ? "ativas" : "neutras"} <kbd>C</kbd></button>
      </div>
    </div>
    <nav className="semantic-breadcrumb" aria-label="Caminho do foco">{path.map((ticket, index) => <span key={ticket.id}>{index > 0 && "›"}<button className={ticket.id === focusId ? "current" : ""} onClick={() => focusTicket(ticket.id)}>{ticket.title}</button></span>)}</nav>
    {(connectionSource || props.linkSourceId) && <div className="semantic-linking" role="status">
      {connectionSource ? <>Dependência de <strong>{connectionSource.title}</strong>: selecione o destino.</> : <>Selecione o destino da dependência iniciada no painel.</>}
      {connectionSource && <button onClick={() => setConnectionSourceId(null)}>Cancelar</button>}
    </div>}
    <div className={`semantic-tree-stage ${isDragging ? "is-dragging" : ""}`} ref={stageRef} onClick={clearBackground} {...gestureHandlers}>
      <div className="semantic-tree-scene" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}>
        <svg className="semantic-tree-lines" aria-label="Conexões entre tickets">
          <defs>{visibleEdges.filter(({ edge }) => edge.type === "dependency").map(({ edge }) => <marker key={edge.id} id={`semantic-arrow-${edge.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={edge.style.color} /></marker>)}</defs>
          {chunkItems(visibleEdges).map((chunk, index) => <SemanticEdgeChunk key={index} edges={chunk} selectedEdgeId={props.selectedEdgeId} edgeElements={edgeElements.current} onSelect={props.onSelectEdge} />)}
        </svg>
        {chunkItems(rendered).map((chunk, index) => <SemanticNodeChunk key={index} nodes={chunk} treeIndex={props.treeIndex} users={props.users} projectKey={props.projectKey} focusOnClick={focusOnClick} connectionSourceId={connectionSourceId} focusId={focusId} attentionId={attentionId} selectedTicketId={props.selectedTicketId} nodeElements={nodeElements.current} onAttention={setAttentionId} onActivate={activateTicket} onStartConnection={setConnectionSourceId} />)}
      </div>
      <div className="semantic-lod-indicator" aria-live="polite"><span>SEMÂNTICA</span>{Math.round(camera.zoom * 100)}% · escala {Math.round(camera.scale * 100)}%</div>
      <div className="semantic-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(-0.08)} aria-label="Reduzir nível semântico">−</button>
        <button onClick={fitContext} aria-label="Enquadrar contexto atual">⌂</button>
        <button onClick={() => zoomBy(0.08)} aria-label="Ampliar nível semântico">+</button>
      </div>
      <svg className="semantic-minimap" viewBox={minimapViewBox} aria-label="Minimapa do contexto visível">
        <rect className="semantic-minimap-viewport" x={-camera.x / camera.scale} y={-camera.y / camera.scale} width={size.width / camera.scale} height={size.height / camera.scale} />
        <path d={visibleEdges.map(({ path }) => path).join(" ")} />
        <path className="semantic-minimap-nodes" d={rendered.filter((node) => node.opacity > 0.05).map(minimapNodePath).join(" ")} />
      </svg>
      <div className="semantic-help">Wheel ancora no evento · mover não faz pan · <kbd>Ctrl</kbd>/<kbd>⌘</kbd> só escala · <kbd>Shift</kbd> + wheel horizontal · <kbd>C</kbd> cores</div>
    </div>
  </section>;
}
