import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

export type View = "map" | "ideas" | "teams" | "settings" | "import";

/** Seções da barra; a tela de importação é aberta pelo detalhe do projeto e conta como parte do mapa. */
type NavView = Exclude<View, "import">;

const LINKS: readonly NavView[] = ["map", "ideas", "teams", "settings"];

interface Route {
  view: View;
  projectId: string | null;
  /** Ticket aberto na página do mapa (ADR 0026); só existe na seção do mapa. */
  ticketId: string | null;
  /** Ticket a que a câmera vai ao chegar no mapa, sem abrir a página ("Ver no mapa" da tela "Ideias"); some depois de tratado. */
  focusId: string | null;
}

/** Para onde vai quem chega no mapa vindo de outra tela: com um ticket aberto na página, ou com a câmera nele. */
export interface MapTarget {
  ticketId?: string;
  focusId?: string;
}

function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "teams") return { view: "teams", projectId: null, ticketId: null, focusId: null };
  if (view === "ideas") return { view: "ideas", projectId: null, ticketId: null, focusId: null };
  if (view === "settings") return { view: "settings", projectId: null, ticketId: null, focusId: null };
  if (view === "import") return { view: "import", projectId: params.get("project") || null, ticketId: null, focusId: null };
  return { view: "map", projectId: null, ticketId: params.get("ticket") || null, focusId: params.get("focus") || null };
}

/** URL relativa para a seção: preserva os outros parâmetros e o hash. `projectId` só vale para a importação; `target`, para o mapa. */
export function viewHref(view: View, href: string = window.location.href, projectId: string | null = null, target: MapTarget = {}): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  url.searchParams.delete("ticket");
  url.searchParams.delete("focus");
  if (view === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (view === "import" && projectId !== null) url.searchParams.set("project", projectId);
  if (view === "map" && target.ticketId !== undefined) url.searchParams.set("ticket", target.ticketId);
  else if (view === "map" && target.focusId !== undefined) url.searchParams.set("focus", target.focusId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** URL relativa do mapa com o ticket aberto (ou sem ele): preserva os outros parâmetros e o hash. */
export function ticketHref(ticketId: string | null, href: string = window.location.href): string {
  const url = new URL(href);
  if (ticketId === null) url.searchParams.delete("ticket");
  else url.searchParams.set("ticket", ticketId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type NavigateFn = (view: View, projectId?: string | null, target?: MapTarget) => void;

/** `[tela, ir para a tela, projeto da importação, ticket aberto, abrir ticket, ticket da câmera, tratar o pedido da câmera]`. */
export function useView(): [View, NavigateFn, string | null, string | null, (ticketId: string | null) => void, string | null, () => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback<NavigateFn>((view, projectId = null, target = {}) => {
    const current = parseRoute(window.location.search);
    const next: Route = {
      view,
      projectId: view === "import" ? projectId : null,
      ticketId: view === "map" ? target.ticketId ?? null : null,
      focusId: view === "map" && target.ticketId === undefined ? target.focusId ?? null : null,
    };
    if (current.view !== next.view || current.projectId !== next.projectId || current.ticketId !== next.ticketId || current.focusId !== next.focusId) {
      window.history.pushState(window.history.state, "", viewHref(view, window.location.href, next.projectId, target));
    }
    setRoute(next);
  }, []);

  const openTicket = useCallback((ticketId: string | null) => {
    const current = parseRoute(window.location.search);
    if (current.view !== "map") return;
    if (current.ticketId !== ticketId) window.history.pushState(window.history.state, "", ticketHref(ticketId));
    setRoute({ view: "map", projectId: null, ticketId, focusId: null });
  }, []);

  // O pedido da câmera vale uma vez: tratado, sai da URL sem criar entrada no histórico.
  const clearFocus = useCallback(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("focus")) {
      url.searchParams.delete("focus");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setRoute((current) => (current.focusId === null ? current : { ...current, focusId: null }));
  }, []);

  return [route.view, navigate, route.projectId, route.ticketId, openTicket, route.focusId, clearFocus];
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
