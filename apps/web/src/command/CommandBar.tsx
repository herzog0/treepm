import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { TicketMark, ticketStateText } from "../map/ticketState.js";
import { AiIcon, PlusIcon } from "./icons.js";
import { searchTickets } from "./search.js";
import "./command.css";

export type CommandAside = "none" | "ticket" | "areas";

export interface CommandBarProps {
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** O que ocupa o lado direito do mapa: a barra se centraliza no que sobra (ADR 0036). */
  aside: CommandAside;
  /** A pessoa pode criar ticket em algum projeto: a ação "Criar ticket" aparece. */
  canCreate: boolean;
  /** Há uma escolha no mapa em andamento: o `Esc` é dela, não da barra. */
  pickerActive: () => boolean;
  onOpenTicket: (ticketId: string) => void;
  onCreate: (text: string) => void;
  /** Devolve o foco ao palco do mapa. */
  returnFocus: () => void;
  /** A conversa de novo ticket mora na barra (ADR 0036): sem conversa, à vista ou recolhida (em andamento). */
  conversation: "none" | "expanded" | "collapsed";
  /** A IA está ligada: com o campo vazio, a folha oferece a conversa. */
  assistantAvailable: boolean;
  /** Título da conversa anterior que "Continuar conversa" retomaria (o rascunho ou o começo da primeira mensagem); `null` quando não há. */
  loadResumable: () => Promise<string | null>;
  onNewConversation: () => void;
  onResumeConversation: () => void;
  onReopenConversation: () => void;
  onCollapseConversation: () => void;
  /** A folha da conversa, que fica dentro da barra, embaixo do campo. */
  children?: ReactNode;
}

type Option = { kind: "ticket"; ticket: TicketSummary } | { kind: "create" };

/** Barra de pedidos no topo do mapa (ADR 0036, fatia 1): busca de tickets e a ação "Criar ticket". */
export function CommandBar({ tickets, aside, canCreate, pickerActive, onOpenTicket, onCreate, returnFocus, conversation, assistantAvailable, loadResumable, onNewConversation, onResumeConversation, onReopenConversation, onCollapseConversation, children }: CommandBarProps) {
  const { t } = useTranslation("command");
  const { t: tMap } = useTranslation("map");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Com o campo vazio e a IA ligada, a folha oferece a conversa; nada vem destacado, para o Enter não começar uma sem querer.
  const [emptyActive, setEmptyActive] = useState(-1);
  const [resumeTitle, setResumeTitle] = useState<string | null>(null);

  const trimmed = text.trim();
  const found = useMemo(() => searchTickets(text, tickets), [text, tickets]);
  const options = useMemo<Option[]>(() => {
    const list: Option[] = found.map((ticket) => ({ kind: "ticket", ticket }));
    if (canCreate && trimmed !== "") list.push({ kind: "create" });
    return list;
  }, [found, canCreate, trimmed]);
  const sheetOpen = open && trimmed !== "";
  const emptyOpen = open && trimmed === "" && assistantAvailable && canCreate && conversation === "none";
  const emptyOptions = useMemo(() => (resumeTitle === null ? (["new"] as const) : (["resume", "new"] as const)), [resumeTitle]);
  const emptyIndex = Math.min(emptyActive, emptyOptions.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // A rolagem da folha da conversa é dela: a roda não chega ao zoom do mapa.
  useEffect(() => {
    const element = zone.current;
    if (!element) return;
    const stop = (event: WheelEvent) => event.stopPropagation();
    element.addEventListener("wheel", stop);
    return () => element.removeEventListener("wheel", stop);
  }, []);

  // A conversa anterior é consultada cada vez que a folha vazia abre: o projeto depende do que está selecionado no mapa.
  const loadRef = useRef(loadResumable);
  loadRef.current = loadResumable;
  useEffect(() => {
    setResumeTitle(null);
    setEmptyActive(-1);
    if (!emptyOpen) return;
    let current = true;
    void loadRef.current().then((title) => {
      if (current) setResumeTitle(title);
    });
    return () => {
      current = false;
    };
  }, [emptyOpen]);

  // Ctrl+K e ⌘K levam o foco à barra de qualquer lugar da tela do mapa. Em fase de captura, porque a página do ticket e os
  // painéis param a propagação das teclas.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      // Com a conversa à vista o campo da barra está recolhido: o foco vai ao campo de mensagem dela.
      const message = conversationRef.current === "expanded" ? (zone.current?.querySelector<HTMLElement>("#assistant-message") ?? zone.current?.querySelector<HTMLElement>(".assistant-body")) : null;
      if (message) {
        message.focus();
        return;
      }
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const finish = () => {
    setText("");
    setOpen(false);
    setActive(0);
    input.current?.blur();
  };
  const chooseConversation = (kind: "resume" | "new") => {
    finish();
    if (kind === "resume") onResumeConversation();
    else onNewConversation();
  };
  const choose = (option: Option) => {
    if (option.kind === "ticket") {
      const ticketId = option.ticket.id;
      finish();
      onOpenTicket(ticketId);
    } else {
      const request = trimmed;
      finish();
      onCreate(request);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Ctrl+K segue para o ouvinte da janela; qualquer outra tecla daqui não chega aos atalhos do mapa.
    if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) return;
    if (event.key === "Escape" && pickerActive()) return;
    event.stopPropagation();
    // As setas e o Enter do campo não valem para o que se digita dentro da folha da conversa.
    const fromField = event.target === input.current;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setText("");
        setOpen(false);
        setActive(0);
        // A folha da conversa se recolhe sem encerrar a conversa (ADR 0036).
        if (conversation === "expanded") onCollapseConversation();
        returnFocus();
        return;
      case "ArrowDown":
      case "ArrowUp": {
        if (!fromField) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (emptyOpen) {
          event.preventDefault();
          setEmptyActive((emptyIndex + step + emptyOptions.length) % emptyOptions.length);
          return;
        }
        if (options.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      case "Enter": {
        if (!fromField || event.repeat || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && canCreate && trimmed !== "") {
          event.preventDefault();
          choose({ kind: "create" });
          return;
        }
        const chosen = emptyOpen && emptyIndex >= 0 ? emptyOptions[emptyIndex] : undefined;
        if (chosen) {
          event.preventDefault();
          chooseConversation(chosen);
          return;
        }
        const option = sheetOpen ? options[activeIndex] : undefined;
        if (option) {
          event.preventDefault();
          choose(option);
        }
        return;
      }
    }
  };

  return (
    <section
      ref={zone}
      className="command-zone"
      data-aside={aside}
      aria-label={t("bar.label")}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={`command-bar ${sheetOpen || emptyOpen || conversation === "expanded" ? "is-open" : ""}`}>
        <div className="command-field" hidden={conversation === "expanded"}>
          <span className="command-icon"><AiIcon /></span>
          <input
            ref={input}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("bar.input")}
            placeholder={t("bar.input")}
            aria-expanded={sheetOpen || emptyOpen}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={sheetOpen && options.length > 0 ? optionId(activeIndex) : emptyOpen && emptyIndex >= 0 ? optionId(emptyIndex) : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
          />
          {conversation === "collapsed" && (
            <button type="button" className="command-progress" onClick={onReopenConversation}>{t("conversation.inProgress")}</button>
          )}
          <kbd>{sheetOpen ? t("bar.escape") : t("bar.shortcut")}</kbd>
        </div>
        {emptyOpen && (
          <div className="command-sheet" onMouseDown={(event) => event.preventDefault()}>
            <div id={`${id}-list`} role="listbox" aria-label={t("sheet.label")}>
              <div role="group" aria-labelledby={`${id}-conversation`}>
                <div id={`${id}-conversation`} className="command-heading">{t("sheet.conversation")}</div>
                {emptyOptions.map((kind, index) => (
                  <div
                    key={kind}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === emptyIndex}
                    className={`command-option ${index === emptyIndex ? "is-active" : ""}`}
                    onMouseMove={() => setEmptyActive(index)}
                    onClick={() => chooseConversation(kind)}
                  >
                    <span className="command-action-icon">{kind === "resume" ? <AiIcon /> : <PlusIcon />}</span>
                    <span className="command-title">
                      {kind === "resume" ? (
                        <>
                          {t("conversation.resume")} <span className="command-resume-title">{resumeTitle}</span>
                        </>
                      ) : (
                        t("conversation.new")
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {sheetOpen && (
          <div className="command-sheet" onMouseDown={(event) => event.preventDefault()}>
            <div id={`${id}-list`} role="listbox" aria-label={t("sheet.label")}>
              {found.length > 0 && (
                <div role="group" aria-labelledby={`${id}-tickets`}>
                  <div id={`${id}-tickets`} className="command-heading">{t("sheet.tickets")}</div>
                  {found.map((ticket, index) => (
                    <div
                      key={ticket.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`command-option ${index === activeIndex ? "is-active" : ""}`}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose({ kind: "ticket", ticket })}
                    >
                      <TicketMark ticket={ticket} />
                      <span className="command-key">{ticket.key}</span>
                      <span className="command-title">{ticket.title}</span>
                      <span className="command-meta">{ticketStateText(tMap, ticket)}</span>
                    </div>
                  ))}
                </div>
              )}
              {canCreate && (
                <div role="group" aria-labelledby={`${id}-actions`}>
                  <div id={`${id}-actions`} className="command-heading">{t("sheet.actions")}</div>
                  <div
                    id={optionId(found.length)}
                    role="option"
                    aria-selected={activeIndex === found.length}
                    className={`command-option ${activeIndex === found.length ? "is-active" : ""}`}
                    onMouseMove={() => setActive(found.length)}
                    onClick={() => choose({ kind: "create" })}
                  >
                    <span className="command-action-icon"><PlusIcon /></span>
                    <span className="command-title">{t("action.create", { text: trimmed })}</span>
                    <span className="command-hint">{t("action.createShortcut")}</span>
                  </div>
                </div>
              )}
            </div>
            {found.length === 0 && <p className="command-empty" role="status">{t("sheet.noTickets")}</p>}
            <div className="command-footer">
              <span>{t("sheet.keys.navigate")}</span>
              <span>{t("sheet.keys.open")}</span>
              <span>{t("sheet.keys.close")}</span>
            </div>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
