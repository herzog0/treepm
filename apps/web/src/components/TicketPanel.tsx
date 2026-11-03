import { useState } from "react";
import { childrenOf, descendantIds, getProgress, ticketIdentifier } from "@treepm/domain";
import type { Ticket, TicketComponent, TicketEdge, User } from "@treepm/domain";
import { Avatars } from "./Avatars.js";

interface TicketPanelProps {
  ticket: Ticket;
  tickets: Ticket[];
  users: User[];
  projectKey: string;
  onClose: () => void;
  onSave: (input: unknown) => Promise<void>;
  onDelete: (recursive: boolean) => Promise<void>;
  onAddSubticket: () => void;
  onStartLink: () => void;
}

export function TicketPanel({ ticket, tickets, users, projectKey, onClose, onSave, onDelete, onAddSubticket, onStartLink }: TicketPanelProps) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [parentId, setParentId] = useState<string | null>(ticket.parentId);
  const [status, setStatus] = useState(ticket.status);
  const [assigneeIds, setAssigneeIds] = useState(ticket.assigneeIds);
  const [components, setComponents] = useState(() => ticket.components.map((component) => ({
    ...component,
    editorId: crypto.randomUUID(),
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isLeaf = childrenOf(tickets, ticket.id).length === 0;
  const progress = getProgress(tickets, ticket.id);
  const invalidParents = new Set([ticket.id, ...descendantIds(tickets, ticket.id)]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const payloadComponents: TicketComponent[] = components.map(({ name, assigneeIds: componentAssigneeIds }) => ({
        name,
        assigneeIds: componentAssigneeIds,
      }));
      await onSave({ title, description, parentId, ...(isLeaf ? { status } : {}), assigneeIds, components: payloadComponents });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };

  const updateComponent = (index: number, update: Partial<TicketComponent>) => {
    setComponents((current) => current.map((component, position) => position === index ? { ...component, ...update } : component));
  };

  return (
    <aside className="detail-panel" aria-label={`Detalhes de ${ticket.title}`}>
      <div className="panel-heading">
        <div><span className="eyebrow">{ticketIdentifier(ticket, projectKey)}</span><h2>Detalhes do ticket</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Fechar detalhes">×</button>
      </div>
      <div className={`panel-progress status-${isLeaf ? ticket.status : progress.status}`}>
        <strong>{isLeaf ? { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" }[ticket.status] : `${progress.percent}% concluído`}</strong>
        <span>{progress.label}</span>
      </div>
      <label>Título<input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Descrição<textarea value={description} rows={4} maxLength={5000} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Pai hierárquico
        <select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)}>
          <option value="">Raiz do projeto</option>
          {tickets.filter((item) => !invalidParents.has(item.id)).map((item) => <option value={item.id} key={item.id}>{ticketIdentifier(item, projectKey)} · {item.title}</option>)}
        </select>
      </label>
      <label>Status { !isLeaf && <small>derivado das folhas</small> }
        <select value={status} disabled={!isLeaf} onChange={(event) => setStatus(event.target.value as Ticket["status"])}>
          <option value="todo">A fazer</option><option value="in_progress">Em andamento</option><option value="done">Concluído</option>
        </select>
      </label>
      <fieldset className="people-picker"><legend>Responsáveis do ticket</legend>
        {users.map((user) => <label className="check-row" key={user.id}><input type="checkbox" checked={assigneeIds.includes(user.id)} onChange={() => setAssigneeIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} /><span className="avatar small" style={{ backgroundColor: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</label>)}
      </fieldset>
      <div className="component-editor">
        <div className="section-title"><h3>Componentes e responsáveis</h3><button className="text-button" onClick={() => setComponents([...components, { name: "novo componente", assigneeIds: [], editorId: crypto.randomUUID() }])}>+ Adicionar</button></div>
        {components.map((component, index) => <div className="component-editor-row" key={component.editorId}>
          <input aria-label={`Nome do componente ${index + 1}`} value={component.name} onChange={(event) => updateComponent(index, { name: event.target.value })} />
          <select multiple aria-label={`Responsáveis por ${component.name}`} value={component.assigneeIds} onChange={(event) => updateComponent(index, { assigneeIds: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}>
            {users.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}
          </select>
          <Avatars userIds={component.assigneeIds} users={users} compact />
          <button className="text-button danger" onClick={() => setComponents(components.filter((_item, position) => position !== index))}>Remover</button>
        </div>)}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel-actions"><button className="button primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar alterações"}</button><button className="button" onClick={onAddSubticket}>+ Subticket</button></div>
      <button className="button full-width" onClick={onStartLink}>Criar dependência a partir deste ticket</button>
      <div className="danger-zone"><h3>Excluir ticket</h3><p>{isLeaf ? "A exclusão também remove suas conexões." : "Por segurança, a subárvore inteira só será excluída após confirmação explícita."}</p><button className="text-button danger" onClick={() => {
        if (window.confirm(isLeaf ? `Excluir “${ticket.title}”?` : `Excluir “${ticket.title}” e todos os ${progress.totalLeaves > 0 ? "descendentes" : "itens"}? Esta ação não pode ser desfeita.`)) void onDelete(!isLeaf).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Falha ao excluir."));
      }}>Excluir {isLeaf ? "ticket" : "subárvore"}</button></div>
    </aside>
  );
}

export function EdgeEditor({ edge, tickets, onClose, onSave, onDelete }: {
  edge: TicketEdge;
  tickets: Ticket[];
  onClose: () => void;
  onSave: (style: TicketEdge["style"]) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [style, setStyle] = useState(edge.style);
  const [error, setError] = useState("");
  const source = tickets.find((ticket) => ticket.id === edge.sourceId);
  const target = tickets.find((ticket) => ticket.id === edge.targetId);
  return <aside className="detail-panel edge-editor">
    <div className="panel-heading"><div><span className="eyebrow">{edge.type === "dependency" ? "DEPENDÊNCIA" : "HIERARQUIA"}</span><h2>Conexão independente</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar editor">×</button></div>
    <p className="edge-route"><strong>{source?.title}</strong><span>→</span><strong>{target?.title}</strong></p>
    <label>Cor<input type="color" value={style.color} onChange={(event) => setStyle({ ...style, color: event.target.value })} /></label>
    <label>Espessura <output>{style.width}px</output><input type="range" min="1" max="8" step="1" value={style.width} onChange={(event) => setStyle({ ...style, width: Number(event.target.value) })} /></label>
    <label className="check-row"><input type="checkbox" checked={style.dashed} onChange={(event) => setStyle({ ...style, dashed: event.target.checked })} />Linha tracejada</label>
    {Object.entries(edge.metadata).map(([key, value]) => <p className="metadata" key={key}><span>{key}</span>{value}</p>)}
    {error && <p className="form-error">{error}</p>}
    <button className="button primary full-width" onClick={() => void onSave(style).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Falha ao salvar."))}>Salvar estilo</button>
    {edge.type === "dependency" ? <button className="button danger-outline full-width" onClick={() => void onDelete().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Falha ao remover."))}>Remover dependência</button> : <p className="muted-note">Para alterar esta conexão, edite o pai hierárquico do ticket.</p>}
  </aside>;
}
