import { Fragment } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { StatusMark } from "../../map/StatusMark.js";
import type { MenuItem, MenuKind } from "./suggestions.js";

export interface MenuState {
  kind: MenuKind;
  query: string;
  items: MenuItem[];
  selected: number;
  rect: DOMRect | null;
  command: (item: MenuItem) => void;
}

const WIDTH = { blocks: 290, mention: 390 } as const;
const HEIGHT = 300;

function placement(state: MenuState): CSSProperties {
  const width = WIDTH[state.kind];
  const rect = state.rect;
  if (!rect) return { left: 0, top: 0, width };
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return rect.bottom + HEIGHT > window.innerHeight && rect.top > HEIGHT ? { left, bottom: window.innerHeight - rect.top + 6, width } : { left, top: rect.bottom + 6, width };
}

export const optionId = (prefix: string, index: number) => `${prefix}-option-${index}`;

/** Menus de "/" e "@" da descrição (ADR 0036): desenhados aqui, com os textos do catálogo. */
export function SuggestionMenu({ state, idPrefix }: { state: MenuState; idPrefix: string }) {
  const { t } = useTranslation("ticket");
  const blocks = state.kind === "blocks";
  return (
    <div
      className="description-menu"
      id={`${idPrefix}-menu`}
      role={blocks ? "menu" : "listbox"}
      aria-label={blocks ? t("blocks.label") : t("mention.label")}
      style={placement(state)}
      // O clique no menu não tira o foco do texto.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="description-menu-title" aria-hidden="true">{blocks ? t("blocks.label") : t("mention.label")}</div>
      {state.items.length === 0 && <div className="description-menu-empty">{blocks ? t("blocks.empty") : t("mention.empty")}</div>}
      {state.items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 && <div className="description-menu-separator" role="separator" />}
        <button
          id={optionId(idPrefix, index)}
          type="button"
          tabIndex={-1}
          role={blocks ? "menuitem" : "option"}
          {...(blocks ? {} : { "aria-selected": index === state.selected })}
          className={index === state.selected ? "description-menu-item is-selected" : "description-menu-item"}
          onClick={() => state.command(item)}
        >
          {item.ticket ? (
            <>
              <StatusMark status={item.ticket.status} />
              <span className="description-menu-key">{item.ticket.key}</span>
              <span className="description-menu-text">{item.ticket.title}</span>
            </>
          ) : (
            <>
              <span className="description-menu-glyph" aria-hidden="true">{item.glyph}</span>
              <span className="description-menu-text">{item.label}</span>
              {item.hint !== undefined && item.hint !== "" && <span className="description-menu-hint" aria-hidden="true">{item.hint}</span>}
            </>
          )}
        </button>
        </Fragment>
      ))}
      {!blocks && <div className="description-menu-foot">{t("mention.footer")}</div>}
    </div>
  );
}
