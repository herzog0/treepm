import type { ReactNode } from "react";
import { ChatPanel } from "./ChatPanel.js";
import { useChats } from "./ChatsContext.js";

/** A casca da aplicação autenticada: o cabeçalho, o painel de chats à esquerda (quando aberto, o mapa encolhe) e a tela. */
export function ChatShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  const chats = useChats();
  return (
    <div className={`tenant-shell ${chats?.open ? "has-chat-panel" : ""}`}>
      {header}
      <ChatPanel />
      {children}
    </div>
  );
}
