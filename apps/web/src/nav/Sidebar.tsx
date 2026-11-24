import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConversationList } from "../chat/ConversationList.js";
import { AppNav, NavIcon, viewHref } from "./navigation.js";
import type { View } from "./navigation.js";
import "./sidebar.css";

/** A gaveta da barra lateral em tela estreita (até 720 px): quem a abre e fecha é a casca; a barra fecha a gaveta ao escolher um destino. */
export const SidebarDrawerContext = createContext<{ close: () => void }>({ close: () => undefined });

const PlusIcon = () => (
  <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 4v10M4 9h10" /></svg>
);
const SearchIcon = () => (
  <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="M12 12l3.5 3.5" /></svg>
);

export interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  /** "Novo ticket": abre a conversa de novo ticket da barra de pedidos do mapa. */
  onNewTicket: () => void;
  /** "Buscar": leva o foco à barra de pedidos do mapa (o mesmo que Ctrl/⌘+K). */
  onSearch: () => void;
  /** O seletor da organização (Clerk), no topo. */
  organization: ReactNode;
  /** A pessoa (avatar do Clerk e estado da sessão), no rodapé, ao lado de Configurações. */
  account: ReactNode;
}

/**
 * A barra lateral fixa da aplicação autenticada (ADR 0055): organização no topo, "Novo ticket" e "Buscar", as seções, a lista
 * "Conversas" e, embaixo, a pessoa e Configurações. Substitui o cabeçalho de cima.
 */
export function Sidebar({ view, onNavigate, onNewTicket, onSearch, organization, account }: SidebarProps) {
  const { t } = useTranslation("nav");
  const drawer = useContext(SidebarDrawerContext);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const goTo = (target: View) => {
    drawer.close();
    onNavigate(target);
  };
  return (
    <nav className="sidebar" id="app-sidebar" aria-label={t("sidebar.label")} onClickCapture={(event) => { if ((event.target as HTMLElement).closest("button.conv-row")) drawer.close(); }}>
      <div className="sidebar-org">{organization}</div>
      <div className="sidebar-actions">
        <button type="button" className="sidebar-new" onClick={() => { drawer.close(); onNewTicket(); }}>
          <PlusIcon />
          {t("sidebar.newTicket")}
        </button>
        <button type="button" className="sidebar-search" onClick={() => { drawer.close(); onSearch(); }}>
          <SearchIcon />
          <span className="sidebar-search-label">{t("sidebar.search")}</span>
          <kbd>{t(mac ? "sidebar.shortcutMac" : "sidebar.shortcut")}</kbd>
        </button>
      </div>
      <AppNav view={view} onNavigate={goTo} links={["map", "ideas", "teams"]} />
      <div className="sidebar-conversations">
        <ConversationList />
      </div>
      <div className="sidebar-foot">
        <div className="sidebar-account">{account}</div>
        <a
          className="sidebar-settings"
          href={viewHref("settings")}
          aria-label={t("sidebar.settings")}
          aria-current={view === "settings" ? "page" : undefined}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            goTo("settings");
          }}
        >
          <NavIcon view="settings" />
        </a>
      </div>
    </nav>
  );
}
