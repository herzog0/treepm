import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";

export type View = "map" | "teams";

const LINKS: readonly { view: View; label: string }[] = [
  { view: "map", label: "Mapa" },
  { view: "teams", label: "Times" },
];

function parseView(search: string): View {
  return new URLSearchParams(search).get("view") === "teams" ? "teams" : "map";
}

/** URL relativa para a seção: preserva os outros parâmetros e o hash. */
export function viewHref(view: View, href: string = window.location.href): string {
  const url = new URL(href);
  if (view === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => parseView(window.location.search));

  useEffect(() => {
    const onPopState = () => setView(parseView(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: View) => {
    if (parseView(window.location.search) !== next) {
      window.history.pushState(window.history.state, "", viewHref(next));
    }
    setView(next);
  }, []);

  return [view, navigate];
}

export function AppNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav className="app-nav" aria-label="Seções">
      {LINKS.map((link) => (
        <a
          key={link.view}
          href={viewHref(link.view)}
          aria-current={view === link.view ? "page" : undefined}
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate(link.view);
          }}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
