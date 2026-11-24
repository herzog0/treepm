import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import "../map/status-mark.css";
import { TicketMark, useStatusText } from "../map/ticketState.js";
import { RichDescription } from "../ticket/description/RichDescription.js";
import { splitTicketRefs, withoutHashOfTickets } from "./mentions.js";

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]'"]+$/;

/** Só endereços `http(s)` completos viram link; nada é buscado nem carregado, e o que não é endereço fica como texto. */
function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

/** A chave de um ticket que a pessoa enxerga, como pastilha com a situação; abre o ticket do jeito que a aplicação já abre tickets. */
function TicketLink({ ticket, onOpen }: { ticket: TicketSummary; onOpen: (ticketId: string) => void }) {
  const { t } = useTranslation("chat");
  const statusText = useStatusText();
  // O mesmo papel (`link`) do elo da resposta do assistente, que vem do leitor de markdown da descrição.
  return (
    <span
      role="link"
      tabIndex={0}
      className="chat-ticket-link"
      aria-label={t("link.ticket", { key: ticket.key, title: ticket.title, status: statusText(ticket.status) })}
      title={ticket.title}
      onClick={() => onOpen(ticket.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onOpen(ticket.id);
      }}
    >
      <TicketMark ticket={ticket} />
      <span>{ticket.key}</span>
    </span>
  );
}

interface TicketRefs {
  /** Os tickets que a pessoa enxerga, por chave; sem isso `#CHAVE` é só texto. */
  byKey?: ReadonlyMap<string, TicketSummary>;
  onOpenTicket?: (ticketId: string) => void;
}

/**
 * Mensagem de pessoa (ADR 0049): texto puro com as quebras de linha; endereços http(s) reconhecidos viram link que só abre por clique,
 * em aba nova; `#CHAVE` de ticket visível vira elo (ADR 0056).
 */
export function PersonText({ text, byKey, onOpenTicket }: { text: string } & TicketRefs) {
  const parts: (string | { href: string; label: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const label = raw.replace(TRAILING, "");
    const href = safeHref(label);
    if (href === null || label === "") continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ href, label });
    last = match.index + label.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="chat-text">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <TextWithTickets key={index} text={part} byKey={byKey} onOpenTicket={onOpenTicket} />
        ) : (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.label}
          </a>
        ),
      )}
    </span>
  );
}

function TextWithTickets({ text, byKey, onOpenTicket }: { text: string } & TicketRefs) {
  if (byKey === undefined || onOpenTicket === undefined) return <>{text}</>;
  return (
    <>
      {splitTicketRefs(text, byKey).map((part, index) => (typeof part === "string" ? part : <TicketLink key={index} ticket={part.ticket} onOpen={onOpenTicket} />))}
    </>
  );
}

/**
 * A resposta do assistente: o leitor de markdown restrito da descrição do ticket (ADR 0036), que nunca cria imagem, HTML nem carrega nada
 * remoto; links só abrem por clique, em aba nova, com `rel="noopener noreferrer nofollow"`.
 */
export function AssistantText({ text, byKey, onOpenTicket }: { text: string } & TicketRefs) {
  const { t } = useTranslation("chat");
  // O `#` de uma chave que a pessoa enxerga some: a pastilha do leitor já diz a chave. Chave de ticket que ela não enxerga fica como veio.
  const shown = useMemo(() => (byKey === undefined ? text : withoutHashOfTickets(text, byKey)), [text, byKey]);
  const mentions = useMemo(() => (byKey === undefined || byKey.size === 0 ? undefined : { projectId: "", anyProject: true, tickets: [...byKey.values()], ...(onOpenTicket ? { onOpen: onOpenTicket } : {}) }), [byKey, onOpenTicket]);
  return <RichDescription className="is-answer" value={shown} editing={false} canEdit={false} label={t("assistant.reply")} placeholder="" {...(mentions ? { mentions } : {})} {...(onOpenTicket ? { onOpenMention: onOpenTicket } : {})} />;
}

/** Iniciais no lugar da foto: `avatarUrl` é endereço remoto e o chat não carrega nada de fora. */
export function Initials({ name }: { name: string }) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((word) => word.charAt(0).toLocaleUpperCase()).join("");
  return <span className="chat-initials" aria-hidden="true">{letters}</span>;
}
