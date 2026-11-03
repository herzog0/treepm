import { depthOf, getProgress, ticketIdentifier } from "@treepm/domain";
import type { Project, Ticket, TicketStatus, User } from "@treepm/domain";
import { Avatars } from "./Avatars.js";

const STATUS_LABEL: Record<TicketStatus, string> = { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" };

interface WorkViewProps {
  project: Project;
  tickets: Ticket[];
  users: User[];
  onSelect: (ticketId: string) => void;
  onStatus: (ticketId: string, status: TicketStatus) => Promise<void>;
}

export function ListView({ project, tickets, users, onSelect }: WorkViewProps) {
  return <section className="work-view"><div className="view-heading"><div><span className="eyebrow">VISÃO SECUNDÁRIA</span><h2>Lista do projeto</h2></div><p>O recuo preserva o contexto da hierarquia.</p></div><div className="table-scroll"><table><thead><tr><th>Ticket</th><th>Status / progresso</th><th>Responsáveis</th><th>Componentes</th></tr></thead><tbody>{tickets.map((ticket) => {
    const progress = getProgress(tickets, ticket.id);
    const isLeaf = !tickets.some((item) => item.parentId === ticket.id);
    return <tr key={ticket.id}><td><button className="table-ticket" onClick={() => onSelect(ticket.id)} style={{ paddingLeft: `${depthOf(tickets, ticket.id) * 24}px` }}><span>{ticketIdentifier(ticket, project.key)}</span><strong>{ticket.title}</strong></button></td><td><span className={`status-pill status-${isLeaf ? ticket.status : progress.status}`}>{isLeaf ? STATUS_LABEL[ticket.status] : `${progress.doneLeaves}/${progress.totalLeaves} folhas · ${progress.percent}%`}</span></td><td><Avatars userIds={ticket.assigneeIds} users={users} compact /></td><td><div className="component-list">{ticket.components.map((component) => <span className="component-chip" key={component.name}>{component.name}</span>)}</div></td></tr>;
  })}</tbody></table></div></section>;
}

export function KanbanView(props: WorkViewProps) {
  const columns: { id: TicketStatus; title: string; description: string }[] = [
    { id: "todo", title: "A fazer", description: "Nada começou" },
    { id: "in_progress", title: "Em andamento", description: "Trabalho parcial ou ativo" },
    { id: "done", title: "Concluído", description: "Todas as folhas concluídas" },
  ];
  return <section className="work-view"><div className="view-heading"><div><span className="eyebrow">VISÃO SECUNDÁRIA</span><h2>Kanban</h2></div><p>Pais acompanham o agregado; somente folhas mudam de status.</p></div><div className="kanban-board">{columns.map((column) => {
    const tickets = props.tickets.filter((ticket) => {
      const isLeaf = !props.tickets.some((item) => item.parentId === ticket.id);
      return isLeaf ? ticket.status === column.id : (getProgress(props.tickets, ticket.id).status === "done" ? "done" : getProgress(props.tickets, ticket.id).status === "active" ? "in_progress" : "todo") === column.id;
    });
    return <section className="kanban-column" key={column.id} aria-labelledby={`column-${column.id}`}><div className="kanban-column-heading"><div><h3 id={`column-${column.id}`}>{column.title}</h3><p>{column.description}</p></div><span>{tickets.length}</span></div><div className="kanban-cards">{tickets.map((ticket) => {
      const isLeaf = !props.tickets.some((item) => item.parentId === ticket.id);
      const progress = getProgress(props.tickets, ticket.id);
      return <article className="kanban-card" key={ticket.id}><button className="kanban-title" onClick={() => props.onSelect(ticket.id)}><span>{ticketIdentifier(ticket, props.project.key)}</span><strong>{ticket.title}</strong></button><Avatars userIds={ticket.assigneeIds} users={props.users} compact />{isLeaf ? <label>Status<select value={ticket.status} onChange={(event) => void props.onStatus(ticket.id, event.target.value as TicketStatus)}>{Object.entries(STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : <div className="progress-block"><div className="progress-copy"><span>{progress.label}</span><strong>{progress.percent}%</strong></div><div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div></div>}</article>;
    })}</div></section>;
  })}</div></section>;
}
