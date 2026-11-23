import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChats } from "./ChatsContext.js";

/** O botão "Chats" do cabeçalho: abre e fecha o painel lateral esquerdo e mostra quantos chats têm mensagem não lida. Sem provedor, não existe. */
export function ChatsButton() {
  const { t } = useTranslation("chat");
  const chats = useChats();
  const ref = useRef<HTMLButtonElement>(null);
  const register = chats?.registerButton;
  useEffect(() => {
    register?.(ref.current);
    return () => register?.(null);
  }, [register]);
  if (!chats) return null;
  const unread = chats.unreadChats;
  return (
    <button
      ref={ref}
      type="button"
      className="tenant-chats"
      aria-expanded={chats.open}
      aria-controls="chat-panel"
      aria-label={unread > 0 ? t("button.withUnread", { count: unread }) : t("button.label")}
      onClick={chats.toggle}
    >
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      <span>{t("button.label")}</span>
      {unread > 0 && <span className="chat-badge" aria-hidden="true">{unread}</span>}
    </button>
  );
}
