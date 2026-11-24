import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { TicketMark, ticketStateText } from "../map/ticketState.js";
import type { EmptyQueueReason, PlayTemplate, PlayTemplateId } from "@treepm/domain";
import { PlayMenu } from "../play/PlayMenu.js";
import { AiIcon, IdeaIcon, PlayIcon, PlusIcon } from "./icons.js";
import { fold, searchTickets } from "./search.js";
import "./command.css";
import "../play/play.css";

export type CommandAside = "none" | "ticket" | "areas";

/** O botão play e a barra do play que mora no lugar do campo (ADR 0048). */
export interface CommandPlay {
  /** O alcance e os modelos de agora, lidos cada vez que o menu abre (as contagens são as de agora). */
  menu: () => { scopeText: string; templates: readonly PlayTemplate[] };
  onStart: (id: PlayTemplateId) => void;
  /** A barra do play enquanto o modo dura: toma o lugar do campo da barra de pedidos. */
  bar: ReactNode | null;
  /** Cresce quando o foco deve voltar ao botão play (a pessoa saiu do modo). */
  focusRequest: number;
  /** Frase de aviso (por exemplo, o play terminou), mostrada junto da barra. */
  notice: string | null;
}

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
  /** "Próximo ticket para trabalhar" (ADR 0047): leva ao primeiro da fila e devolve `null`, ou o motivo de a fila estar vazia. Sem ela, a linha não existe. */
  onNextTicket?: () => EmptyQueueReason | null;
  /** O botão play (ADR 0048). Sem ele, a barra é só a de pedidos. */
  play?: CommandPlay;
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
  /** A IA está ligada: a folha de busca oferece "Conversar no Meu chat" (o texto vira uma thread de assunto, ADR 0056), também a quem só lê. */
  canChat: boolean;
  /** Manda o texto ao Meu chat. Devolve a frase da recusa (já há um assunto esperando a resposta, texto que não vale) e o texto fica no campo; `null` se aceitou. */
  onChat: (text: string) => string | null;
  /** "Abrir o Meu chat": a coluna da conversa abre no chat geral. */
  onOpenChat: () => void;
  /** Cresce quando algo de fora (a "Nova pergunta") pede o foco do campo da barra. */
  focusRequest: number;
  /** A folha da conversa, que fica dentro da barra, embaixo do campo. */
  children?: ReactNode;
}

type Option = { kind: "ticket"; ticket: TicketSummary } | { kind: "chat" } | { kind: "create" } | { kind: "idea" } | { kind: "next" };
type EmptyKind = "chat" | "resume" | "new" | "next";

/** Barra de pedidos no topo do mapa (ADR 0036, fatia 1): busca de tickets e a ação "Criar ticket". */
export function CommandBar({ tickets, aside, canCreate, pickerActive, onOpenTicket, onCreate, onRegisterIdea, onNextTicket, play, returnFocus, conversation, assistantAvailable, loadResumable, onNewConversation, onResumeConversation, onReopenConversation, onCollapseConversation, canChat, onChat, onOpenChat, focusRequest, children }: CommandBarProps) {
  const { t } = useTranslation("command");
  const { t: tMap } = useTranslation("map");
  const { t: tPlay } = useTranslation("play");
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
  const [chatError, setChatError] = useState<string | null>(null);
  // "Próximo ticket para trabalhar" sem nenhum ticket pronto: o motivo fica na folha.
  const [nextReason, setNextReason] = useState<EmptyQueueReason | null>(null);
  // O menu do botão play (ADR 0048): os modelos e o alcance são lidos ao abrir.
  const [menu, setMenu] = useState<ReturnType<CommandPlay["menu"]> | null>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const playing = play?.bar != null;
  const nextAvailable = onNextTicket !== undefined;
  const nextLabel = t("action.next");

  const trimmed = text.trim();
  const found = useMemo(() => searchTickets(text, tickets), [text, tickets]);
  const nextMatches = nextAvailable && trimmed !== "" && fold(nextLabel).includes(fold(trimmed));
  const options = useMemo<Option[]>(() => {
    const list: Option[] = found.map((ticket) => ({ kind: "ticket", ticket }));
    // "Conversar no Meu chat" vem primeiro entre as ações: sem ticket encontrado é ela que o Enter pega.
    if (canChat && trimmed !== "") list.push({ kind: "chat" });
    if (canCreate && trimmed !== "") list.push({ kind: "create" }, { kind: "idea" });
    if (nextMatches) list.push({ kind: "next" });
    return list;
  }, [found, canCreate, canChat, trimmed, nextMatches]);
  const chatIndex = found.length;
  const createIndex = found.length + (canChat ? 1 : 0);
  const ideaIndex = createIndex + 1;
  const nextIndex = found.length + (canChat ? 1 : 0) + (canCreate ? 2 : 0);
  const sheetOpen = open && trimmed !== "" && !playing;
  const conversationAvailable = assistantAvailable && canCreate;
  const emptyOpen = open && trimmed === "" && (canChat || conversationAvailable || nextAvailable) && conversation === "none" && !playing;
  const menuOpen = menu !== null && !playing;
  const emptyOptions = useMemo<readonly EmptyKind[]>(
    () => [...(canChat ? (["chat"] as const) : []), ...(conversationAvailable ? (resumeTitle === null ? (["new"] as const) : (["resume", "new"] as const)) : []), ...(nextAvailable ? (["next"] as const) : [])],
    [resumeTitle, conversationAvailable, nextAvailable, canChat],
  );
  const emptyIndex = Math.min(emptyActive, emptyOptions.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const folded = conversation === "expanded" || playing;
  // Sair do play devolve o foco ao botão que o abriu.
  const playFocus = play?.focusRequest ?? 0;
  useEffect(() => {
    if (playFocus > 0) playButton.current?.focus();
  }, [playFocus]);
  // Começar o play fecha o menu.
  useEffect(() => {
    if (playing) setMenu(null);
  }, [playing]);
  // Um pedido de fora (a barra lateral) leva o foco ao campo da barra.
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
    setNextReason(null);
    if (!emptyOpen || !conversationAvailable) return;
    let current = true;
    void loadRef.current().then((title) => {
      if (current) setResumeTitle(title);
    });
    return () => {
      current = false;
    };
  }, [emptyOpen, conversationAvailable]);

  // Ctrl+K e ⌘K levam o foco à barra de qualquer lugar da tela do mapa. Em fase de captura, porque a página do ticket e os
  // painéis param a propagação das teclas.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      // Com a folha da conversa à vista o campo da barra está recolhido: o foco vai ao campo de mensagem dela.
      const sheet = conversationRef.current === "expanded" ? ".assistant-sheet:not([hidden])" : null;
      const message = sheet ? (zone.current?.querySelector<HTMLElement>(`${sheet} #assistant-message`) ?? zone.current?.querySelector<HTMLElement>(`${sheet} .assistant-body`)) : null;
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
  const chooseNext = () => {
    const reason = onNextTicket?.() ?? null;
    if (reason === null) finish();
    else setNextReason(reason);
  };
  /** Manda o texto ao Meu chat; se a coluna ainda espera outro assunto, o texto fica no campo. */
  const chooseChat = () => {
    const refused = onChat(trimmed);
    if (refused !== null) {
      // Sem frase não há o que dizer (sem a coluna de chats a linha não faz nada).
      setChatError(refused === "" ? null : refused);
      return;
    }
    finish();
  };
  const chooseEmpty = (kind: EmptyKind) => {
    if (kind === "next") {
      chooseNext();
      return;
    }
    if (kind === "chat") {
      finish();
      onOpenChat();
      return;
    }
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
    } else if (option.kind === "next") {
      chooseNext();
    } else if (option.kind === "chat") {
      chooseChat();
    } else {
      const request = trimmed;
      finish();
      onCreate(request);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Ctrl+K segue para o ouvinte da janela; qualquer outra tecla daqui não chega aos atalhos do mapa.
    if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) return;
    // As teclas da barra do play (setas, J, K, Esc) são do mapa, que as trata na janela.
    if (event.target instanceof Element && event.target.closest(".play-bar")) return;
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
        // Shift+Enter manda ao Meu chat, de qualquer linha (com ou sem ticket encontrado); com o campo vazio não faz nada.
        if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          if (canChat && trimmed !== "") chooseChat();
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          // Ctrl/⌘+Enter é "Criar ticket"; quem não pode criar não faz nada (não cai na linha destacada).
          event.preventDefault();
          if (canCreate && trimmed !== "") choose({ kind: "create" });
          return;
        }
        const chosen = emptyOpen && emptyIndex >= 0 ? emptyOptions[emptyIndex] : undefined;
        if (chosen) {
          event.preventDefault();
          chooseEmpty(chosen);
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
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setMenu(null);
        }
      }}
    >
      <div className={`command-bar ${sheetOpen || emptyOpen || folded || menuOpen ? "is-open" : ""}`}>
        {play?.bar}
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
              setChatError(null);
              setNextReason(null);
              setMenu(null);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => {
              setOpen(true);
              setMenu(null);
            }}
          />
          {conversation === "collapsed" && (
            <button type="button" className="command-progress" onClick={onReopenConversation}>{t("conversation.inProgress")}</button>
          )}
          <kbd>{sheetOpen ? t("bar.escape") : t("bar.shortcut")}</kbd>
          {play && (
            <button
              ref={playButton}
              type="button"
              className="command-play"
              aria-label={tPlay("button")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? `${id}-play` : undefined}
              onClick={() => {
                setOpen(false);
                setMenu(menuOpen ? null : play.menu());
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || menuOpen) return;
                event.preventDefault();
                setOpen(false);
                setMenu(play.menu());
              }}
            >
              <PlayIcon />
            </button>
          )}
        </div>
        {play?.notice && !playing && <p className="command-notice" role="status">{play.notice}</p>}
        {menuOpen && play && menu && (
          <div id={`${id}-play`}>
            <PlayMenu
              scopeText={menu.scopeText}
              templates={menu.templates}
              onChoose={(templateId) => {
                setMenu(null);
                play.onStart(templateId);
              }}
              onEscape={() => {
                setMenu(null);
                playButton.current?.focus();
              }}
              onTab={() => setMenu(null)}
            />
          </div>
        )}
        {emptyOpen && (
          <div className="command-sheet" onMouseDown={(event) => event.preventDefault()}>
            <div id={`${id}-list`} role="listbox" aria-label={t("sheet.label")}>
              {emptyOptions.some((kind) => kind !== "next") && (
                <div role="group" aria-labelledby={`${id}-conversation`}>
                  <div id={`${id}-conversation`} className="command-heading">{t("sheet.conversation")}</div>
                  {emptyOptions.map((kind, index) =>
                    kind === "next" ? null : (
                      <div
                        key={kind}
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === emptyIndex}
                        className={`command-option ${index === emptyIndex ? "is-active" : ""}`}
                        onMouseMove={() => setEmptyActive(index)}
                        onClick={() => chooseEmpty(kind)}
                      >
                        <span className="command-action-icon">{kind === "resume" || kind === "chat" ? <AiIcon /> : <PlusIcon />}</span>
                        <span className="command-title">
                          {kind === "chat" ? (
                            t("conversation.openChat")
                          ) : kind === "resume" ? (
                            <>
                              {t("conversation.resume")} <span className="command-resume-title">{resumeTitle}</span>
                            </>
                          ) : (
                            t("conversation.new")
                          )}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              )}
              {nextAvailable && (
                <div role="group" aria-labelledby={`${id}-empty-actions`}>
                  <div id={`${id}-empty-actions`} className="command-heading">{t("sheet.actions")}</div>
                  <div
                    id={optionId(emptyOptions.indexOf("next"))}
                    role="option"
                    aria-selected={emptyOptions.indexOf("next") === emptyIndex}
                    className={`command-option ${emptyOptions.indexOf("next") === emptyIndex ? "is-active" : ""}`}
                    onMouseMove={() => setEmptyActive(emptyOptions.indexOf("next"))}
                    onClick={() => chooseNext()}
                  >
                    <span className="command-action-icon"><PlayIcon /></span>
                    <span className="command-title">{nextLabel}</span>
                  </div>
                </div>
              )}
            </div>
            {nextReason !== null && <p className="command-error" role="status">{t(`next.${nextReason}`)}</p>}
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
              {(canCreate || canChat || nextMatches) && (
                <div role="group" aria-labelledby={`${id}-actions`}>
                  <div id={`${id}-actions`} className="command-heading">{t("sheet.actions")}</div>
                  {canChat && (
                    <div
                      id={optionId(chatIndex)}
                      role="option"
                      aria-selected={activeIndex === chatIndex}
                      className={`command-option ${activeIndex === chatIndex ? "is-active" : ""}`}
                      onMouseMove={() => setActive(chatIndex)}
                      onClick={() => choose({ kind: "chat" })}
                    >
                      <span className="command-action-icon"><AiIcon /></span>
                      <span className="command-title">{t("action.chat")}</span>
                      <span className="command-hint">{t("action.chatShortcut")}</span>
                    </div>
                  )}
                  {canCreate && <div
                    id={optionId(createIndex)}
                    role="option"
                    aria-selected={activeIndex === createIndex}
                    className={`command-option ${activeIndex === createIndex ? "is-active" : ""}`}
                    onMouseMove={() => setActive(createIndex)}
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
                  {nextMatches && (
                    <div
                      id={optionId(nextIndex)}
                      role="option"
                      aria-selected={activeIndex === nextIndex}
                      className={`command-option ${activeIndex === nextIndex ? "is-active" : ""}`}
                      onMouseMove={() => setActive(nextIndex)}
                      onClick={() => choose({ kind: "next" })}
                    >
                      <span className="command-action-icon"><PlayIcon /></span>
                      <span className="command-title">{nextLabel}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {registerError !== null && <p className="command-error" role="alert">{registerError}</p>}
            {chatError !== null && <p className="command-error" role="alert">{chatError}</p>}
            {nextReason !== null && <p className="command-error" role="status">{t(`next.${nextReason}`)}</p>}
            {found.length === 0 && <p className="command-empty" role="status">{t("sheet.noTickets")}</p>}
            <div className="command-footer">
              <span>{t("sheet.keys.navigate")}</span>
              <span>{options[activeIndex]?.kind === "chat" ? t("sheet.keys.chat") : t("sheet.keys.open")}</span>
              <span>{t("sheet.keys.close")}</span>
            </div>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
