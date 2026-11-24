import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SidebarDrawerContext } from "../nav/Sidebar.js";
import { ChatPanel } from "./ChatPanel.js";
import { useChats } from "./ChatsContext.js";

/**
 * A casca da aplicação autenticada (ADR 0055): a barra lateral fixa à esquerda, a conversa aberta numa coluna ao lado dela (quando
 * aberta, o mapa encolhe) e a tela. Em tela estreita a barra é uma gaveta, aberta pelo botão da faixa do topo.
 */
export function ChatShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const { t } = useTranslation("nav");
  const { t: tApp } = useTranslation();
  const chats = useChats();
  const [drawer, setDrawer] = useState(false);
  const drawerApi = useMemo(() => ({ close: () => setDrawer(false) }), []);
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setDrawer(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawer]);
  const unread = chats?.unreadChats ?? 0;
  return (
    <div className={`tenant-shell ${chats?.open ? "has-chat-panel" : ""} ${drawer ? "has-drawer" : ""}`}>
      <div className="tenant-topbar">
        <button
          type="button"
          className="tenant-menu-button"
          aria-expanded={drawer}
          aria-controls="app-sidebar"
          aria-label={drawer ? t("sidebar.menuClose") : unread > 0 ? t("sidebar.menuUnread", { count: unread }) : t("sidebar.menuOpen")}
          onClick={() => setDrawer((open) => !open)}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h14" /></svg>
          {unread > 0 && !drawer && <span className="chat-badge" aria-hidden="true">{unread}</span>}
        </button>
        <strong className="tenant-brand-name">{tApp("brand")}</strong>
      </div>
      <SidebarDrawerContext.Provider value={drawerApi}>{sidebar}</SidebarDrawerContext.Provider>
      {drawer && <div className="tenant-drawer-backdrop" aria-hidden="true" onClick={() => setDrawer(false)} />}
      <ChatPanel />
      {children}
    </div>
  );
}
