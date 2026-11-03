import { useState } from "react";
import type { ClassificationSuggestion, Project, Ticket, User } from "@treepm/domain";
import { ticketIdentifier } from "@treepm/domain";
import { api } from "../api.js";

interface TicketFormProps {
  project: Project;
  tickets: Ticket[];
  users: User[];
  initialParentId: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function TicketForm({ project, tickets, users, initialParentId, onClose, onCreated }: TicketFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [component, setComponent] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [suggestion, setSuggestion] = useState<ClassificationSuggestion | null>(null);
  const [busy, setBusy] = useState<"suggest" | "create" | null>(null);
  const [error, setError] = useState("");

  const suggest = async () => {
    setBusy("suggest");
    setError("");
    try {
      setSuggestion(await api.suggest(project.id, { title, description }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível obter sugestão.");
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    setError("");
    try {
      await api.createTicket(project.id, {
        title, description, parentId, status: "todo", assigneeIds,
        components: component.trim() ? [{ name: component.trim(), assigneeIds: [] }] : [],
      });
      await onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o ticket.");
    } finally {
      setBusy(null);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ticket-form-modal" role="dialog" aria-modal="true" aria-labelledby="new-ticket-title">
      <div className="panel-heading"><div><span className="eyebrow">NOVO TRABALHO</span><h2 id="new-ticket-title">{initialParentId ? "Criar subticket" : "Criar ticket"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar formulário">×</button></div>
      <p className="form-intro">Descreva o trabalho. A sugestão de Jev é opcional e só será aplicada após sua confirmação.</p>
      <label>Título<input autoFocus value={title} maxLength={160} placeholder="Ex.: Validar navegação com teclado" onChange={(event) => { setTitle(event.target.value); setSuggestion(null); }} /></label>
      <label>Descrição<textarea rows={5} value={description} maxLength={5000} placeholder="Contexto, resultado esperado e restrições…" onChange={(event) => { setDescription(event.target.value); setSuggestion(null); }} /></label>
      <button className="button suggest-button" disabled={busy !== null || !title.trim()} onClick={() => void suggest()}>{busy === "suggest" ? "Consultando Jev…" : "Sugerir categoria e posição"}<span>JEV · SYSTEM ONE</span></button>
      {suggestion && <div className={`suggestion suggestion-${suggestion.mode}`} aria-live="polite">
        <div className="suggestion-heading"><strong>{suggestion.mode === "available" ? "Sugestão recebida" : "Classificação manual"}</strong>{suggestion.mode === "available" && <span>{Math.round(suggestion.confidence * 100)}% confiança mínima</span>}</div>
        <p>{suggestion.message}</p>
        {suggestion.path.length > 0 && <ol className="suggestion-path">{suggestion.path.map((level) => <li key={`${level.depth}-${level.choice}`}><span>Nível {level.depth + 1}</span><strong>{level.label}</strong><small>{Math.round(level.confidence * 100)}% · {Object.entries(level.probabilities).slice(0, 3).map(([id, probability]) => `${id === "__stop__" ? "parar" : tickets.find((ticket) => ticket.id === id)?.title ?? id}: ${Math.round(probability * 100)}%`).join(" · ")}</small></li>)}</ol>}
        {suggestion.mode === "available" && !suggestion.manualRequired && <button className="button" onClick={() => { setParentId(suggestion.parentId); setComponent(suggestion.category ?? ""); }}>Confirmar e preencher sugestão</button>}
        {suggestion.manualRequired && <strong className="manual-warning">Escolha obrigatória: revise os campos abaixo manualmente.</strong>}
      </div>}
      <div className="form-grid">
        <label>Pai hierárquico<select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)}><option value="">Raiz do projeto</option>{tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticketIdentifier(ticket, project.key)} · {ticket.title}</option>)}</select></label>
        <label>Componente inicial<input value={component} placeholder="frontend, design…" onChange={(event) => setComponent(event.target.value)} /></label>
      </div>
      <fieldset className="people-picker horizontal"><legend>Responsáveis</legend>{users.map((user) => <label className="check-row" key={user.id}><input type="checkbox" checked={assigneeIds.includes(user.id)} onChange={() => setAssigneeIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} />{user.name}</label>)}</fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button" onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy !== null || !title.trim()} onClick={() => void create()}>{busy === "create" ? "Criando…" : "Criar ticket"}</button></div>
    </section>
  </div>;
}
