import { useCallback, useMemo, useRef, useState } from "react";
import type { MenuState } from "../ticket/description/SuggestionMenu.js";
import type { MenuKind, SuggestionHost } from "../ticket/description/suggestions.js";

/**
 * O que os três editores têm em comum para as listas de `/`, `#` e `@`: o estado da lista aberta e o teclado dela (setas escolhem,
 * Enter ou Tab confirmam, Esc fecha só a lista). Pessoa apagada (sem acesso ao projeto) não se confirma.
 */
export function useSuggestionHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  const setMenuState = useCallback((next: MenuState | null) => {
    menuRef.current = next;
    setMenu(next);
  }, []);
  const host = useMemo<SuggestionHost>(
    () => ({
      show(kind, suggestion) {
        const previous = menuRef.current;
        const selected = previous && previous.kind === kind && previous.query === suggestion.query ? Math.min(previous.selected, Math.max(suggestion.items.length - 1, 0)) : 0;
        setMenuState({ kind, query: suggestion.query, items: suggestion.items, selected, rect: suggestion.clientRect?.() ?? null, command: suggestion.command });
      },
      key(_kind, event) {
        const current = menuRef.current;
        if (!current) return false;
        const count = current.items.length;
        if (event.key === "Escape") {
          // Fecha só a lista: a página e a edição não veem esta tecla.
          event.stopPropagation();
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (count === 0) return false;
          setMenuState({ ...current, selected: (current.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
          return true;
        }
        const confirming = (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey);
        if (confirming) {
          const item = current.items[current.selected];
          if (!item) return event.key === "Enter";
          if (item.person?.blocked !== true) current.command(item);
          return true;
        }
        return false;
      },
      hide(kind: MenuKind) {
        if (menuRef.current?.kind === kind) setMenuState(null);
      },
    }),
    [setMenuState],
  );
  return { menu, menuRef, setMenuState, host };
}
