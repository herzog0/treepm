import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { TicketMark, ticketStateText } from "../map/ticketState.js";
import { AiIcon, IdeaIcon, PlusIcon } from "./icons.js";
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
  /**
   * "Registrar ideia «texto»" (ADR 0042): cria a ideia direto, sem conversa, e abre a página dela. Devolve o texto do erro, ou
   * `null` quando deu certo; com erro a folha continua à vista, com o texto preservado.
   */
  onRegisterIdea: (text: string) => Promise<string | null>;
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
  /** A pergunta sobre o projeto (ADR 0037) também mora na barra: sem folha, à vista ou recolhida ("Pergunta em andamento"). */
  ask: "none" | "expanded" | "collapsed";
  /** A IA está ligada e há projeto visível: a folha de busca oferece "Perguntar ao assistente", também a quem só lê. */
  canAsk: boolean;
  onAsk: (text: string) => void;
  onReopenAsk: () => void;
  onCollapseAsk: () => void;
  /** Cresce quando algo de fora (a "Nova pergunta") pede o foco do campo da barra. */
  focusRequest: number;
  /** A folha da conversa, que fica dentro da barra, embaixo do campo. */
  children?: ReactNode;
}

type Option = { kind: "ticket"; ticket: TicketSummary } | { kind: "create" } | { kind: "idea" } | { kind: "ask" };

/** Barra de pedidos no topo do mapa (ADR 0036, fatia 1): busca de tickets e a ação "Criar ticket". */
export function CommandBar({ tickets, aside, canCreate, pickerActive, onOpenTicket, onCreate, onRegisterIdea, returnFocus, conversation, assistantAvailable, loadResumable, onNewConversation, onResumeConversation, onReopenConversation, onCollapseConversation, ask, canAsk, onAsk, onReopenAsk, onCollapseAsk, focusRequest, children }: CommandBarProps) {
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
  // "Registrar ideia" espera a API: enquanto isso a linha não dispara de novo, e um erro fica na folha.
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const trimmed = text.trim();
  const found = useMemo(() => searchTickets(text, tickets), [text, tickets]);
  const options = useMemo<Option[]>(() => {
    const list: Option[] = found.map((ticket) => ({ kind: "ticket", ticket }));
    if (canCreate && trimmed !== "") list.push({ kind: "create" }, { kind: "idea" });
    if (canAsk && trimmed !== "") list.push({ kind: "ask" });
    return list;
  }, [found, canCreate, canAsk, trimmed]);
  const ideaIndex = found.length + 1;
  const askIndex = found.length + (canCreate ? 2 : 0);
  const sheetOpen = open && trimmed !== "";
  const emptyOpen = open && trimmed === "" && assistantAvailable && canCreate && conversation === "none";
  const emptyOptions = useMemo(() => (resumeTitle === null ? (["new"] as const) : (["resume", "new"] as const)), [resumeTitle]);
  const emptyIndex = Math.min(emptyActive, emptyOptions.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const askRef = useRef(ask);
  askRef.current = ask;
  const folded = conversation === "expanded" || ask === "expanded";
  // "Nova pergunta" encerra a folha: o campo da barra volta e recebe o foco.
  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);
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
      // Com uma folha à vista (a conversa ou a pergunta) o campo da barra está recolhido: o foco vai ao campo de mensagem dela.
      const sheet = conversationRef.current === "expanded" || askRef.current === "expanded" ? ".assistant-sheet:not([hidden])" : null;
      const message = sheet ? (zone.current?.querySelector<HTMLElement>(`${sheet} :is(#assistant-message, #ask-message)`) ?? zone.current?.querySelector<HTMLElement>(`${sheet} .assistant-body`)) : null;
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
    } else if (option.kind === "idea") {
      if (registering) return;
      const idea = trimmed;
      setRegisterError(null);
      setRegistering(true);
      void onRegisterIdea(idea).then(
        (error) => {
          setRegistering(false);
          if (error === null) finish();
          else setRegisterError(error);
        },
        () => setRegistering(false),
      );
    } else if (option.kind === "ask") {
      const question = trimmed;
      finish();
      onAsk(question);
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
        if (ask === "expanded") onCollapseAsk();
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
        // Shift+Enter pergunta ao assistente, de qualquer linha; com o campo vazio não faz nada.
        if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          if (canAsk && trimmed !== "") choose({ kind: "ask" });
          return;
        }
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
      <div className={`command-bar ${sheetOpen || emptyOpen || folded ? "is-open" : ""}`}>
        <div className="command-field" hidden={folded}>
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
              setRegisterError(null);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
          />
          {conversation === "collapsed" && (
            <button type="button" className="command-progress" onClick={onReopenConversation}>{t("conversation.inProgress")}</button>
          )}
          {ask === "collapsed" && (
            <button type="button" className="command-progress" onClick={onReopenAsk}>{t("ask.inProgress")}</button>
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
              {(canCreate || canAsk) && (
                <div role="group" aria-labelledby={`${id}-actions`}>
                  <div id={`${id}-actions`} className="command-heading">{t("sheet.actions")}</div>
                  {canCreate && <div
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
                  </div>}
                  {canCreate && (
                    <div
                      id={optionId(ideaIndex)}
                      role="option"
                      aria-selected={activeIndex === ideaIndex}
                      aria-busy={registering || undefined}
                      className={`command-option ${activeIndex === ideaIndex ? "is-active" : ""}`}
                      onMouseMove={() => setActive(ideaIndex)}
                      onClick={() => choose({ kind: "idea" })}
                    >
                      <span className="command-action-icon"><IdeaIcon /></span>
                      <span className="command-title">{t("action.registerIdea", { text: trimmed })}</span>
                    </div>
                  )}
                  {canAsk && (
                    <div
                      id={optionId(askIndex)}
                      role="option"
                      aria-selected={activeIndex === askIndex}
                      className={`command-option ${activeIndex === askIndex ? "is-active" : ""}`}
                      onMouseMove={() => setActive(askIndex)}
                      onClick={() => choose({ kind: "ask" })}
                    >
                      <span className="command-action-icon"><AiIcon /></span>
                      <span className="command-title">{t("action.ask", { text: trimmed })}</span>
                      <span className="command-hint">{t("action.askShortcut")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {registerError !== null && <p className="command-error" role="alert">{registerError}</p>}
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
