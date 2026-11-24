import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { searchTickets } from "../command/search.js";

export interface Topic {
  id: string;
  key: string;
  title: string;
  projectId: string;
}

interface TicketTopicProps {
  value: Topic | null;
  onChange: (topic: Topic | null) => void;
  /** Os tickets de onde buscar, por projeto; `null` enquanto carregam. */
  tickets: Readonly<Record<string, readonly TicketSummary[]>> | null;
  failed: boolean;
  /** A lista não carregou: tenta de novo. */
  onRetry: () => void;
}

/** "Sobre o ticket…" (opcional): no chat geral, a thread aberta com alguém pode tratar de um ticket. Busca por chave ou título, como a barra do mapa. */
export function TicketTopic({ value, onChange, tickets, failed, onRetry }: TicketTopicProps) {
  const { t } = useTranslation("chat");
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (value !== null) {
    return (
      <p className="chat-topic">
        <span>{t("topic.about")}</span>
        <code>{value.key}</code>
        <span className="chat-topic-title">{value.title}</span>
        <button type="button" className="chat-text-button" aria-label={t("topic.remove", { key: value.key })} onClick={() => onChange(null)}>{t("topic.removeShort")}</button>
      </p>
    );
  }
  if (!editing) {
    return (
      <p className="chat-topic">
        <button type="button" className="chat-text-button" onClick={() => setEditing(true)}>{t("topic.add")}</button>
      </p>
    );
  }
  const found = tickets === null || text.trim() === "" ? [] : searchTickets(text, tickets);
  return (
    <div className="chat-topic">
      <label htmlFor={`${id}-search`}>{t("topic.label")}</label>
      <input id={`${id}-search`} type="search" autoComplete="off" autoFocus placeholder={t("topic.placeholder")} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} />
      {tickets === null && !failed && <p role="status" className="chat-hint">{t("topic.loading")}</p>}
      {failed && (
        <div className="chat-hint">
          <p role="alert">{t("topic.failed")}</p>
          <button type="button" className="chat-text-button" onClick={onRetry}>{t("topic.retry")}</button>
        </div>
      )}
      {tickets !== null && text.trim() !== "" && found.length === 0 && <p className="chat-hint">{t("topic.none")}</p>}
      <ul>
        {found.map((ticket) => (
          <li key={ticket.id}>
            <button type="button" onClick={() => { onChange({ id: ticket.id, key: ticket.key, title: ticket.title, projectId: ticket.projectId }); setEditing(false); setText(""); }}>
              <code>{ticket.key}</code> {ticket.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
