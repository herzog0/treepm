import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import "../map/status-mark.css";
import "./mentions.css";

/** Onde o `#` ou o `@` está na tela: o canto de cima da linha e o pé dela. */
export interface CaretPoint {
  left: number;
  top: number;
  bottom: number;
}

export interface PopupOption {
  key: string;
  /** Quem não pode ser escolhido aparece apagado, com o motivo dentro do conteúdo. */
  disabled: boolean;
  content: ReactNode;
}

interface MentionListProps {
  /** Nome acessível da lista ("Pessoas", "Tickets"). */
  label: string;
  /** O que foi digitado, com o `@` ou o `#` na frente: aparece no cabeçalho, como no desenho. */
  typed: string;
  listId: string;
  optionId: (key: string) => string;
  options: readonly PopupOption[];
  activeKey: string | null;
  /** O campo de escrever, onde a lista se prende: ela nunca passa da largura dele. */
  box: DOMRect | null;
  point: CaretPoint | null;
  /** Carregando, falhou ou sem resultado: aparece no lugar das opções. */
  message: ReactNode;
  hint: string;
  onPick: (key: string) => void;
}

const WIDTH = 360;
const MARGIN = 8;
const MAX_HEIGHT = 300;

/** Onde a lista fica: acima da linha do cursor (ou abaixo, se em cima não couber), dentro da largura do campo e da tela. */
export function placement(point: CaretPoint | null, box: DOMRect | null, viewport: { width: number; height: number }): CSSProperties {
  const room = Math.max(0, Math.min(box?.width ?? WIDTH, viewport.width - 2 * MARGIN));
  const width = Math.min(WIDTH, room);
  const from = Math.max(MARGIN, box?.left ?? MARGIN);
  const to = Math.min(viewport.width - MARGIN, box?.right ?? viewport.width - MARGIN);
  const left = Math.min(Math.max(point?.left ?? from, from), Math.max(from, to - width));
  const top = point?.top ?? viewport.height;
  const above = top - 2 * MARGIN;
  const below = viewport.height - (point?.bottom ?? viewport.height) - 2 * MARGIN;
  if (above >= Math.min(MAX_HEIGHT, 160) || above >= below) return { position: "fixed", left, width, bottom: viewport.height - top + 6, maxHeight: Math.min(MAX_HEIGHT, Math.max(above, 80)) };
  return { position: "fixed", left, width, top: (point?.bottom ?? 0) + 6, maxHeight: Math.min(MAX_HEIGHT, Math.max(below, 80)) };
}

/**
 * A lista do seletor de `@` e de `#` (a mesma na descrição, nos comentários e nas conversas): aparece junto do ponto do texto e é só uma lista; quem tem o foco é sempre o campo (padrão de caixa de
 * combinação: o campo aponta a opção com `aria-activedescendant`). Clicar numa opção não tira o foco do campo.
 */
export function MentionList({ label, typed, listId, optionId, options, activeKey, box, point, message, hint, onPick }: MentionListProps) {
  const active = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);
  const style = placement(point, box, { width: window.innerWidth, height: window.innerHeight });
  return (
    <div className="mention-list" style={style} onMouseDown={(event) => event.preventDefault()}>
      <div className="mention-head" aria-hidden="true">
        <span>{label}</span>
        <b>{typed}</b>
      </div>
      {message}
      <ul role="listbox" id={listId} aria-label={label}>
        {options.map((option) => (
          <li
            key={option.key}
            ref={option.key === activeKey ? active : undefined}
            id={optionId(option.key)}
            role="option"
            aria-selected={option.key === activeKey}
            aria-disabled={option.disabled ? true : undefined}
            className={option.key === activeKey ? "is-active" : undefined}
            onClick={() => !option.disabled && onPick(option.key)}
          >
            {option.content}
          </li>
        ))}
      </ul>
      <p className="mention-hint" aria-hidden="true">{hint}</p>
    </div>
  );
}
