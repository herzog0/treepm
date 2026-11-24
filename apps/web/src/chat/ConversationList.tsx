import { useTranslation } from "react-i18next";
import type { KeyboardEvent } from "react";
import type { ChatListItem } from "../api/client.js";
import { formatActivityTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { useChats } from "./ChatsContext.js";

/** Cor da bolinha: a da situação do ticket quando a lista a traz; neutra (a de "a fazer") enquanto o servidor não manda esse dado. */
const SITUATION_TOKEN: Record<string, string> = {
  blocked: "var(--tp-blocked)",
  in_progress: "var(--tp-doing)",
  in_review: "var(--tp-review)",
  todo: "var(--tp-todo)",
  done: "var(--tp-done)",
  cancelled: "var(--tp-cancelled)",
};

function dotColor(chat: ChatListItem): string {
  const situation = chat.blocked === true && chat.status !== "done" && chat.status !== "cancelled" ? "blocked" : (chat.status ?? "todo");
  return SITUATION_TOKEN[situation] ?? SITUATION_TOKEN["todo"]!;
}

function ConversationRow({ chat, current }: { chat: ChatListItem; current: boolean }) {
  const { t, i18n } = useTranslation("chat");
  const chats = useChats()!;
  return (
    <li>
      <button
        type="button"
        className={`conv-row ${chat.unread > 0 ? "is-unread" : ""}`}
        aria-current={current ? "true" : undefined}
        onClick={() => chats.openChat(chat.ticketId)}
      >
        <span className="conv-dot" aria-hidden="true" style={{ background: dotColor(chat) }} />
        <span className="conv-title"><code className="conv-key">{chat.ticketKey}</code>{chat.title}</span>
        <time className="conv-time" dateTime={chat.lastActivityAt}>{formatActivityTime(i18n.language as Language, chat.lastActivityAt, new Date())}</time>
        {chat.assignedToMe && <span className="conv-assigned">{t("list.assigned")}</span>}
        {chat.unread > 0 && (
          <span className="conv-badge">
            <span aria-hidden="true">{chat.unread}</span>
            <span className="chat-visually-hidden">{t("list.unread", { count: chat.unread })}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/** A seção "Conversas" da barra lateral (ADR 0055): a lista "Meus chats" da ADR 0049, sempre à vista. Sem provedor de chats, não existe. */
export function ConversationList() {
  const { t } = useTranslation("chat");
  const chats = useChats();
  if (!chats) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.conv-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <section className="conv-section" aria-labelledby="conv-section-title">
      <div className="conv-section-head">
        <h2 id="conv-section-title">{t("list.title")}</h2>
        {chats.unreadChats > 0 && <span className="conv-section-total">{t("list.unread", { count: chats.unreadChats })}</span>}
      </div>
      {chats.chats === null && !chats.listFailed && <p role="status" className="conv-hint">{t("list.loading")}</p>}
      {chats.listFailed && (
        <div className="conv-hint">
          <p role="alert">{t("list.loadFailed")}</p>
          <button type="button" className="chat-text-button" onClick={() => void chats.refresh()}>{t("list.retry")}</button>
        </div>
      )}
      {chats.chats !== null && chats.chats.length === 0 && !chats.listFailed && <p className="conv-hint">{t("list.empty")}</p>}
      {chats.chats !== null && chats.chats.length > 0 && (
        <ul className="conv-list" onKeyDown={onKeyDown}>
          {chats.chats.map((chat) => <ConversationRow key={chat.ticketId} chat={chat} current={chats.open && chats.ticketId === chat.ticketId} />)}
        </ul>
      )}
    </section>
  );
}
