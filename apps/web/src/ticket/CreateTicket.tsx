import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { FormEvent } from "react";
import type { ApiClient, CreateTicketBody, Project } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { RichDescription } from "./description/RichDescription.js";
import { useState } from "react";
import { reopenWarningText, reopensOnReceiving } from "./reopen.js";
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
  const { t } = useTranslation("ticket");
  const describeError = useDescribeApiError();
  const [title, setTitle] = useState(request.draft?.title ?? "");
  const [description, setDescription] = useState(request.draft?.description ?? "");
  const action = useAction();
  // Para as menções e o "@" da descrição; se a lista não chega, a chave fica como texto.
  const list = useApiResource(() => safe(() => client.listTickets(request.projectId)));
  const tickets = list.state.status === "ready" ? list.state.data : null;
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
        <h1 ref={heading} className="ticket-title">{t("create.heading")}</h1>
        <p className="ticket-muted">{project ? t(isChild ? "create.inside" : "create.atRoot", { project: project.name }) : ""}</p>
        {request.parent && reopensOnReceiving(request.parent) && <p className="ticket-notice" role="status">{reopenWarningText(t, request.parent.key)}</p>}
        <form className="ticket-form" onSubmit={(event) => void submit(event)}>
          <label>
            {t("create.title")}
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="ticket-form-field">
            <span id="create-description-label">{t("create.description")}</span>
            <RichDescription
              className="is-field"
              value={request.draft?.description ?? ""}
              editing
              canEdit
              label={t("create.description")}
              placeholder=""
              mentions={tickets ? { projectId: request.projectId, tickets } : undefined}
              onChange={setDescription}
            />
          </div>
          {action.error && <p role="alert">{describeError(action.error)}</p>}
          <div className="ticket-actions">
            <button type="submit" className="primary" disabled={trimmed === "" || action.busy}>{t("create.submit")}</button>
            <button type="button" onClick={onCancel}>{t("create.cancel")}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
