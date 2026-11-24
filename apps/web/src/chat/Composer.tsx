import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Person, TicketSummary } from "../api/client.js";
import { MAX_RESULTS, searchTickets } from "../command/search.js";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ticketStateText } from "../map/ticketState.js";
import { caretPoint } from "./caret.js";
import type { CaretPoint } from "./caret.js";
import type { TicketPool } from "./ChatsContext.js";
import { MentionList } from "./MentionList.js";
import type { PopupOption } from "./MentionList.js";
import { liveTrigger, typedTrigger, withoutToken, withTicketKey } from "./mentions.js";
import type { LiveTrigger, Selection, Trigger } from "./mentions.js";
import { situationColor } from "./situation.js";
import { Initials } from "./MessageText.js";
import { TestBadge } from "../people/TestBadge.js";

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
  fieldRef: RefObject<HTMLTextAreaElement | null>;
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
 * colados ao ponto do texto (ADR 0056): o que se digita depois filtra, setas escolhem, `Enter` ou `Tab` confirmam, `Esc` fecha e deixa o texto.
 */
export function Composer({ label, placeholder, draft, onDraft, people, peopleStatus, tickets, projectNames, onNeedTickets, onRetryTickets, names, canAssistant, thread, canOpenThread, notice, assistantBusy, threadBusy, readOnly, refused, fieldRef, onSend }: ComposerProps) {
  const { t, i18n } = useTranslation("chat");
  const { t: tMap } = useTranslation("map");
  const language = i18n.language as Language;
  const id = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [caret, setCaret] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [where, setWhere] = useState<{ point: CaretPoint; box: DOMRect } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  /** O que estava selecionado antes da próxima digitação: um `@` digitado sobre a seleção a substitui e abre a lista. */
  const selection = useRef<Selection>({ start: 0, end: 0 });
  const mentioning = draft.mentions.length > 0;
  const offId = `${id}-levels`;
  const listId = `${id}-list`;
  const optionId = (key: string) => `${id}-option-${key}`;
  const over = draft.text.length > CHAT_BODY_MAX;
  // Quem já estava marcada e não enxerga o projeto do ticket citado depois: a pastilha fica recusada antes do envio, e a mensagem não vai.
  const unseen = useMemo(() => draft.mentions.filter((personId) => people.some((entry) => entry.person.id === personId && entry.blocked)), [draft.mentions, people]);
  const canSend = !readOnly && draft.text.trim() !== "" && !over && unseen.length === 0 && (mentioning || thread ? !threadBusy : canAssistant && !assistantBusy);

  const live: LiveTrigger | null = liveTrigger(trigger, draft.text, caret);
  const open = live !== null && !readOnly && (live.char === "#" || canOpenThread);
  const kind = open ? live.char : null;
  useEffect(() => {
    if (trigger !== null && live === null) setTrigger(null);
  }, [trigger, live]);
  useEffect(() => {
    if (kind === "#") onNeedTickets();
  }, [kind, onNeedTickets]);

  // As opções da lista aberta.
  const query = live?.query ?? "";
  const peopleList = useMemo(() => {
    const wanted = query.trim().toLocaleLowerCase();
    return people.filter(({ person }) => !draft.mentions.includes(person.id) && person.displayName.toLocaleLowerCase().includes(wanted));
  }, [people, draft.mentions, query]);
  // Sem nada digitado, os primeiros da lista (como o "@" da descrição do ticket); com texto, a busca da barra de pedidos.
  const ticketList = useMemo(() => {
    if (tickets.status !== "ready") return [];
    return query.trim() === "" ? Object.values(tickets.byProject).flat().slice(0, MAX_RESULTS) : searchTickets(query, tickets.byProject);
  }, [tickets, query]);
  const byId = useMemo(() => new Map(tickets.status === "ready" ? Object.values(tickets.byProject).flat().map((ticket) => [ticket.id, ticket] as const) : []), [tickets]);
  const options: PopupOption[] = useMemo(() => {
    if (kind === "@") {
      return peopleList.map(({ person, blocked }) => ({
        key: person.id,
        disabled: blocked,
        content: (
          <>
            <Initials name={person.displayName} />
            <span className="chat-option-text">
              <span className="chat-option-title">{person.displayName}<TestBadge person={person} /></span>
              {blocked && <span className="chat-option-sub">{t("picker.noProject")}</span>}
            </span>
          </>
        ),
      }));
    }
    if (kind === "#") {
      return ticketList.map((ticket) => ({
        key: ticket.id,
        disabled: false,
        content: (
          <>
            <span className="chat-situation-dot" aria-hidden="true" style={{ background: situationColor(ticket) }} />
            <span className="chat-option-text">
              <span className="chat-option-title"><code>{ticket.key}</code> {ticket.title}</span>
              <span className="chat-option-sub">{t("picker.sub", { path: pathOf(ticket, byId, projectNames.get(ticket.projectId) ?? "", t("picker.pathSeparator")), state: ticketStateText(tMap, ticket) })}</span>
            </span>
          </>
        ),
      }));
    }
    return [];
  }, [kind, peopleList, ticketList, byId, projectNames, t, tMap]);
  // As setas passam também pelas opções apagadas (o leitor de tela precisa ouvir o motivo); só `Enter` e `Tab` nelas não confirmam.
  const activeKey = options.some((option) => option.key === chosen) ? chosen : (options.find((option) => !option.disabled)?.key ?? options[0]?.key ?? null);
  const activeOption = options.find((option) => option.key === activeKey);

  // Onde a lista fica: junto do `@` ou `#` no texto, e acompanha o campo quando a janela muda.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!open || field === null) return setWhere(null);
    const place = () => setWhere({ point: caretPoint(field, live.start), box: field.getBoundingClientRect() });
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, live?.start, draft.text, fieldRef]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const to = pendingCaret.current;
    pendingCaret.current = null;
    fieldRef.current?.setSelectionRange(to, to);
    setCaret(to);
  }, [draft.text, fieldRef]);

  const submit = () => {
    if (canSend) onSend(draft);
  };
  const pick = (key: string) => {
    if (live === null) return;
    if (live.char === "@") {
      const person = people.find((entry) => entry.person.id === key && !entry.blocked);
      if (person === undefined) return;
      const next = withoutToken(draft.text, live);
      pendingCaret.current = next.caret;
      onDraft({ text: next.text, mentions: [...draft.mentions, person.person.id] });
    } else {
      const ticket = ticketList.find((entry) => entry.id === key);
      if (ticket === undefined) return;
      const next = withTicketKey(draft.text, live, ticket.key);
      pendingCaret.current = next.caret;
      onDraft({ ...draft, text: next.text });
    }
    setTrigger(null);
    setChosen(null);
    fieldRef.current?.focus();
  };
  const move = (step: 1 | -1) => {
    if (options.length === 0) return;
    const at = options.findIndex((option) => option.key === activeKey);
    setChosen(options[(at + step + options.length) % options.length]!.key);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTrigger(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        // Com a lista aberta, `Enter` nunca envia: confirma a opção, ou (sem opção que se possa escolher) só fecha a lista.
        event.preventDefault();
        if (activeKey !== null && activeOption?.disabled !== true) pick(activeKey);
        else if (activeOption === undefined) setTrigger(null);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && activeKey !== null && activeOption?.disabled !== true) {
        event.preventDefault();
        pick(activeKey);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  };
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const at = event.target.selectionStart ?? value.length;
    const typed = typedTrigger(draft.text, value, at, selection.current);
    setCaret(at);
    if (typed !== null) {
      setTrigger(typed);
      setChosen(null);
    }
    onDraft({ ...draft, text: value });
  };
  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
    setCaret(event.currentTarget.selectionStart ?? 0);
  };

  const picking = open && where !== null;
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
      <p className="chat-thread-notice" role="status" aria-label={t("composer.willLabel")}>{notice ?? ""}</p>
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
            // O papel não muda no meio da digitação: o campo é sempre uma caixa de combinação, aberta ou fechada.
            role="combobox"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-expanded={picking}
            {...(picking ? { "aria-controls": listId, ...(activeKey !== null ? { "aria-activedescendant": optionId(activeKey) } : {}) } : {})}
            onChange={onChange}
            onBlur={() => setTrigger(null)}
            onSelect={onSelect}
            onKeyDown={onKeyDown}
          />
          {picking && kind !== null && live !== null && (
            <MentionList
              label={kind === "@" ? t("picker.people") : t("picker.tickets")}
              typed={`${live.char}${live.query}`}
              listId={listId}
              optionId={optionId}
              options={options}
              activeKey={activeKey}
              box={where.box}
              point={where.point}
              hint={kind === "@" ? t("picker.hintPeople") : t("picker.hintTickets")}
              onPick={pick}
              message={
                kind === "@" ? (
                  <>
                    {peopleStatus === "loading" && <p role="status" className="chat-hint">{t("picker.loading")}</p>}
                    {peopleStatus === "error" && <p role="alert" className="chat-hint">{t("picker.failed")}</p>}
                    {peopleStatus === "ready" && options.length === 0 && <p className="chat-hint">{t("picker.none")}</p>}
                  </>
                ) : (
                  <>
                    {(tickets.status === "idle" || tickets.status === "loading") && <p role="status" className="chat-hint">{t("picker.loadingTickets")}</p>}
                    {tickets.status === "error" && (
                      <div className="chat-hint">
                        <p role="alert">{t("picker.failedTickets")}</p>
                        <button type="button" className="chat-text-button" onClick={onRetryTickets}>{t("picker.retry")}</button>
                      </div>
                    )}
                    {tickets.status === "ready" && options.length === 0 && <p className="chat-hint">{t("picker.noneTickets")}</p>}
                  </>
                )
              }
            />
          )}
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
