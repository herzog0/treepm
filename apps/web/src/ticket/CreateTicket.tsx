import { useRef } from "react";
import type { FormEvent } from "react";
import type { ApiClient, CreateTicketBody, Project } from "../api/client.js";
import { useAction } from "../panel/useAction.js";
import { useState } from "react";
import { reopenWarning, reopensOnReceiving } from "./reopen.js";
import type { CreateRequest } from "./TicketPage.js";
import { useDescribeApiError } from "../api/errorText.js";

interface CreateTicketProps {
  client: ApiClient;
  project: Project | null;
  request: CreateRequest;
  onChanged: () => void;
  onCreated: (ticketId: string) => void;
  onCancel: () => void;
}

/** Modo de criação (ADR 0026): título obrigatório, descrição opcional; o ticket nasce sem pessoas e em "a fazer" (ADR 0034: não há tipo). */
export function CreateTicket({ client, project, request, onChanged, onCreated, onCancel }: CreateTicketProps) {
  const describeError = useDescribeApiError();
  const [title, setTitle] = useState(request.draft?.title ?? "");
  const [description, setDescription] = useState(request.draft?.description ?? "");
  const action = useAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const trimmed = title.trim();
  const isChild = request.parentId !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || action.busy) return;
    const body: CreateTicketBody = { title: trimmed };
    if (description.trim() !== "") body.description = description;
    if (request.parentId !== null) body.parentId = request.parentId;
    const result = await action.run(() => client.createTicket(request.projectId, body));
    if (!result.ok) return;
    onChanged();
    onCreated(result.data.id);
  };

  return (
    <div className="ticket-body">
      <div className="ticket-scroll">
        <h1 ref={heading} className="ticket-title">Novo ticket</h1>
        <p className="ticket-muted">{project ? `Em ${project.name}${isChild ? ", dentro do ticket aberto" : ", na raiz do projeto"}.` : ""}</p>
        {request.parent && reopensOnReceiving(request.parent) && <p className="ticket-notice" role="status">{reopenWarning(request.parent.key)}</p>}
        <form className="ticket-form" onSubmit={(event) => void submit(event)}>
          <label>
            Título
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Descrição
            <textarea rows={6} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          {action.error && <p role="alert">{describeError(action.error)}</p>}
          <div className="ticket-actions">
            <button type="submit" className="primary" disabled={trimmed === "" || action.busy}>Criar</button>
            <button type="button" onClick={onCancel}>Cancelar</button>
          </div>
        </form>
      </div>
    </div>
  );
}
