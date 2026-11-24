import { useCallback, useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type View = "map" | "ideas" | "teams" | "settings" | "import";

/** Seções da barra; a tela de importação é aberta pelo detalhe do projeto e conta como parte do mapa. */
type NavView = Exclude<View, "import">;

const LINKS: readonly NavView[] = ["map", "ideas", "teams", "settings"];

/** Ícones das seções na barra lateral (ADR 0055); decorativos, o nome vem do texto. */
const ICONS: Record<NavView, ReactNode> = {
  map: (<><rect x="2.5" y="2.5" width="13" height="13" rx="3.5" /><rect x="6" y="6" width="6" height="6" rx="1.5" /></>),
  ideas: <path d="M9 2.5a4.5 4.5 0 00-2.5 8.2V12h5v-1.3A4.5 4.5 0 009 2.5zM7 14.5h4" />,
  teams: <path d="M2 15c.6-2.6 2.5-3.9 5-3.9s4.4 1.3 5 3.9M12.5 4.2a2.6 2.6 0 010 4.8M14 11.3c1.3.5 2 1.7 2.3 3.2M9.8 6.5a2.8 2.8 0 11-5.6 0 2.8 2.8 0 015.6 0z" />,
  settings: (<><circle cx="9" cy="9" r="2.5" /><path d="M9 2v2M9 14v2M2 9h2M14 9h2M4 4l1.4 1.4M12.6 12.6L14 14M4 14l1.4-1.4M12.6 5.4L14 4" /></>),
};
export const NavIcon = ({ view }: { view: NavView }) => (
  <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true">{ICONS[view]}</svg>
);

interface Route {
  view: View;
  projectId: string | null;
  /** Ticket aberto na página do mapa (ADR 0026); só existe na seção do mapa. */
  ticketId: string | null;
  /** Ticket a que a câmera vai ao chegar no mapa, sem abrir a página ("Ver no mapa" da tela "Ideias"); some depois de tratado. */
  focusId: string | null;
}

/** Para onde vai quem chega no mapa vindo de outra tela: com um ticket aberto na página, com a câmera nele, ou os dois. */
export interface MapTarget {
  ticketId?: string;
  focusId?: string;
  /** Seção das Configurações a abrir (a âncora `#github`); só vale para a tela de configurações. */
  section?: string;
}

/** Para onde "o cabeçalho do chat" leva: abre a página do ticket; se ela já está aberta nele, só a câmera vai (ADR 0049). */
export function chatTicketTarget(openTicketId: string | null, ticketId: string): MapTarget {
  return openTicketId === ticketId ? { ticketId, focusId: ticketId } : { ticketId };
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

/**
 * URL relativa para a seção: preserva os outros parâmetros e o hash. `projectId` só vale para a importação; `target`, para o mapa
 * (e `target.section`, para as Configurações). A âncora das Configurações (`#mcp`) não sai delas: ao entrar ou sair da tela de
 * configurações o hash é trocado (pela seção pedida, ou apagado), para não vazar para o endereço do mapa e dos tickets.
 */
export function viewHref(view: View, href: string = window.location.href, projectId: string | null = null, target: MapTarget = {}): string {
  const url = new URL(href);
  if (view === "settings" || url.searchParams.get("view") === "settings") url.hash = view === "settings" && target.section ? target.section : "";
  url.searchParams.delete("project");
  url.searchParams.delete("ticket");
  url.searchParams.delete("focus");
  if (view === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (view === "import" && projectId !== null) url.searchParams.set("project", projectId);
  if (view === "map" && target.ticketId !== undefined) url.searchParams.set("ticket", target.ticketId);
  // Os dois juntos: a página do ticket já aberta e a câmera a caminho dele (cabeçalho do chat, ADR 0049).
  if (view === "map" && target.focusId !== undefined) url.searchParams.set("focus", target.focusId);
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
      focusId: view === "map" ? target.focusId ?? null : null,
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

export function AppNav({ view, onNavigate, links = LINKS }: { view: View; onNavigate: (view: View) => void; links?: readonly NavView[] }) {
  const { t } = useTranslation("nav");
  return (
    <nav className="app-nav" aria-label={t("label")}>
      {links.map((link) => (
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
          <NavIcon view={link} />
          <span>{t(link)}</span>
        </a>
      ))}
    </nav>
  );
}
