import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

export type View = "map" | "teams" | "settings" | "import";

/** Seções da barra; a tela de importação é aberta pelo detalhe do projeto e conta como parte do mapa. */
type NavView = Exclude<View, "import">;

const LINKS: readonly NavView[] = ["map", "teams", "settings"];

interface Route {
  view: View;
  projectId: string | null;
  /** Ticket aberto na página do mapa (ADR 0026); só existe na seção do mapa. */
  ticketId: string | null;
}

function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "teams") return { view: "teams", projectId: null, ticketId: null };
  if (view === "settings") return { view: "settings", projectId: null, ticketId: null };
  if (view === "import") return { view: "import", projectId: params.get("project") || null, ticketId: null };
  return { view: "map", projectId: null, ticketId: params.get("ticket") || null };
}

/** URL relativa para a seção: preserva os outros parâmetros e o hash. `projectId` só vale para a importação. */
export function viewHref(view: View, href: string = window.location.href, projectId: string | null = null): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  url.searchParams.delete("ticket");
  if (view === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (view === "import" && projectId !== null) url.searchParams.set("project", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** URL relativa do mapa com o ticket aberto (ou sem ele): preserva os outros parâmetros e o hash. */
export function ticketHref(ticketId: string | null, href: string = window.location.href): string {
  const url = new URL(href);
  if (ticketId === null) url.searchParams.delete("ticket");
  else url.searchParams.set("ticket", ticketId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useView(): [View, (view: View, projectId?: string | null) => void, string | null, string | null, (ticketId: string | null) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((view: View, projectId: string | null = null) => {
    const current = parseRoute(window.location.search);
    const next: Route = { view, projectId: view === "import" ? projectId : null, ticketId: null };
    if (current.view !== next.view || current.projectId !== next.projectId || current.ticketId !== null) {
      window.history.pushState(window.history.state, "", viewHref(view, window.location.href, next.projectId));
    }
    setRoute(next);
  }, []);

  const openTicket = useCallback((ticketId: string | null) => {
    const current = parseRoute(window.location.search);
    if (current.view !== "map") return;
    if (current.ticketId !== ticketId) window.history.pushState(window.history.state, "", ticketHref(ticketId));
    setRoute({ view: "map", projectId: null, ticketId });
  }, []);

  return [route.view, navigate, route.projectId, route.ticketId, openTicket];
}

export function AppNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const { t } = useTranslation("nav");
  return (
    <nav className="app-nav" aria-label={t("label")}>
      {LINKS.map((link) => (
        <a
          key={link}
          href={viewHref(link)}
          aria-current={(view === "import" ? "map" : view) === link ? "page" : undefined}
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate(link);
          }}
        >
          {t(link)}
        </a>
      ))}
    </nav>
  );
}
