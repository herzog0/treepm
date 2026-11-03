import { useEffect, useRef, useState } from "react";
import type { WheelEvent as ReactWheelEvent } from "react";
import { childrenOf, descendantsOf, ticketIdentifier } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import type { PrototypeData } from "./shared.js";
import { personInitials, statusInfo, ticketPath } from "./shared.js";

type SemanticCard = "full" | "compact" | "chip" | "dot";

export function VariantB({ project, tickets, users }: PrototypeData) {
  const root = childrenOf(tickets, null)[0];
  const [focusId, setFocusId] = useState(root?.id ?? tickets[0]?.id ?? "");
  const [level, setLevel] = useState(0.35);
  const [width, setWidth] = useState(1160);
  const stageRef = useRef<HTMLDivElement>(null);
  const focus = tickets.find((ticket) => ticket.id === focusId) ?? root;
  const path = focus ? ticketPath(tickets, focus.id) : [];
  const siblings = focus ? childrenOf(tickets, focus.parentId).filter((ticket) => ticket.id !== focus.id) : [];
  const children = focus ? childrenOf(tickets, focus.id) : [];

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  if (!focus) return null;
  const pathIds = new Set(path.map((ticket) => ticket.id));
  const lateral = path.flatMap((ancestor) => childrenOf(tickets, ancestor.parentId)
    .filter((ticket) => !pathIds.has(ticket.id) && ticket.parentId !== focus.parentId));
  const siblingKind: SemanticCard = level < 0.65 ? "full" : level < 1.15 ? "compact" : level < 1.75 ? "chip" : "dot";
  const childKind: SemanticCard = level < 0.55 ? "full" : level < 1.1 ? "compact" : level < 1.65 ? "chip" : "dot";
  const focusKind: SemanticCard = level < 1.65 ? "full" : "compact";
  const omitted = Math.max(0, tickets.length - new Set([...path, ...siblings, ...children, ...lateral].map((ticket) => ticket.id)).size);

  const changeLevel = (next: number) => setLevel(Math.min(2, Math.max(0, next)));
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeLevel(level + event.deltaY * 0.0018);
  };

  return <div className="proto-b">
    <div className="proto-statebar">
      <div><span>FOCO EXPLÍCITO</span><strong>{ticketIdentifier(focus, project.key)} · {focus.title}</strong></div>
      <div className="proto-state-metrics"><span>semântica {Math.round(level * 50)}%</span><span>câmera 100%</span><span>{siblings.length + children.length + lateral.length + 1} visíveis · {omitted} em resumos</span></div>
    </div>
    <div className="proto-b-toolbar">
      <nav className="proto-breadcrumb" aria-label="Caminho do foco">{path.map((ticket, index) => <span key={ticket.id}>{index > 0 && <i>›</i>}<button className={ticket.id === focusId ? "current" : ""} onClick={() => setFocusId(ticket.id)}>{ticket.title}</button></span>)}</nav>
      <label>NÍVEL SEMÂNTICO <input type="range" min="0" max="2" step="0.05" value={level} onChange={(event) => changeLevel(Number(event.target.value))} /><output>{level < 0.65 ? "detalhe" : level < 1.2 ? "compacto" : level < 1.75 ? "chips" : "status"}</output></label>
    </div>
    <div className="proto-b-stage" ref={stageRef} onWheel={onWheel}>
      <div className="proto-b-row-label" style={{ top: 70 }}>IRMÃOS DO FOCO · {siblings.length}</div>
      <div className="proto-b-row-label" style={{ top: 268 }}>FOCO ATUAL</div>
      <div className="proto-b-row-label" style={{ top: 474 }}>FILHOS DO FOCO · {children.length}</div>
      <SemanticRow tickets={siblings} kind={siblingKind} y={100} availableWidth={width - 280} projectKey={project.key} allTickets={tickets} users={users} focusId={focusId} onFocus={setFocusId} />
      <SemanticRow tickets={[focus]} kind={focusKind} y={298} availableWidth={width - 280} projectKey={project.key} allTickets={tickets} users={users} focusId={focusId} onFocus={setFocusId} />
      {children.length > 0 ? <SemanticRow tickets={children} kind={childKind} y={504} availableWidth={width - 280} projectKey={project.key} allTickets={tickets} users={users} focusId={focusId} onFocus={setFocusId} /> : <div className="proto-b-leaf-note">Folha selecionada · não há filhos; o contexto e os irmãos continuam visíveis.</div>}
      <aside className="proto-b-laterals" aria-label="Ramos laterais resumidos">
        <span>RAMOS LATERAIS · {lateral.length}</span>
        {lateral.map((ticket) => {
          const info = statusInfo(tickets, ticket);
          const count = descendantsOf(tickets, ticket.id).length;
          return <button key={ticket.id} onClick={() => setFocusId(ticket.id)} className={`proto-b-summary proto-status-${info.status}`}>
            <small>{ticketIdentifier(ticket, project.key)}</small><strong>{ticket.title}</strong><span>{count} descendentes</span><div>{info.label}<i style={{ width: `${info.progress.percent}%` }} /></div>
          </button>;
        })}
      </aside>
      <div className="proto-b-help">Clique muda o foco · wheel ou slider muda apenas a semântica</div>
    </div>
  </div>;
}

function SemanticRow({ tickets, kind, y, availableWidth, projectKey, allTickets, users, focusId, onFocus }: {
  tickets: Ticket[];
  kind: SemanticCard;
  y: number;
  availableWidth: number;
  projectKey: string;
  allTickets: Ticket[];
  users: PrototypeData["users"];
  focusId: string;
  onFocus: (id: string) => void;
}) {
  const cardWidth = kind === "full" ? 246 : kind === "compact" ? 198 : kind === "chip" ? 122 : 20;
  const gap = kind === "dot" ? 9 : 14;
  const total = tickets.length * cardWidth + Math.max(0, tickets.length - 1) * gap;
  const start = Math.max(20, (availableWidth - total) / 2);
  return <>{tickets.map((ticket, index) => {
    const info = statusInfo(allTickets, ticket);
    const x = start + index * (cardWidth + gap);
    return <button key={ticket.id} className={`proto-b-card proto-card-${kind} proto-status-${info.status} ${ticket.id === focusId ? "is-focus" : ""}`}
      style={{ left: x, top: y }} title={`${ticket.title} — ${info.label}`} aria-label={`${ticket.title}. ${info.label}`} onClick={() => onFocus(ticket.id)}>
      {kind === "dot" ? <span className="proto-sr-only">{ticket.title}</span> : <>
        <span className="proto-card-key">{ticketIdentifier(ticket, projectKey)}</span>
        <strong>{ticket.title}</strong>
        {(kind === "full" || kind === "compact") && <span className="proto-card-people">{personInitials(ticket.assigneeIds, users) || "Sem responsável"}</span>}
        <span className="proto-card-progress">{info.label}</span>
        <span className="proto-mini-track"><i style={{ width: `${info.progress.percent}%` }} /></span>
      </>}
    </button>;
  })}</>;
}
