import { Fragment } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { MenuItem, MenuKind } from "./suggestions.js";

export interface MenuState {
  kind: MenuKind;
  query: string;
  items: MenuItem[];
  selected: number;
  rect: DOMRect | null;
  command: (item: MenuItem) => void;
}

const WIDTH = 290;
const HEIGHT = 300;

function placement(state: MenuState): CSSProperties {
  const width = WIDTH;
  const rect = state.rect;
  if (!rect) return { left: 0, top: 0, width };
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return rect.bottom + HEIGHT > window.innerHeight && rect.top > HEIGHT ? { left, bottom: window.innerHeight - rect.top + 6, width } : { left, top: rect.bottom + 6, width };
}

export const optionId = (prefix: string, index: number) => `${prefix}-option-${index}`;

/** O menu de blocos do "/" (ADR 0036): desenhado aqui, com os textos do catálogo. O `#` e o `@` usam o seletor comum (`MentionPicker`). */
export function SuggestionMenu({ state, idPrefix }: { state: MenuState; idPrefix: string }) {
  const { t } = useTranslation("ticket");
  return (
    <div
      className="description-menu"
      id={`${idPrefix}-menu`}
      role="menu"
      aria-label={t("blocks.label")}
      style={placement(state)}
      // O clique no menu não tira o foco do texto.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="description-menu-title" aria-hidden="true">{t("blocks.label")}</div>
      {state.items.length === 0 && <div className="description-menu-empty">{t("blocks.empty")}</div>}
      {state.items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 && <div className="description-menu-separator" role="separator" />}
        <button
          id={optionId(idPrefix, index)}
          type="button"
          tabIndex={-1}
          role="menuitem"
          className={index === state.selected ? "description-menu-item is-selected" : "description-menu-item"}
          onClick={() => state.command(item)}
        >
          <>
              <span className="description-menu-glyph" aria-hidden="true">{item.glyph}</span>
              <span className="description-menu-text">{item.label}</span>
              {item.hint !== undefined && item.hint !== "" && <span className="description-menu-hint" aria-hidden="true">{item.hint}</span>}
          </>
        </button>
        </Fragment>
      ))}
    </div>
  );
}
