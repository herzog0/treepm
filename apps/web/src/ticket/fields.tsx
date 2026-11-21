import { forwardRef, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { ApiClient, Person, TicketDetail, TicketStatus, TicketSummary, UpdateTicketBody } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { STATUS_TEXT } from "../map/nodeContent.js";
import { StatusMark } from "../map/StatusMark.js";
import { useAction } from "../panel/useAction.js";
import { isOpenStatus, reopenedNotice, reopensOnReceiving } from "./reopen.js";
import { descendantIds } from "./tree.js";

const STATUSES: readonly TicketStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];

type Action = ReturnType<typeof useAction>;
const ActionError = ({ action }: { action: Action }) => {
  const describeError = useDescribeApiError();
  return action.error ? <p role="alert" className="ticket-error">{describeError(action.error)}</p> : null;
};

/** Esc dentro da edição cancela só a edição: não chega à página, que fecharia. */
export function cancelOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    onCancel();
  };
}

interface FieldBase {
  client: ApiClient;
  detail: TicketDetail;
  onSaved: () => void;
}

/** Edita um campo de texto com "Salvar" e "Cancelar"; só envia o que mudou. */
function useTextEdit(client: ApiClient, detail: TicketDetail, field: "title" | "description", onSaved: () => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const action = useAction();
  const startButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Ao sair da edição o foco volta ao botão que a abriu, para o teclado não se perder no corpo da página.
  useEffect(() => {
    if (wasEditing.current && !editing) startButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const start = () => {
    action.clear();
    setDraft(detail[field]);
    setEditing(true);
  };
  const cancel = () => {
    action.clear();
    setEditing(false);
  };
  const value = field === "title" ? draft.trim() : draft;
  const canSave = !action.busy && value !== detail[field] && (field === "description" || value !== "");
  const save = async () => {
    if (!canSave) return;
    const body: UpdateTicketBody = { [field]: value };
    const result = await action.run(() => client.updateTicket(detail.id, body));
    if (!result.ok) return;
    setEditing(false);
    onSaved();
  };
  return { editing, draft, setDraft, action, start, startButton, cancel, canSave, save };
}

const EditActions = ({ canSave, onSave, onCancel }: { canSave: boolean; onSave: () => void; onCancel: () => void }) => (
  <div className="ticket-actions">
    <button type="button" className="primary" disabled={!canSave} onClick={onSave}>Salvar</button>
    <button type="button" onClick={onCancel}>Cancelar</button>
  </div>
);

export const TitleField = forwardRef<HTMLHeadingElement, FieldBase & { canEdit: boolean }>(function TitleField({ client, detail, canEdit, onSaved }, ref) {
  const edit = useTextEdit(client, detail, "title", onSaved);
  if (edit.editing) {
    return (
      <div className="ticket-edit" onKeyDown={cancelOnEscape(edit.cancel)}>
        <input aria-label="Título" autoFocus value={edit.draft} onChange={(event) => edit.setDraft(event.target.value)} />
        <EditActions canSave={edit.canSave} onSave={() => void edit.save()} onCancel={edit.cancel} />
        <ActionError action={edit.action} />
      </div>
    );
  }
  return (
    <div className="ticket-title-row">
      <h1 ref={ref} tabIndex={-1} className="ticket-title">{detail.title}</h1>
      {canEdit && <button ref={edit.startButton} type="button" className="text" onClick={edit.start}>Editar título</button>}
    </div>
  );
});

export function DescriptionField({ client, detail, canEdit, onSaved }: FieldBase & { canEdit: boolean }) {
  const edit = useTextEdit(client, detail, "description", onSaved);
  return (
    <section className="ticket-section" aria-labelledby="ticket-description-heading">
      <div className="ticket-section-head">
        <h2 id="ticket-description-heading">Descrição</h2>
        {canEdit && !edit.editing && <button ref={edit.startButton} type="button" className="text" onClick={edit.start}>Editar descrição</button>}
      </div>
      {edit.editing ? (
        <div className="ticket-edit" onKeyDown={cancelOnEscape(edit.cancel)}>
          <textarea aria-label="Descrição" rows={8} autoFocus value={edit.draft} onChange={(event) => edit.setDraft(event.target.value)} />
          <EditActions canSave={edit.canSave} onSave={() => void edit.save()} onCancel={edit.cancel} />
          <ActionError action={edit.action} />
        </div>
      ) : detail.description.trim() === "" ? (
        <p className="ticket-muted">Sem descrição.</p>
      ) : (
        <p className="ticket-description">{detail.description}</p>
      )}
    </section>
  );
}

/** Mensagem junto da situação quando a API recusa concluir com filho direto aberto (ADR 0034). */
export const describeOpenItems = (count: number) =>
  count === 1 ? "Conclua ou cancele o item aberto antes de concluir este ticket." : `Conclua ou cancele os ${count} itens abertos antes de concluir este ticket.`;

/** `openItems`: filhos diretos abertos, contados na lista de itens da própria página. */
export function StatusField({ client, detail, openItems, onSaved }: FieldBase & { openItems: number }) {
  const action = useAction();
  const change = async (status: TicketStatus) => {
    if (status === detail.status || action.busy) return;
    const result = await action.run(() => client.updateTicket(detail.id, { status }));
    if (result.ok) onSaved();
  };
  return (
    <>
      <div className="ticket-status-group" role="group" aria-label="Situação">
        {STATUSES.map((status) => (
          <button key={status} type="button" aria-pressed={detail.status === status} disabled={action.busy} onClick={() => void change(status)}>
            <StatusMark status={status} />
            {STATUS_TEXT[status]}
          </button>
        ))}
      </div>
      {action.error?.code === "ticket_has_open_children" ? <p role="alert" className="ticket-error">{describeOpenItems(openItems)}</p> : <ActionError action={action} />}
    </>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");

export function PeopleField({ client, detail, people, canEdit, onSaved }: FieldBase & { people: readonly Person[]; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const assigned = new Set(detail.assigneeIds);
  const candidates = people.filter((person) => person.active && !assigned.has(person.id));
  const nameOf = (id: string) => people.find((person) => person.id === id)?.displayName ?? "Pessoa removida";

  const add = async (personId: string) => {
    if (personId === "") return;
    const result = await action.run(() => client.putTicketAssignee(detail.id, personId));
    if (!result.ok) return;
    setAdding(false);
    onSaved();
  };
  const remove = async (personId: string) => {
    const result = await action.run(() => client.removeTicketAssignee(detail.id, personId));
    if (result.ok) onSaved();
  };

  return (
    <>
      <div className="ticket-people">
        {detail.assigneeIds.length === 0 && !canEdit && <span className="ticket-muted">Ninguém atribuído</span>}
        {detail.assigneeIds.map((id) => (
          <span key={id} className="ticket-person">
            <span aria-hidden="true" className="ticket-avatar">{initials(nameOf(id))}</span>
            {nameOf(id)}
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={`Remover ${nameOf(id)}`} disabled={action.busy} onClick={() => void remove(id)}>×</button>
            )}
          </span>
        ))}
        {canEdit && !adding && <button type="button" className="ticket-dashed" onClick={() => setAdding(true)}>Adicionar</button>}
        {canEdit && adding && (
          <select aria-label="Adicionar pessoa" autoFocus value="" disabled={action.busy} onChange={(event) => void add(event.target.value)}>
            <option value="">Escolher pessoa</option>
            {candidates.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        )}
      </div>
      <ActionError action={action} />
    </>
  );
}

interface ParentProps extends FieldBase {
  parent: TicketSummary | null;
  tickets: readonly TicketSummary[];
  canEdit: boolean;
  onOpen: (id: string) => void;
}

const TicketLabel = ({ ticket }: { ticket: TicketSummary }): ReactNode => (
  <>
    <span className="ticket-key">{ticket.key}</span>
    <span className="ticket-child-title">{ticket.title}</span>
  </>
);

export function ParentField({ client, detail, parent, tickets, canEdit, onOpen, onSaved }: ParentProps) {
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [reopened, setReopened] = useState<string | null>(null);
  const action = useAction();
  const blocked = descendantIds(tickets, detail.id);
  const needle = filter.trim().toLowerCase();
  const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  // Qualquer ticket do projeto recebe itens (ADR 0034): só o próprio nó e seus descendentes ficam fora.
  const candidates = tickets.filter((entry) => entry.id !== detail.id && !blocked.has(entry.id) && matches(`${entry.key} ${entry.title}`));

  const choose = async (parentId: string | null) => {
    const result = await action.run(() => client.updateTicket(detail.id, { parentId }));
    if (!result.ok) return;
    // A escolha vale no clique, sem confirmação: o aviso diz o que a API fez (ADR 0034).
    const target = parentId === null ? null : tickets.find((entry) => entry.id === parentId);
    setReopened(target && reopensOnReceiving(target) && isOpenStatus(detail.status) ? target.key : null);
    setPicking(false);
    setFilter("");
    onSaved();
  };

  return (
    <>
      <div className="ticket-parent">
        {parent ? (
          <button type="button" className="ticket-chip ticket-chip-button" onClick={() => onOpen(parent.id)}><TicketLabel ticket={parent} /></button>
        ) : (
          <span>Raiz do projeto</span>
        )}
        {canEdit && (
          <button type="button" className="text" aria-expanded={picking} onClick={() => { setReopened(null); setPicking((open) => !open); }}>Mudar</button>
        )}
      </div>
      {reopened !== null && <p className="ticket-notice" role="status">{reopenedNotice(reopened)}</p>}
      {picking && (
        <div className="ticket-picker" role="group" aria-label="Escolher o ticket pai">
          <input aria-label="Filtrar tickets" autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="ticket-picker-list">
            {matches("Raiz do projeto") && <button type="button" disabled={action.busy} onClick={() => void choose(null)}>Raiz do projeto</button>}
            {candidates.map((entry) => (
              <button key={entry.id} type="button" disabled={action.busy} onClick={() => void choose(entry.id)}><TicketLabel ticket={entry} /></button>
            ))}
          </div>
        </div>
      )}
      <ActionError action={action} />
    </>
  );
}
