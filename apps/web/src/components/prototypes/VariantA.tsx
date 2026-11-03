import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ticketIdentifier } from "@treepm/domain";
import { semanticEdgePath } from "../semanticScene.js";
import { useSemanticGestures } from "../useSemanticGestures.js";
import type { PrototypeData } from "./shared.js";
import { personInitials, statusInfo, ticketPath, visibleLabel } from "./shared.js";

export function VariantA({ project, tickets, users }: PrototypeData) {
  const [colorMode, setColorMode] = useState(false);
  const {
    camera,
    focusId,
    transition,
    attentionId,
    rendered,
    stageRef,
    isDragging,
    focusTicket,
    setAttentionId,
    zoomBy,
    fitContext,
    gestureHandlers,
  } = useSemanticGestures(tickets);
  const focus = tickets.find((ticket) => ticket.id === focusId) ?? tickets[0];
  const path = focus ? ticketPath(tickets, focus.id) : [];
  const visibleCount = rendered.filter((node) => node.opacity > 0.05).length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"))) return;
      event.preventDefault();
      setColorMode((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!focus) return null;
  const focusedStatus = statusInfo(tickets, focus);
  const transitionTarget = transition ? tickets.find((ticket) => ticket.id === transition.toId) : undefined;
  return <div className={`proto-a ${colorMode ? "is-color-mode" : ""}`}>
    <div className="proto-statebar">
      <div><span>FOCO EXPLÍCITO · ZOOM ANCORADO</span><strong>{ticketIdentifier(focus, project.key)} · {focus.title}</strong></div>
      <div className="proto-state-metrics">
        {transitionTarget && transition && <span>atenção {Math.round(transition.progress * 100)}% → {transitionTarget.title}</span>}
        <span>semântica {Math.round(camera.zoom * 100)}% · escala {Math.round(camera.scale * 100)}%</span>
        <span>{visibleLabel(visibleCount, tickets.length - visibleCount)}</span>
        <button type="button" className="proto-a-color-toggle" data-color-mode={colorMode ? "on" : "off"} aria-pressed={colorMode} aria-keyshortcuts="C" onClick={() => setColorMode((current) => !current)}>
          Cores {colorMode ? "ativas" : "neutras"} <kbd>C</kbd>
        </button>
      </div>
    </div>
    <div className="proto-a-path">{path.map((ticket, index) => <span key={ticket.id}>{index > 0 && "›"}{ticket.title}</span>)}</div>
    <div className={`proto-a-stage ${isDragging ? "is-dragging" : ""}`} ref={stageRef} {...gestureHandlers}>
      <div className="proto-a-scene" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}>
        <svg className="proto-a-lines" aria-hidden="true">
          {rendered.flatMap((node) => {
            if (!node.node.ticket.parentId) return [];
            const parent = rendered.find((item) => item.node.ticket.id === node.node.ticket.parentId);
            if (!parent) return [];
            return [<path key={node.node.ticket.id} d={semanticEdgePath(parent, node)} style={{ opacity: Math.min(parent.opacity, node.opacity) }} className={node.kind === "dot" ? "muted" : ""} />];
          })}
        </svg>
        {rendered.map((node) => {
          const ticket = node.node.ticket;
          const info = statusInfo(tickets, ticket);
          const aggregationText = node.aggregate ? `${node.representedCount - 1} descendentes agregados` : "";
          const percent = node.aggregateTotalLeaves > 0 ? Math.round((node.aggregateDoneLeaves / node.aggregateTotalLeaves) * 100) : info.progress.percent;
          const progressLabel = node.aggregateTotalLeaves > 0 ? `${node.aggregateDoneLeaves}/${node.aggregateTotalLeaves} folhas agregadas · ${percent}%` : info.label;
          const label = `${progressLabel}${node.visualStatus === "mixed" ? " · estado misto" : ""}`;
          const accessibleStatus = [label, aggregationText].filter(Boolean).join(". ");
          return <article key={ticket.id} data-ticket-id={ticket.id} data-aggregate={node.aggregate ? "true" : "false"} data-represented-count={node.representedCount} data-aggregate-leaves={node.aggregateTotalLeaves} data-subtree-height={node.subtreeHeight} data-visual-status={node.visualStatus} data-compact-label={node.compactLabel ? "true" : "false"} className={`proto-a-node proto-card-${node.kind} proto-status-${node.visualStatus} ${ticket.id === focusId ? "is-focus" : ""} ${ticket.id === attentionId ? "is-attention" : ""}`}
            style={{
              width: node.width,
              height: node.height,
              opacity: node.opacity,
              pointerEvents: node.opacity < 0.05 ? "none" : "auto",
              transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0) translateX(-50%)`,
              "--proto-status": node.statusColor,
              "--proto-indicator-size": `${node.indicatorSize}px`,
            } as CSSProperties}
            onPointerEnter={() => setAttentionId(ticket.id)}
            onPointerLeave={() => setAttentionId((current) => current === ticket.id ? null : current)}>
            <span className="proto-a-color-wash" aria-hidden="true" />
            <button className="proto-a-card-main" tabIndex={node.opacity < 0.05 ? -1 : 0} title={`${ticket.title} — ${accessibleStatus}`} aria-label={`${ticket.title}. ${accessibleStatus}. Clique para fixar foco`} onClick={() => focusTicket(ticket.id)}>
              {node.kind === "dot" ? <span className="proto-sr-only">{ticket.title}. {accessibleStatus}</span> : <>
                <span className="proto-card-key">{ticketIdentifier(ticket, project.key)}</span>
                <strong>{ticket.title}</strong>
                {!node.compactLabel && <>
                  {(node.kind === "full" || node.kind === "compact") && <span className="proto-card-people">{personInitials(ticket.assigneeIds, users) || "Sem responsável"}</span>}
                  {node.aggregate && <span className="proto-summary-count">{aggregationText}</span>}
                  <span className="proto-card-progress">{label}</span>
                  <span className="proto-mini-track"><i style={{ width: `${percent}%` }} /></span>
                </>}
              </>}
            </button>
            {node.childIndicators.length > 0 && <span className="proto-a-child-indicators" aria-label="Filhos imediatos">
              {node.childIndicators.map((indicator) => {
                const childId = indicator.ticketIds.length === 1 ? indicator.ticketIds[0] : undefined;
                const child = childId ? tickets.find((item) => item.id === childId) : undefined;
                const statusLabel = { todo: "A fazer", not_started: "Não iniciado", in_progress: "Em andamento", active: "Em andamento", done: "Concluído", mixed: "Estado misto" }[indicator.visualStatus];
                const indicatorLabel = child ? `${ticketIdentifier(child, project.key)} ${child.title}. ${statusLabel}` : `${indicator.ticketIds.length} filhos agrupados. ${statusLabel}`;
                return <button type="button" key={indicator.id} className={`proto-a-child-indicator ${child ? "is-single" : "is-group"}`} data-indicator-ticket-id={childId} data-parent-ticket-id={ticket.id} data-visual-status={indicator.visualStatus} title={indicatorLabel} aria-label={indicatorLabel} tabIndex={node.opacity < 0.05 || indicator.opacity < 0.05 ? -1 : 0} style={{ opacity: indicator.opacity, pointerEvents: indicator.opacity < 0.05 ? "none" : "auto" }} onClick={() => focusTicket(childId ?? ticket.id)}>
                  {child ? <i style={{ backgroundColor: indicator.statusColor }} /> : <span style={{ backgroundColor: indicator.statusColor }}>{indicator.ticketIds.length}</span>}
                </button>;
              })}
            </span>}
          </article>;
        })}
      </div>
      <div className="proto-a-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(-0.08)} aria-label="Reduzir semântica">−</button>
        <button onClick={fitContext} aria-label="Enquadrar contexto">⌂</button>
        <button onClick={() => zoomBy(0.08)} aria-label="Ampliar semântica">+</button>
      </div>
      <div className="proto-a-help">Wheel no cursor · outro card recebe atenção no zoom+ · arraste para pan · C alterna cores</div>
      <div className="proto-a-focus-readout"><span className={`proto-status-dot proto-status-${focusedStatus.status}`} />{focusedStatus.label}</div>
    </div>
  </div>;
}
