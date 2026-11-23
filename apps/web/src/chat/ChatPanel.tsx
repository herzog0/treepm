import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChatListItem } from "../api/client.js";
import { formatActivityTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { useChats } from "./ChatsContext.js";
import { TicketChat } from "./TicketChat.js";
import "./chat.css";

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m3 3 8 8M11 3l-8 8" />
  </svg>
);

function ChatRow({ chat }: { chat: ChatListItem }) {
  const { t, i18n } = useTranslation("chat");
  const chats = useChats()!;
  return (
    <li>
      <button type="button" className="chat-row" onClick={() => chats.openChat(chat.ticketId)}>
        <span className="chat-row-line">
          <code>{chat.ticketKey}</code>
          <span className="chat-row-title">{chat.title}</span>
        </span>
        <span className="chat-row-meta">
          {chat.assignedToMe && <span>{t("list.assigned")}</span>}
          <time dateTime={chat.lastActivityAt}>{formatActivityTime(i18n.language as Language, chat.lastActivityAt, new Date())}</time>
        </span>
        {chat.unread > 0 && (
          <span className="chat-badge">
            <span aria-hidden="true">{chat.unread}</span>
            <span className="chat-visually-hidden">{t("list.unread", { count: chat.unread })}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function ChatList({ active }: { active: boolean }) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (active) heading.current?.focus();
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.chat-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <div className="chat-list">
      <h2 ref={heading} tabIndex={-1}>{t("list.title")}</h2>
      {chats.chats === null && !chats.listFailed && <p role="status" className="chat-hint">{t("list.loading")}</p>}
      {chats.listFailed && (
        <div className="chat-hint">
          <p role="alert">{t("list.loadFailed")}</p>
          <button type="button" onClick={() => void chats.refresh()}>{t("list.retry")}</button>
        </div>
      )}
      {chats.chats !== null && chats.chats.length === 0 && !chats.listFailed && <p className="chat-hint">{t("list.empty")}</p>}
      {chats.chats !== null && chats.chats.length > 0 && (
        <ul onKeyDown={onKeyDown}>
          {chats.chats.map((chat) => <ChatRow key={chat.ticketId} chat={chat} />)}
        </ul>
      )}
    </div>
  );
}

/**
 * O painel lateral esquerdo "Chats" (ADR 0049): a lista "Meus chats" e, escolhido um, o chat do ticket. Depois da primeira abertura fica
 * montado e só escondido, para a conversa em andamento e o texto digitado não se perderem. `Esc` fecha só o painel.
 */
export function ChatPanel() {
  const { t } = useTranslation("chat");
  const chats = useChats();
  if (!chats || !chats.opened) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // A página do ticket ouve o `Esc` na janela: o painel o toma para si.
    event.preventDefault();
    event.stopPropagation();
    chats.close();
  };
  return (
    <aside id="chat-panel" className="chat-panel" aria-label={t("panel.label")} hidden={!chats.open} onKeyDown={onKeyDown}>
      {chats.ticketId === null ? (
        <>
          <header className="chat-header">
            <span className="chat-header-title">{t("panel.label")}</span>
            <button type="button" className="chat-icon-button" aria-label={t("panel.close")} onClick={chats.close}>
              <CloseIcon />
            </button>
          </header>
          <ChatList active={chats.open} />
        </>
      ) : (
        <TicketChat key={chats.ticketId} ticketId={chats.ticketId} active={chats.open} />
      )}
    </aside>
  );
}
