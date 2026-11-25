import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityComment, ActivityEntry, ApiClient, ApiError } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { formatActivityTime, formatDateTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { useAction } from "../panel/useAction.js";
import { RichDescription } from "./description/RichDescription.js";
import type { MentionContext } from "./description/decorations.js";
import { useCommentPeople } from "./commentPeople.js";
import { initials } from "./fields.js";

export const ActionError = ({ error }: { error: ApiError | null }) => {
  const describeError = useDescribeApiError();
  return error ? <p role="alert" className="ticket-error">{describeError(error)}</p> : null;
};

export function Avatar({ person }: { person: { displayName: string; avatarUrl: string | null } | null }) {
  const [broken, setBroken] = useState(false);
  if (person === null) return <span aria-hidden="true" className="ticket-avatar is-system" />;
  return (
    <span aria-hidden="true" className="ticket-avatar">
      {person.avatarUrl !== null && !broken ? <img src={person.avatarUrl} alt="" onError={() => setBroken(true)} /> : initials(person.displayName)}
    </span>
  );
}

/**
 * Um comentário da lista (ADR 0040, fatia 2), na seção "Atividade" e na conversa de uma área (ADR 0041, fatia 2): o corpo é
 * lido pelo mesmo componente da descrição, só para leitura. `onOpenArea` liga a etiqueta de área (só na Atividade); sem ele
 * a etiqueta não aparece.
 */
/** A etiqueta "pelo MCP" (ADR 0043): o que um agente fez nunca se confunde com o que a pessoa fez à mão. */
export function ViaMcp({ via }: { via: ActivityEntry["via"] | "linear" }) {
  const { t } = useTranslation("ticket");
  if (via === "linear") return <span className="ticket-via" title={t("activity.viaLinearTitle")}>{t("activity.viaLinear")}</span>;
  return via === "mcp" ? <span className="ticket-via" title={t("activity.viaTitle")}>{t("activity.via")}</span> : null;
}

export function CommentItem({ client, entry, mentions, language, now, onChange, onOpenArea }: { client: ApiClient; entry: ActivityComment; mentions: MentionContext; language: Language; now: Date; onChange: (entry: ActivityComment) => void; onOpenArea?: (contributionId: string) => void }) {
  const { t } = useTranslation("ticket");
  const people = useCommentPeople();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.body ?? "");
  // Autor do Linear que não é pessoa do TreePM (ADR 0061): o nome de lá, em texto, sem avatar de pessoa.
  const external = entry.actor === null ? entry.externalAuthor : undefined;
  const name = entry.actor?.displayName ?? (external ? (external.name !== null ? t("activity.comment.linearAuthor", { name: external.name }) : t("activity.comment.linearAuthorUnknown")) : t("people.removed"));
  const text = draft.trim();
  const canSave = !action.busy && text !== "" && text !== (entry.body ?? "").trim();
  const area = onOpenArea ? entry.area : null;

  const startEditing = () => {
    action.clear();
    setDraft(entry.body ?? "");
    setEditing(true);
  };
  const cancel = () => {
    action.clear();
    setEditing(false);
  };
  const save = async () => {
    if (!canSave) return;
    const result = await action.run(() => client.updateComment(entry.id, { body: text }));
    if (!result.ok) return;
    setEditing(false);
    onChange(result.data);
  };
  const remove = async () => {
    const result = await action.run(() => client.removeComment(entry.id));
    if (result.ok) onChange({ ...entry, body: null, removed: true, canEdit: false, canRemove: false });
  };

  return (
    <li className={`ticket-activity-item ticket-activity-comment${entry.removed ? " is-removed" : ""}`}>
      <Avatar person={entry.actor} />
      <div className="ticket-comment-main">
        <div className="ticket-comment-head">
          <span className="ticket-comment-author">{name}</span>
          <ViaMcp via={entry.via} />
          {area &&
            (area.id !== null ? (
              <button type="button" className="ticket-comment-area" aria-label={t("activity.comment.openArea", { area: area.name })} onClick={() => onOpenArea?.(area.id as string)}>{area.name}</button>
            ) : (
              <span className="ticket-comment-area is-gone" title={t("activity.comment.areaGone")}>{area.name}</span>
            ))}
          <time className="ticket-activity-time" dateTime={entry.occurredAt} title={formatDateTime(language, entry.occurredAt)}>
            {formatActivityTime(language, entry.occurredAt, now)}
          </time>
          {entry.editedAt !== null && !entry.removed && <span className="ticket-comment-edited">{t("activity.comment.edited")}</span>}
        </div>
        {entry.removed || entry.body === null ? (
          <p className="ticket-comment-gone">{t("activity.comment.removed")}</p>
        ) : editing ? (
          <div className="ticket-comment-edit">
            <RichDescription
              className="is-field"
              value={entry.body}
              editing
              canEdit
              autoFocus
              label={t("activity.comment.editField")}
              placeholder=""
              mentions={mentions}
              {...(people ? { people } : {})}
              onChange={setDraft}
              onSubmit={() => void save()}
              onCancel={cancel}
            />
            <div className="ticket-actions">
              <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>{t("activity.comment.save")}</button>
              <button type="button" onClick={cancel}>{t("activity.comment.cancel")}</button>
            </div>
          </div>
        ) : (
          <RichDescription value={entry.body} editing={false} canEdit={false} label={t("activity.comment.by", { name })} placeholder="" mentions={mentions} {...(people ? { people } : {})} {...(mentions.onOpen ? { onOpenMention: mentions.onOpen } : {})} />
        )}
        {!entry.removed && !editing && (entry.canEdit || entry.canRemove) && (
          <div className="ticket-comment-actions">
            {entry.canEdit && <button type="button" className="text" onClick={startEditing}>{t("activity.comment.edit")}</button>}
            {entry.canRemove && <ConfirmAction label={t("activity.comment.remove")} message={t("activity.comment.removeWarning")} disabled={action.busy} onConfirm={() => void remove()} />}
          </div>
        )}
        <ActionError error={action.error} />
      </div>
    </li>
  );
}

/**
 * Campo de escrever: o mesmo editor da descrição, sem o pedido ao assistente. Só envia pelo botão ou por Ctrl/Cmd+Enter
 * (Enter quebra linha); o rascunho não é guardado em lugar nenhum e se perde ao sair da página. Com `contribution`, o
 * comentário é daquela área (ADR 0041); sem ele, do ticket.
 */
export function CommentComposer({ client, ticketId, contribution, mentions, onAdded }: { client: ApiClient; ticketId: string; contribution?: { id: string; name: string }; mentions: MentionContext; onAdded: (entry: ActivityComment) => void }) {
  const { t } = useTranslation("ticket");
  const people = useCommentPeople();
  const action = useAction();
  const [draft, setDraft] = useState("");
  // Depois de enviar, o campo recomeça vazio (e com o foco, para seguir escrevendo).
  const [revision, setRevision] = useState(0);
  const sending = useRef(false);
  const text = draft.trim();

  const send = async () => {
    if (text === "" || sending.current) return;
    sending.current = true;
    const result = await action.run(() => client.createTicketComment(ticketId, contribution ? { body: text, contributionId: contribution.id } : { body: text }));
    sending.current = false;
    if (!result.ok) return;
    onAdded(result.data);
    setDraft("");
    setRevision((n) => n + 1);
  };

  return (
    <div className="ticket-comment-composer">
      <RichDescription
        key={revision}
        className="is-field"
        value=""
        editing
        canEdit
        autoFocus={revision > 0}
        label={contribution ? t("contributions.conversation.field", { area: contribution.name }) : t("activity.comment.field")}
        placeholder={t("activity.comment.placeholder")}
        mentions={mentions}
        {...(people ? { people } : {})}
        onChange={setDraft}
        onSubmit={() => void send()}
        onCancel={() => (document.activeElement as HTMLElement | null)?.blur()}
      />
      <div className="ticket-comment-composer-actions">
        <button type="button" className="primary" disabled={text === "" || action.busy} onClick={() => void send()}>
          {action.busy ? t("activity.comment.sending") : t("activity.comment.send")}
        </button>
        <span className="ticket-comment-hint">{t("activity.comment.hint")}</span>
      </div>
      <ActionError error={action.error} />
    </div>
  );
}
