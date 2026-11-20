import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";

export type View = "map" | "teams" | "import";

/** Seções da barra; a tela de importação é aberta pelo detalhe do projeto e conta como parte do mapa. */
type NavView = Exclude<View, "import">;

const LINKS: readonly { view: NavView; label: string }[] = [
  { view: "map", label: "Mapa" },
  { view: "teams", label: "Times" },
];

interface Route {
  view: View;
  projectId: string | null;
}

function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "teams") return { view: "teams", projectId: null };
  if (view === "import") return { view: "import", projectId: params.get("project") || null };
  return { view: "map", projectId: null };
}

/** URL relativa para a seção: preserva os outros parâmetros e o hash. `projectId` só vale para a importação. */
export function viewHref(view: View, href: string = window.location.href, projectId: string | null = null): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  if (view === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (view === "import" && projectId !== null) url.searchParams.set("project", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useView(): [View, (view: View, projectId?: string | null) => void, string | null] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((view: View, projectId: string | null = null) => {
    const current = parseRoute(window.location.search);
    const next: Route = { view, projectId: view === "import" ? projectId : null };
    if (current.view !== next.view || current.projectId !== next.projectId) {
      window.history.pushState(window.history.state, "", viewHref(view, window.location.href, next.projectId));
    }
    setRoute(next);
  }, []);

  return [route.view, navigate, route.projectId];
}

export function AppNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav className="app-nav" aria-label="Seções">
      {LINKS.map((link) => (
        <a
          key={link.view}
          href={viewHref(link.view)}
          aria-current={(view === "import" ? "map" : view) === link.view ? "page" : undefined}
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
