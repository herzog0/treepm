import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

/** Fecha ao clicar fora do elemento enquanto `open`. */
function useOutsideClick(open: boolean, ref: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, ref, close]);
}

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  mark?: ReactNode;
}

interface OptionMenuProps<T extends string> {
  /** Nome acessível do menu. */
  label: string;
  /** Conteúdo do botão que abre o menu (o valor atual). */
  trigger: ReactNode;
  options: readonly MenuOption<T>[];
  value: T;
  onChoose: (value: T) => void;
  disabled?: boolean;
}

/**
 * Menu de escolha única, aberto por um botão. Teclado: Enter, espaço ou seta para baixo abrem no valor atual; as setas
 * (com Home e End) navegam; Enter escolhe; Esc fecha e devolve o foco ao botão, sem fechar a página.
 */
export function OptionMenu<T extends string>({ label, trigger, options, value, onChoose, disabled = false }: OptionMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const close = () => setOpen(false);
  useOutsideClick(open, root, close);

  // O foco vai ao item atual só quando o menu abre, não a cada renderização.
  const currentIndex = useRef(0);
  currentIndex.current = Math.max(options.findIndex((option) => option.value === value), 0);
  useEffect(() => {
    if (open) items.current[currentIndex.current]?.focus();
  }, [open]);

  const move = (to: number) => items.current[(to + options.length) % options.length]?.focus();
  const onMenuKeyDown = (event: KeyboardEvent) => {
    const at = items.current.findIndex((item) => item === document.activeElement);
    const handled = ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"].includes(event.key);
    if (!handled) return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(options.length - 1);
    else {
      setOpen(false);
      button.current?.focus();
    }
  };
  const choose = (next: T) => {
    setOpen(false);
    button.current?.focus();
    if (next !== value) onChoose(next);
  };

  return (
    <span ref={root} className="ticket-menu-anchor">
      <button
        ref={button}
        type="button"
        className="ticket-value-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className="ticket-menu" onKeyDown={onMenuKeyDown}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { items.current[index] = node; }}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              tabIndex={-1}
              onClick={() => choose(option.value)}
            >
              {option.mark}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

interface ActionsMenuProps {
  label: string;
  /** Conteúdo do botão (o ícone). */
  trigger: ReactNode;
  /** Recebe `close` para fechar o menu depois de uma ação. */
  children: (close: () => void) => ReactNode;
}

/** Menu de ações: um botão que abre um painel. Esc ou clique fora fecham e devolvem o foco ao botão. */
export function ActionsMenu({ label, trigger, children }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = () => setOpen(false);
  useOutsideClick(open, root, close);

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const closeAndReturn = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span ref={root} className="ticket-menu-anchor">
      <button
        ref={button}
        type="button"
        className="ticket-icon-button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="group"
          aria-label={label}
          className="ticket-menu is-end"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeAndReturn();
          }}
        >
          {children(closeAndReturn)}
        </div>
      )}
    </span>
  );
}
