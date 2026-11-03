import { useMemo, useState } from "react";
import { childrenOf, descendantsOf, ticketIdentifier } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import type { PrototypeData } from "./shared.js";
import { statusInfo } from "./shared.js";

interface ListRow { ticket: Ticket; depth: number; hidden: boolean }

export function VariantD({ project, tickets, users }: PrototypeData) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const rows = useMemo(() => {
    const result: ListRow[] = [];
    const visit = (parentId: string | null, depth: number, hidden: boolean) => {
      for (const ticket of childrenOf(tickets, parentId)) {
        const isCollapsed = collapsed.has(ticket.id);
        result.push({ ticket, depth, hidden });
        visit(ticket.id, depth + 1, hidden || isCollapsed);
      }
    };
    visit(null, 0, false);
    return result;
  }, [tickets, collapsed]);
  const visible = rows.filter((row) => !row.hidden).length;

  const toggle = (ticketId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  };

  return <div className="proto-d">
    <div className="proto-statebar">
      <div><span>LISTA HIERÁRQUICA APRIMORADA</span><strong>{project.name}</strong></div>
      <div className="proto-state-metrics"><span>{visible} visíveis</span><span>{tickets.length - visible} ocultos por colapsos</span><span>{collapsed.size} ramos recolhidos</span></div>
    </div>
    <div className="proto-d-toolbar"><p>O recuo preserva a origem. Recolha ramos sem perder a contagem de trabalho.</p><button onClick={() => setCollapsed(new Set())} disabled={collapsed.size === 0}>Expandir todos</button></div>
    <div className="proto-d-table" role="table" aria-label="Tickets hierárquicos">
      <div className="proto-d-head" role="row"><span role="columnheader">TICKET / HIERARQUIA</span><span role="columnheader">STATUS / PROGRESSO</span><span role="columnheader">RESPONSÁVEIS</span><span role="columnheader">COMPONENTES</span></div>
      <div className="proto-d-body" role="rowgroup">{rows.map(({ ticket, depth, hidden }) => {
        const children = childrenOf(tickets, ticket.id);
        const isParent = children.length > 0;
        const isCollapsed = collapsed.has(ticket.id);
        const info = statusInfo(tickets, ticket);
        const descendantCount = isCollapsed ? descendantsOf(tickets, ticket.id).length : 0;
        return <div key={ticket.id} role="row" aria-hidden={hidden} className={`proto-d-row ${isParent ? "is-parent" : "is-leaf"} ${hidden ? "is-hidden" : ""} ${activeId === ticket.id ? "is-active" : ""}`}>
          <div className="proto-d-title-cell" role="cell" style={{ paddingLeft: `${18 + depth * 25}px` }}>
            <span className="proto-d-guides" aria-hidden="true">{Array.from({ length: depth }, (_, index) => <i key={index} style={{ left: index * 25 + 9 }} />)}</span>
            {isParent ? <button className="proto-d-chevron" aria-label={`${isCollapsed ? "Expandir" : "Colapsar"} ${ticket.title}`} aria-expanded={!isCollapsed} onClick={() => toggle(ticket.id)}>{isCollapsed ? "›" : "⌄"}</button> : <span className="proto-d-leaf-mark" aria-hidden="true" />}
            <button className="proto-d-ticket-name" onClick={() => setActiveId(ticket.id)} tabIndex={hidden ? -1 : 0}>
              <span>{ticketIdentifier(ticket, project.key)}</span><strong>{ticket.title}</strong>{isParent && <small>{children.length} filhos</small>}
            </button>
            {descendantCount > 0 && <span className="proto-d-hidden-count">+{descendantCount} ocultos</span>}
          </div>
          <div role="cell"><span className={`proto-d-status proto-status-${info.status}`}><i />{info.label}</span>{isParent && <span className="proto-d-track"><i style={{ width: `${info.progress.percent}%` }} /></span>}</div>
          <div role="cell" className="proto-d-people">{ticket.assigneeIds.length === 0 ? <span>Sem responsável</span> : ticket.assigneeIds.map((id) => {
            const user = users.find((item) => item.id === id);
            if (!user) return null;
            const initials = user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2);
            return <span key={id} className="proto-d-avatar" style={{ backgroundColor: user.color }} title={user.name} aria-label={user.name}>{initials}</span>;
          })}</div>
          <div role="cell" className="proto-d-components">{ticket.components.length === 0 ? "—" : ticket.components.map((component) => <span key={component.name}>{component.name}</span>)}</div>
        </div>;
      })}</div>
    </div>
  </div>;
}
