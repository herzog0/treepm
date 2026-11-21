import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, ApiError, GroupSummary as SummaryData } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate, formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { cancelOnEscape } from "./fields.js";

/** Limite da API para o texto (ADR 0033). */
export const SUMMARY_MAX = 1000;

const describeSummaryError = (error: ApiError, describeError: (error: ApiError) => string, t: TFunction<"ticket">, language: Language) =>
  error.code === "validation_error" ? t("summary.invalid", { max: formatNumber(language, SUMMARY_MAX) }) : describeError(error);

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
  const { t, i18n } = useTranslation("ticket");
  const language = i18n.language as Language;
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
        <h2 id="ticket-summary-heading">{t("summary.heading")}</h2>
        {canEdit && !editing && (
          <span className="ticket-section-actions">
            <button ref={startButton} type="button" className="text" disabled={busy} onClick={start}>
              {summary ? t("summary.edit") : t("summary.write")}
            </button>
            <ConfirmAction label={t("summary.refresh")} disabled={busy} message={t("summary.refreshConfirm")} onConfirm={() => void update()} />
          </span>
        )}
      </div>
      <p className="ticket-muted">{t("summary.hint")}</p>
      {editing ? (
        <div className="ticket-edit" onKeyDown={cancelOnEscape(cancel)}>
          <textarea aria-label={t("summary.heading")} rows={6} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
          <p className={`ticket-summary-count ${draft.length > SUMMARY_MAX ? "is-over" : ""}`}>{t("summary.counter", { length: draft.length, max: formatNumber(language, SUMMARY_MAX) })}</p>
          <div className="ticket-actions">
            <button type="button" className="primary" disabled={!canSave} onClick={() => void submit()}>{t("common.save")}</button>
            <button type="button" onClick={cancel}>{t("common.cancel")}</button>
          </div>
        </div>
      ) : summary ? (
        <>
          <p className="ticket-description">{summary.text}</p>
          <p className="ticket-summary-meta">
            {t(summary.source === "assistant" ? "summary.writtenByAssistant" : "summary.editedByPerson", { date: formatDate(language, summary.updatedAt) })}
          </p>
        </>
      ) : (
        <p className="ticket-muted">{t("summary.empty")}</p>
      )}
      {regenerate.busy && <p role="status" className="ticket-muted">{t("summary.writing")}</p>}
      {error && <p role="alert" className="ticket-error">{describeSummaryError(error, describeError, t, language)}</p>}
    </section>
  );
}
