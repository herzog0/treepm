import { useId, useMemo } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { personIdsIn } from "@treepm/domain";
import type { Person, TicketSummary } from "../api/client.js";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import type { TicketPool } from "./ChatsContext.js";
import { ComposerEditor } from "./ComposerEditor.js";
import type { ComposerHandle } from "./ComposerEditor.js";
import { TestBadge } from "../people/TestBadge.js";

/** Limite da API (`body`, 1 a 4.000) e onde o contador aparece. */
export const CHAT_BODY_MAX = 4000;
const WARN_AT = 3600;

export interface Draft {
  text: string;
  /** Ids das pessoas marcadas no texto (derivados dele): é o que a API recebe em `mentions`. */
  mentions: string[];
}

const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

interface ComposerProps {
  /** Nome acessível do campo: "Mensagem" no chat, "Responder na thread" na thread. */
  label: string;
  placeholder: string;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  /** Quem se pode procurar no `@`: quem não pode ser marcado aqui (não enxerga o projeto do ticket) vem com `blocked`. */
  people: readonly { person: Person; blocked: boolean }[];
  peopleStatus: "loading" | "ready" | "error";
  /** Os tickets que a pessoa enxerga, para o `#`; `onNeedTickets` pede que carreguem e `onRetryTickets` tenta de novo. */
  tickets: TicketPool;
  projectNames: ReadonlyMap<string, string>;
  onNeedTickets: () => void;
  onRetryTickets: () => void;
  /** Todas as pessoas, para o nome nas pastilhas. */
  names: ReadonlyMap<string, string>;
  /** Falar com o assistente (sem menção) está disponível; sem isso só se envia com menção. Na thread é sempre falso. */
  canAssistant: boolean;
  /** A thread não tem assistente: o botão é sempre "Enviar". */
  thread: boolean;
  /** Marcar alguém abre uma thread aqui dentro; falso no último nível (o `@` não abre o seletor, e a nota explica). */
  canOpenThread: boolean;
  /** A linha acima do botão que diz o que vai acontecer ao enviar; `null` quando não há nada a dizer. */
  notice: string | null;
  /** Há uma mensagem ao assistente esperando a resposta (não impede abrir thread). */
  assistantBusy: boolean;
  /** Há uma mensagem de thread sendo enviada. */
  threadBusy: boolean;
  /** Projeto arquivado: só leitura. */
  readOnly: boolean;
  /** Ids das pessoas que a API recusou. */
  refused: readonly string[];
  fieldRef: RefObject<ComposerHandle | null>;
  onSend: (draft: Draft) => void;
}

/** Os ancestrais mais próximos do ticket, do mais alto para o mais baixo, e a raiz do caminho (ou o nome do projeto, quando ele é raiz). */
function pathOf(ticket: TicketSummary, byId: ReadonlyMap<string, TicketSummary>, projectName: string, separator: string): string {
  const titles: string[] = [];
  for (let at = ticket.parentId === null ? undefined : byId.get(ticket.parentId); at !== undefined && titles.length < 2; at = at.parentId === null ? undefined : byId.get(at.parentId)) titles.unshift(at.title);
  return titles.length === 0 ? projectName : titles.join(separator);
}

/**
 * O campo de escrever do chat e da thread: `Enter` envia, `Shift+Enter` quebra a linha. `@` abre o seletor de pessoas e `#` o de tickets,
 * colados ao ponto do texto (ADR 0056); a pessoa marcada fica no meio do texto como item indivisível (ADR 0058), e a faixa "vai participar"
 * mostra as mesmas pessoas: o documento é a fonte única.
 */
export function Composer({ label, placeholder, draft, onDraft, people, peopleStatus, tickets, projectNames, onNeedTickets, onRetryTickets, names, canAssistant, thread, canOpenThread, notice, assistantBusy, threadBusy, readOnly, refused, fieldRef, onSend }: ComposerProps) {
  const { t, i18n } = useTranslation("chat");
  const language = i18n.language as Language;
  const id = useId();
  const offId = `${id}-levels`;
  const mentioning = draft.mentions.length > 0;
  const over = draft.text.length > CHAT_BODY_MAX;
  // Quem já estava marcada e não enxerga o projeto do ticket citado depois: a pastilha fica recusada antes do envio, e a mensagem não vai.
  const unseen = useMemo(() => draft.mentions.filter((personId) => people.some((entry) => entry.person.id === personId && entry.blocked)), [draft.mentions, people]);
  const canSend = !readOnly && draft.text.trim() !== "" && !over && unseen.length === 0 && (mentioning || thread ? !threadBusy : canAssistant && !assistantBusy);
  const byId = useMemo(() => new Map(tickets.status === "ready" ? Object.values(tickets.byProject).flat().map((ticket) => [ticket.id, ticket] as const) : []), [tickets]);
  const pathOfTicket = (ticket: TicketSummary) => pathOf(ticket, byId, projectNames.get(ticket.projectId) ?? "", t("picker.pathSeparator"));

  const submit = () => {
    if (canSend) onSend(draft);
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
              <li key={personId} className={refused.includes(personId) || unseen.includes(personId) ? "is-refused" : undefined}>
                <span>{name}<TestBadge person={people.find((entry) => entry.person.id === personId)?.person} /></span>
                {(refused.includes(personId) || unseen.includes(personId)) && <small>{unseen.includes(personId) ? t("picker.noProject") : t("composer.refused")}</small>}
                <button type="button" aria-label={t("composer.removeMention", { name })} onClick={() => fieldRef.current?.removePerson(personId)}>
                  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="chat-thread-notice" role="status" aria-label={t("composer.willLabel")}>{notice ?? ""}</p>
      {!canOpenThread && <p id={offId} className="chat-levels-note">{t("composer.noMoreLevels")}</p>}
      <div className="chat-composer-row">
        <div className="chat-composer-field">
          <ComposerEditor
            ref={fieldRef}
            label={label}
            placeholder={placeholder}
            text={draft.text}
            onText={(text) => onDraft({ text, mentions: personIdsIn(text) })}
            onEnter={submit}
            readOnly={readOnly}
            invalid={over}
            people={people}
            peopleStatus={peopleStatus}
            tickets={tickets}
            pathOf={pathOfTicket}
            onNeedTickets={onNeedTickets}
            onRetryTickets={onRetryTickets}
            canOpenThread={canOpenThread}
          />
          {draft.text.length >= WARN_AT && (
            <p className={`chat-count ${over ? "is-over" : ""}`}>
              {over ? t("composer.over", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) }) : t("composer.count", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) })}
            </p>
          )}
        </div>
        <div className="chat-composer-actions">
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
