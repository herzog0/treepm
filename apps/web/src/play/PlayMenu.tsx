import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PlayTemplate, PlayTemplateId } from "@treepm/domain";

export interface PlayMenuProps {
  /** O alcance, dito no topo do menu. */
  scopeText: string;
  /** Os modelos, na ordem do domínio, vazios inclusive. */
  templates: readonly PlayTemplate[];
  onChoose: (id: PlayTemplateId) => void;
  /** Esc: fecha e devolve o foco ao botão. */
  onEscape: () => void;
  /** Tab: fecha sem tomar o foco. */
  onTab: () => void;
}

/**
 * O menu do botão play (ADR 0048): o alcance no topo e os cinco modelos, cada um com o nome, o que traz e a contagem de agora.
 * Modelo vazio fica desabilitado (`aria-disabled`, com o motivo como descrição). Teclado como nos outros menus da aplicação: setas,
 * Home e End navegam; Enter escolhe; Esc fecha e devolve o foco ao botão. Mora dentro da barra de pedidos, que corta o que passa da
 * borda; por isso é uma folha em linha, como a de resultados, e não um painel flutuante.
 */
export const PLAY_MENU_ID_PREFIX = "play-menu";
export function PlayMenu({ scopeText, templates, onChoose, onEscape, onTab }: PlayMenuProps) {
  const { t } = useTranslation("play");
  const id = useId();
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    items.current[0]?.focus();
  }, []);

  const move = (to: number) => items.current[(to + templates.length) % templates.length]?.focus();
  const onKeyDown = (event: KeyboardEvent) => {
    const at = items.current.findIndex((item) => item === document.activeElement);
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"].includes(event.key)) return;
    // Nada daqui chega aos atalhos da barra de pedidos nem aos do mapa.
    event.stopPropagation();
    if (event.key === "Tab") {
      onTab();
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(templates.length - 1);
    else onEscape();
  };

  return (
    <div className="command-sheet play-menu-sheet" onMouseDown={(event) => event.preventDefault()}>
      <p className="play-scope-line">{scopeText}</p>
      <div role="menu" aria-label={t("menu.label")} className="play-menu" onKeyDown={onKeyDown}>
        {templates.map((template, index) => {
          const empty = template.count === 0;
          return (
            <button
              key={template.id}
              ref={(node) => { items.current[index] = node; }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="play-item"
              aria-disabled={empty || undefined}
              aria-describedby={empty ? `${id}-${template.id}-empty` : undefined}
              onClick={() => {
                if (!empty) onChoose(template.id);
              }}
            >
              <span className="play-item-main">
                <span className="play-item-name">{t(`template.${template.id}.name`)}</span>
                <span className="play-item-hint">{t(`template.${template.id}.hint`)}</span>
              </span>
              <span className="play-item-count">{empty ? t("menu.none") : t("menu.count", { count: template.count })}</span>
              {empty && <span id={`${id}-${template.id}-empty`} className="play-sr">{t("menu.emptyReason")}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
