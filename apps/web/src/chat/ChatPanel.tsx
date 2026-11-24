import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { refKey, useChats } from "./ChatsContext.js";
import { ConversationView } from "./ConversationView.js";
import "./chat.css";

/**
 * A coluna da conversa aberta (ADR 0049, ADR 0055): a conversa escolhida na lista "Conversas" da barra lateral, entre a barra e o
 * mapa. Depois da primeira abertura fica montada e só escondida, para a conversa em andamento e o texto digitado não se perderem.
 * `Esc` fecha só a coluna.
 */
export function ChatPanel() {
  const { t } = useTranslation("chat");
  const chats = useChats();
  if (!chats || !chats.opened || chats.selection === null) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // A página do ticket ouve o `Esc` na janela: a coluna o toma para si.
    event.preventDefault();
    event.stopPropagation();
    chats.close();
  };
  return (
    <aside id="chat-panel" className="chat-panel" aria-label={t("panel.label")} hidden={!chats.open} onKeyDown={onKeyDown}>
      <ConversationView key={refKey(chats.selection)} target={chats.selection} active={chats.open} />
    </aside>
  );
}
