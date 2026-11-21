import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { TicketMark, ticketStateText } from "../map/ticketState.js";
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
}

const AiIcon = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
    <path d="M7 2c.5 3.6 1.4 4.5 5 5-3.6.5-4.5 1.4-5 5-.5-3.6-1.4-4.5-5-5 3.6-.5 4.5-1.4 5-5Z" />
    <path d="M12.5 1c.2 1.4.6 1.8 2 2-1.4.2-1.8.6-2 2-.2-1.4-.6-1.8-2-2 1.4-.2 1.8-.6 2-2Z" />
  </svg>
);
const PlusIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M7 2.5v9M2.5 7h9" />
  </svg>
);

type Option = { kind: "ticket"; ticket: TicketSummary } | { kind: "create" };

/** Barra de pedidos no topo do mapa (ADR 0036, fatia 1): busca de tickets e a ação "Criar ticket". */
export function CommandBar({ tickets, aside, canCreate, pickerActive, onOpenTicket, onCreate, returnFocus }: CommandBarProps) {
  const { t } = useTranslation("command");
  const { t: tMap } = useTranslation("map");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const trimmed = text.trim();
  const found = useMemo(() => searchTickets(text, tickets), [text, tickets]);
  const options = useMemo<Option[]>(() => {
    const list: Option[] = found.map((ticket) => ({ kind: "ticket", ticket }));
    if (canCreate && trimmed !== "") list.push({ kind: "create" });
    return list;
  }, [found, canCreate, trimmed]);
  const sheetOpen = open && trimmed !== "";
  const optionId = (index: number) => `${id}-option-${index}`;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  // Ctrl+K e ⌘K levam o foco à barra de qualquer lugar da tela do mapa. Em fase de captura, porque a página do ticket e os
  // painéis param a propagação das teclas.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
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
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setText("");
        setOpen(false);
        setActive(0);
        returnFocus();
        return;
      case "ArrowDown":
      case "ArrowUp": {
        if (options.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      case "Enter": {
        if (event.repeat || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && canCreate && trimmed !== "") {
          event.preventDefault();
          choose({ kind: "create" });
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
      className="command-zone"
      data-aside={aside}
      aria-label={t("bar.label")}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={`command-bar ${sheetOpen ? "is-open" : ""}`}>
        <div className="command-field">
          <span className="command-icon"><AiIcon /></span>
          <input
            ref={input}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("bar.input")}
            placeholder={t("bar.input")}
            aria-expanded={sheetOpen}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={sheetOpen && options.length > 0 ? optionId(activeIndex) : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
          />
          <kbd>{sheetOpen ? t("bar.escape") : t("bar.shortcut")}</kbd>
        </div>
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
      </div>
    </section>
  );
}
