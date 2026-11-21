import { useEffect, useRef, useState } from "react";
import type { ApiClient, ApiError, GroupSummary as SummaryData } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate } from "../github/time.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { cancelOnEscape } from "./fields.js";

/** Limite da API para o texto (ADR 0033). */
export const SUMMARY_MAX = 1000;

const describeSummaryError = (error: ApiError, describeError: (error: ApiError) => string) =>
  error.code === "validation_error" ? `O texto precisa ter entre 1 e ${SUMMARY_MAX.toLocaleString("pt-BR")} caracteres.` : describeError(error);

interface ItemsSummaryProps {
  client: ApiClient;
  ticketId: string;
  /** Quem pode editar o ticket, em projeto não arquivado. */
  canEdit: boolean;
}

/**
 * Seção "O que entra aqui" da página do ticket com filhos (ADR 0033, ADR 0034): o texto guardado que a IA usa para decidir se
 * um ticket novo pertence a ele. O pai só a monta com a IA ligada e com filhos; se a leitura falhar, ela não aparece.
 */
export function ItemsSummary({ client, ticketId, canEdit }: ItemsSummaryProps) {
  const describeError = useDescribeApiError();
  const loaded = useApiResource(() => safe(() => client.getTicketSummary(ticketId)));
  const [written, setWritten] = useState<SummaryData["summary"] | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useAction();
  const regenerate = useAction();
  const startButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const busy = save.busy || regenerate.busy;

  // Ao sair da edição o foco volta ao botão que a abriu.
  useEffect(() => {
    if (wasEditing.current && !editing) startButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (loaded.state.status !== "ready") return null;
  const summary = written !== undefined ? written : loaded.state.data.summary;

  const start = () => {
    save.clear();
    regenerate.clear();
    setDraft(summary?.text ?? "");
    setEditing(true);
  };
  const cancel = () => {
    save.clear();
    setEditing(false);
  };
  const canSave = !busy && draft.trim() !== "" && draft.length <= SUMMARY_MAX;
  const submit = async () => {
    if (!canSave) return;
    regenerate.clear();
    const result = await save.run(() => client.putTicketSummary(ticketId, { text: draft.trim() }));
    if (!result.ok) return;
    setWritten(result.data.summary);
    setEditing(false);
  };
  const update = async () => {
    save.clear();
    const result = await regenerate.run(() => client.regenerateTicketSummary(ticketId));
    if (result.ok) setWritten(result.data.summary);
  };
  const error = save.error ?? regenerate.error;

  return (
    <section className="ticket-section" aria-labelledby="ticket-summary-heading">
      <div className="ticket-section-head ticket-summary-head">
        <h2 id="ticket-summary-heading">O que entra aqui</h2>
        {canEdit && !editing && (
          <span className="ticket-section-actions">
            <button ref={startButton} type="button" className="text" disabled={busy} onClick={start}>
              {summary ? "Editar" : "Escrever"}
            </button>
            <ConfirmAction label="Atualizar pela IA" disabled={busy} message="O texto atual será substituído por um novo, escrito a partir dos itens de agora." onConfirm={() => void update()} />
          </span>
        )}
      </div>
      <p className="ticket-muted">A IA usa este texto para decidir se um ticket novo pertence a este ticket.</p>
      {editing ? (
        <div className="ticket-edit" onKeyDown={cancelOnEscape(cancel)}>
          <textarea aria-label="O que entra aqui" rows={6} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
          <p className={`ticket-summary-count ${draft.length > SUMMARY_MAX ? "is-over" : ""}`}>{draft.length} de 1.000 caracteres</p>
          <div className="ticket-actions">
            <button type="button" className="primary" disabled={!canSave} onClick={() => void submit()}>Salvar</button>
            <button type="button" onClick={cancel}>Cancelar</button>
          </div>
        </div>
      ) : summary ? (
        <>
          <p className="ticket-description">{summary.text}</p>
          <p className="ticket-summary-meta">
            {summary.source === "assistant" ? "Escrito pela IA" : "Editado por uma pessoa"} em {formatDate(summary.updatedAt)}
          </p>
        </>
      ) : (
        <p className="ticket-muted">Ainda sem texto. A IA escreve um na primeira procura que passar por aqui, ou você pode escrever agora.</p>
      )}
      {regenerate.busy && <p role="status" className="ticket-muted">Escrevendo…</p>}
      {error && <p role="alert" className="ticket-error">{describeSummaryError(error, describeError)}</p>}
    </section>
  );
}
