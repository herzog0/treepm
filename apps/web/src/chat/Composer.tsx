import { useId, useMemo } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { personIdsIn, scanPersonLinks } from "@treepm/domain";
import type { Person, TicketSummary } from "../api/client.js";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import type { TicketPool } from "./ChatsContext.js";
import { ComposerEditor } from "./ComposerEditor.js";
import { TestBadge } from "../people/TestBadge.js";
import type { ComposerHandle } from "./ComposerEditor.js";
import { Initials } from "./MessageText.js";

/** Limite da API (`body`, 1 a 4.000) e onde o contador aparece. */
export const CHAT_BODY_MAX = 4000;
const WARN_AT = 3600;

export interface Draft {
  text: string;
  /** Ids das pessoas marcadas no texto (derivados dele): é o que a API recebe em `mentions`. */
  mentions: string[];
}

const NO_PEOPLE: readonly string[] = [];
/** "Alice e Bob": a lista de nomes no idioma da tela. */
const listOf = (language: string, names: readonly string[]): string => new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(names);

const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

/** A thread que a mensagem vai abrir (ADR 0059): quando alguma pessoa marcada não participa da conversa, o campo mostra a thread que vai nascer. */
export interface NewThread {
  /** O ticket citado no Meu chat (`TREEPM-88`): o cabeçalho diz "Nova thread em TREEPM-88". */
  ticketKey: string | null;
  /** Quem vai participar, para os avatares: quem já estava na conversa e quem foi marcado. */
  members: readonly { id: string; name: string }[];
  /** As pessoas de fora marcadas (o "com Carla"). */
  outsiders: readonly { id: string; name: string; isTest?: boolean }[];
  /** Quem já estava na conversa além da própria pessoa ("Alice e Bob entram junto"). */
  joining: readonly { id: string; name: string }[];
}

interface ComposerProps {
  /** Nome acessível do campo: "Mensagem" no chat, "Responder na thread" na thread. */
  label: string;
  placeholder: string;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  /** Quem se pode procurar no `@`: quem não pode ser marcado aqui (não enxerga o projeto do ticket) vem com `blocked`. */
  people: readonly { person: Person; blocked: boolean; reason?: "project" | "levels" }[];
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
  /** A linha acima do botão que diz o que vai acontecer ao enviar (a mensagem vai para o ticket, o assistente lê os tickets citados); `null` quando não há nada a dizer. */
  notice: string | null;
  /** A thread que a mensagem vai abrir, ou `null` quando é uma mensagem comum. */
  newThread: NewThread | null;
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
  /** "Novo ticket": manda o que está escrito como pedido de um ticket novo (só onde o assistente fala e sem pessoas marcadas). */
  onNewTicket?: (draft: Draft) => void;
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
export function Composer({ label, placeholder, draft, onDraft, people, peopleStatus, tickets, projectNames, onNeedTickets, onRetryTickets, names, canAssistant, thread, canOpenThread, notice, newThread, assistantBusy, threadBusy, readOnly, refused, fieldRef, onNewTicket, onSend }: ComposerProps) {
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

  // Uma frase por motivo, cada uma com os seus nomes: sem acesso ao projeto, conversa no último nível e recusa do servidor.
  const refusals = useMemo(() => {
    const reasonOf = (personId: string) => people.find((entry) => entry.person.id === personId && entry.blocked)?.reason;
    const ofKind = (match: (personId: string) => boolean) => draft.mentions.filter(match);
    const noProject = ofKind((personId) => reasonOf(personId) === "project");
    const noLevel = ofKind((personId) => reasonOf(personId) === "levels");
    const other = ofKind((personId) => reasonOf(personId) === undefined && refused.includes(personId));
    return [
      { kind: "Project" as const, ids: noProject },
      { kind: "Levels" as const, ids: noLevel },
      { kind: "Api" as const, ids: other },
    ].filter((group) => group.ids.length > 0);
  }, [people, draft.mentions, refused]);
  const canNewTicket = onNewTicket !== undefined && !mentioning && !readOnly && draft.text.trim() !== "" && !over && !assistantBusy;
  const submit = () => {
    if (canSend) onSend(draft);
  };

  return (
    <form
      className={`chat-composer ${newThread !== null ? "is-new-thread" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* A região existe vazia desde o início e recebe a frase depois: o cabeçalho de baixo é desenho, esta é a leitura dele. */}
      <p className="chat-visually-hidden" role="status">
        {newThread !== null ? t("composer.willOpen", { names: listOf(language, newThread.outsiders.map((person) => person.name)) }) : ""}
      </p>
      {newThread !== null && (
        <div className="chat-newthread-head">
          <svg className="chat-newthread-branch" aria-hidden="true" viewBox="0 0 16 16"><path d="M4 2v7a3 3 0 003 3h6M10 9l3 3-3 3" /></svg>
          <span>{newThread.ticketKey === null ? t("composer.newThread") : t("composer.newThreadIn", { key: newThread.ticketKey })}</span>
          <span className="chat-newthread-avatars" aria-hidden="true">
            {newThread.members.slice(0, 5).map((member) => <Initials key={member.id} name={member.name} />)}
          </span>
          <span>{t("composer.with", { names: listOf(language, newThread.outsiders.map((person) => person.name)) })}</span>
          {newThread.outsiders.filter((person) => person.isTest === true).map((person) => <TestBadge key={person.id} person={person} />)}
          {newThread.joining.length > 0 && <small>{t("composer.joinAlong", { count: newThread.joining.length, names: listOf(language, newThread.joining.map((person) => person.name)) })}</small>}
        </div>
      )}
      {refusals.map((group) => {
        const nameOf = (personId: string) => names.get(personId) ?? scanPersonLinks(draft.text).find((link) => link.id === personId)?.name ?? "";
        return (
          <p key={group.kind} aria-live="polite" className="chat-thread-notice is-refused">
            <span>{t(`composer.refuse${group.kind}${group.ids.length === 1 ? "One" : "Many"}`, { names: listOf(language, group.ids.map(nameOf)) })}</span>
            {group.ids.map((personId) => (
              <button key={personId} type="button" className="chat-text-button" onClick={() => fieldRef.current?.removePerson(personId)}>
                {t("composer.removeMention", { name: nameOf(personId) })}
              </button>
            ))}
          </p>
        );
      })}
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
            outsideIds={newThread === null ? NO_PEOPLE : newThread.outsiders.map((person) => person.id)}
          />
          {draft.text.length >= WARN_AT && (
            <p className={`chat-count ${over ? "is-over" : ""}`}>
              {over ? t("composer.over", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) }) : t("composer.count", { length: formatNumber(language, draft.text.length), max: formatNumber(language, CHAT_BODY_MAX) })}
            </p>
          )}
        </div>
        <div className="chat-composer-actions">
          {onNewTicket !== undefined && !mentioning && (
            <button type="button" className="chat-text-button chat-new-ticket" title={t("creation.newTicketHint")} disabled={!canNewTicket} onClick={() => onNewTicket(draft)}>
              {t("creation.newTicket")}
            </button>
          )}
          {newThread !== null ? (
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
