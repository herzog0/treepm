import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Person } from "../api/client.js";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";

/** Limite da API (`body`, 1 a 4.000) e onde o contador aparece. */
export const CHAT_BODY_MAX = 4000;
const WARN_AT = 3600;

export interface Draft {
  text: string;
  /** Ids das pessoas escolhidas no seletor: é o que a API recebe em `mentions`. */
  mentions: string[];
}

const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

interface PickerProps {
  candidates: readonly Person[];
  status: "loading" | "ready" | "error";
  onPick: (person: Person) => void;
  onClose: () => void;
}

/** O seletor de pessoas: só quem enxerga o ticket. `Esc` fecha só ele e devolve o foco ao campo. */
function MentionPicker({ candidates, status, onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const shown = candidates.filter((person) => person.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <div
      role="dialog"
      aria-label={t("picker.label")}
      className="chat-picker"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <input ref={input} type="search" aria-label={t("picker.search")} placeholder={t("picker.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {status === "loading" && <p role="status" className="chat-hint">{t("picker.loading")}</p>}
      {status === "error" && <p role="alert" className="chat-hint">{t("picker.failed")}</p>}
      {status === "ready" && shown.length === 0 && <p className="chat-hint">{t("picker.none")}</p>}
      <ul>
        {shown.map((person) => (
          <li key={person.id}>
            <button type="button" onClick={() => onPick(person)}>{person.displayName}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ComposerProps {
  /** Nome acessível do campo: "Mensagem" no chat, "Responder na thread" na thread. */
  label: string;
  placeholder: string;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  /** Quem pode ser mencionado e como está o carregamento da lista. */
  candidates: readonly Person[];
  peopleStatus: "loading" | "ready" | "error";
  /** Todas as pessoas, para o nome nas pastilhas. */
  names: ReadonlyMap<string, string>;
  /** Falar com o assistente (sem menção) está disponível; sem isso só se envia com menção. Na thread é sempre falso. */
  canAssistant: boolean;
  /** A thread não tem assistente: o botão é sempre "Enviar". */
  thread: boolean;
  /** Marcar alguém abre uma thread aqui dentro; falso no último nível (o seletor fica desligado, com a explicação). */
  canOpenThread: boolean;
  /** Entre o aviso "abre uma thread" e o campo, quando há alguém marcado (o ticket de que a thread trata, no chat geral). */
  extra?: ReactNode;
  /** Há uma mensagem ao assistente esperando a resposta (não impede abrir thread). */
  assistantBusy: boolean;
  /** Há uma mensagem de thread sendo enviada. */
  threadBusy: boolean;
  /** Projeto arquivado: só leitura. */
  readOnly: boolean;
  /** Ids das pessoas que a API recusou. */
  refused: readonly string[];
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (draft: Draft) => void;
}

/** O campo de escrever do chat e da thread: `Enter` envia, `Shift+Enter` quebra a linha, `@` e "Mencionar" abrem o mesmo seletor. */
export function Composer({ label, placeholder, draft, onDraft, candidates, peopleStatus, names, canAssistant, thread, canOpenThread, extra, assistantBusy, threadBusy, readOnly, refused, fieldRef, onSend }: ComposerProps) {
  const { t, i18n } = useTranslation("chat");
  const language = i18n.language as Language;
  const [picking, setPicking] = useState(false);
  const id = useId();
  const mentioning = draft.mentions.length > 0;
  const mentionNames = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(draft.mentions.map((personId) => names.get(personId) ?? personId));
  const offId = `${id}-levels`;
  const over = draft.text.length > CHAT_BODY_MAX;
  const canSend = !readOnly && draft.text.trim() !== "" && !over && (mentioning || thread ? !threadBusy : canAssistant && !assistantBusy);

  const submit = () => {
    if (canSend) onSend(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const at = (event.target.selectionStart ?? value.length) - 1;
    const typedOne = value.length === draft.text.length + 1 && value.slice(0, at) + value.slice(at + 1) === draft.text;
    // O "@" digitado depois de espaço ou no começo abre o seletor, e o "@" não fica no texto.
    if (typedOne && value[at] === "@" && (at === 0 || /\s/.test(value[at - 1]!)) && !readOnly && canOpenThread) {
      onDraft({ ...draft, text: value.slice(0, at) + value.slice(at + 1) });
      setPicking(true);
      return;
    }
    onDraft({ ...draft, text: value });
  };
  const closePicker = () => {
    setPicking(false);
    fieldRef.current?.focus();
  };

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {mentioning && (
        <ul className="chat-pills" aria-label={t("composer.pills")}>
          {draft.mentions.map((personId) => {
            const name = names.get(personId) ?? personId;
            return (
              <li key={personId} className={refused.includes(personId) ? "is-refused" : undefined}>
                <span>{name}</span>
                {refused.includes(personId) && <small>{t("composer.refused")}</small>}
                <button
                  type="button"
                  aria-label={t("composer.removeMention", { name })}
                  onClick={() => {
                    onDraft({ ...draft, mentions: draft.mentions.filter((other) => other !== personId) });
                    fieldRef.current?.focus();
                  }}
                >
                  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {mentioning && (
        <p className="chat-thread-notice" role="status">{t("composer.opensThread", { names: mentionNames })}</p>
      )}
      {mentioning && extra}
      {!canOpenThread && <p id={offId} className="chat-levels-note">{t("composer.noMoreLevels")}</p>}
      <div className="chat-composer-row">
        <div className="chat-composer-field">
          <label className="chat-visually-hidden" htmlFor={`${id}-field`}>{label}</label>
          <textarea
            ref={fieldRef}
            id={`${id}-field`}
            rows={2}
            autoComplete="off"
            placeholder={placeholder}
            value={draft.text}
            readOnly={readOnly}
            aria-invalid={over ? true : undefined}
            onChange={onChange}
            onKeyDown={onKeyDown}
          />
          {draft.text.length >= WARN_AT && (
            <p className={`chat-count ${over ? "is-over" : ""}`}>
              {over ? t("composer.over", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) }) : t("composer.count", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) })}
            </p>
          )}
        </div>
        <div className="chat-composer-actions">
          <div className="chat-picker-anchor">
            <button type="button" className="chat-mention-button" disabled={readOnly || !canOpenThread} aria-describedby={canOpenThread ? undefined : offId} aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking((was) => !was)}>
              {t("composer.mention")}
            </button>
            {picking && canOpenThread && (
              <MentionPicker
                candidates={candidates.filter((person) => !draft.mentions.includes(person.id))}
                status={peopleStatus}
                onPick={(person) => {
                  onDraft({ ...draft, mentions: [...draft.mentions, person.id] });
                  closePicker();
                }}
                onClose={closePicker}
              />
            )}
          </div>
          {mentioning ? (
            <button type="submit" className="chat-send is-thread" disabled={!canSend}>{t("composer.sendThread")}</button>
          ) : (
            <button type="submit" className="chat-send" aria-label={t("composer.send")} disabled={!canSend}>
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
