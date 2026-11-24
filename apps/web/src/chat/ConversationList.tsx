import { useTranslation } from "react-i18next";
import type { CSSProperties, KeyboardEvent } from "react";
import type { ConversationNode } from "../api/client.js";
import { formatActivityTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { nodeIsRef, refOfNode, topicLabel, useChats } from "./ChatsContext.js";
import { situationColor } from "./situation.js";
import { threadColor, threadTitle } from "./thread.js";

/** A indentação cresce 12 px por nível até o quinto; dali para baixo a linha fica onde está (a árvore pode ter mais de dez níveis). */
export const MAX_INDENT_LEVEL = 5;

const GeneralIcon = () => (
  <svg className="conv-general-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 4h12v8H8l-3 3v-3H3z" /></svg>
);

/** As mesmas pessoas (sem olhar a ordem): a thread que repete as pessoas da linha de cima se diz pelo assunto, não pelos nomes. */
const sameParticipants = (a: ConversationNode, b: ConversationNode): boolean => a.participants.length > 0 && a.participantCount === b.participantCount && a.participants.length === b.participants.length && a.participants.every((person) => b.participants.some((other) => other.id === person.id));

function ConversationRow({ node, depth, parent }: { node: ConversationNode; depth: number; parent?: ConversationNode }) {
  const { t, i18n } = useTranslation("chat");
  const chats = useChats()!;
  const current = chats.open && chats.selection !== null && nodeIsRef(node, chats.selection);
  const level = Math.min(depth, MAX_INDENT_LEVEL);
  const thread = node.kind === "thread";
  const topic = thread && node.purpose === "topic";
  const title =
    topic ? (
      // O assunto se diz pelo título que o assistente deu; sem ele, pelo começo da abertura; sem os dois, "Assunto". Nunca "Thread com…".
      topicLabel(node.title, node.label, t("row.topic"))
    ) :
    node.kind === "general" ? (
      t("row.general")
    ) : node.kind === "ticket" && node.ticket ? (
      <>
        <code className="conv-key">{node.ticket.key}</code>
        {/* O espaço entre a chave e o título é parte do nome acessível da linha. */}
        {" "}
        {node.ticket.title}
      </>
    ) : node.label && parent !== undefined && sameParticipants(node, parent) ? (
      node.label
    ) : (
      threadTitle(t, node.participants, node.participantCount, chats.selfId)
    );
  const sub = node.preview ?? (node.kind === "general" ? t("row.generalHint") : null);
  return (
    <li className="conv-item">
      <button
        type="button"
        className={`conv-row is-${node.kind} ${node.unread > 0 ? "is-unread" : ""}`}
        style={{ "--conv-level": level } as CSSProperties}
        aria-current={current ? "true" : undefined}
        onClick={() => chats.select(refOfNode(node))}
      >
        {topic ? (
          <span className="conv-topic-mark" aria-hidden="true">✦</span>
        ) : thread && node.id !== null ? (
          <span className="conv-thread-mark" aria-hidden="true" style={{ background: threadColor(node.id) }} />
        ) : node.kind === "general" ? (
          <GeneralIcon />
        ) : (
          <span className="conv-dot" aria-hidden="true" style={{ background: situationColor(node.ticket) }} />
        )}
        <span className="conv-text">
          <span className="conv-title">{title}</span>
          {sub !== null && <span className="conv-preview">{sub}</span>}
        </span>
        {node.lastActivityAt !== null && <time className="conv-time" dateTime={node.lastActivityAt}>{formatActivityTime(i18n.language as Language, node.lastActivityAt, new Date())}</time>}
        {(node.assignedToMe || node.unread > 0) && (
          <span className="conv-aside">
            {node.assignedToMe && (
              <span className="conv-assigned" role="img" aria-label={t("list.assignedHint")} title={t("list.assignedHint")}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></svg>
              </span>
            )}
            {node.unread > 0 && (
              <span className="conv-badge">
                <span aria-hidden="true">{node.unread}</span>
                <span className="chat-visually-hidden">{t("list.unread", { count: node.unread })}</span>
              </span>
            )}
          </span>
        )}
      </button>
      {node.kind === "general" && chats.topicRun !== null && (
        <ul className="conv-children">
          <li className="conv-item">
            <button type="button" className={`conv-row is-thread ${chats.topicRun.status === "failed" ? "is-unread" : ""}`} style={{ "--conv-level": Math.min(depth + 1, MAX_INDENT_LEVEL) } as CSSProperties} onClick={() => chats.openTopicRun()}>
              <span className="conv-topic-mark" aria-hidden="true">✦</span>
              <span className="conv-text">
                <span className="conv-title">{chats.topicRun.status === "failed" ? t("topic.failed") : t("topic.pending")}</span>
                <span className="conv-preview">{chats.topicRun.text}</span>
              </span>
            </button>
          </li>
        </ul>
      )}
      {node.children.length > 0 && (
        <ul className="conv-children">
          {node.children.map((child, index) => <ConversationRow key={child.id ?? `${child.kind}-${child.ticket?.id ?? index}`} node={child} depth={depth + 1} parent={node} />)}
        </ul>
      )}
    </li>
  );
}

/** A seção "Conversas" da barra lateral (ADR 0055): a árvore do chat geral, dos tickets e das threads, sempre à vista. Sem provedor de chats, não existe. */
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
      {chats.tree === null && !chats.listFailed && <p role="status" className="conv-hint">{t("list.loading")}</p>}
      {chats.listFailed && (
        <div className="conv-hint">
          <p role="alert">{t("list.loadFailed")}</p>
          <button type="button" className="chat-text-button" onClick={() => void chats.refresh()}>{t("list.retry")}</button>
        </div>
      )}
      {chats.tree !== null && chats.tree.length > 0 && (
        <ul className="conv-list" onKeyDown={onKeyDown}>
          {chats.tree.map((node, index) => <ConversationRow key={node.id ?? `${node.kind}-${node.ticket?.id ?? index}`} node={node} depth={0} />)}
        </ul>
      )}
    </section>
  );
}
