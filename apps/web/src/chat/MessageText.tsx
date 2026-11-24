import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { scanPersonLinks } from "@treepm/domain";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import "../map/status-mark.css";
import { useStatusText } from "../map/ticketState.js";
import { RichDescription } from "../ticket/description/RichDescription.js";
import { ticketMentionAttrs } from "../ticket/description/decorations.js";
import "../ticket/description/description.css";
import { splitTicketRefs } from "./mentions.js";

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

/**
 * A chave de um ticket que a pessoa enxerga, com o mesmo desenho do item de menção do editor (situação, chave e título, ADR 0058);
 * abre o ticket do jeito que a aplicação já abre tickets.
 */
function TicketLink({ ticket, onOpen }: { ticket: TicketSummary; onOpen: (ticketId: string) => void }) {
  const statusText = useStatusText();
  // Os atributos são os do item do editor (`style` ali é texto de atributo HTML; em React, um objeto).
  const attrs: Record<string, string> = { ...ticketMentionAttrs(ticket, statusText) };
  delete attrs["style"];
  // O mesmo papel (`link`) do elo da resposta do assistente, que vem do leitor de markdown da descrição.
  return (
    <span
      role="link"
      tabIndex={0}
      className="description-mention"
      {...attrs}
      style={{ "--fill": attrs["data-fill"] } as CSSProperties}
      onClick={() => onOpen(ticket.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onOpen(ticket.id);
      }}
    >
      {ticket.key}
    </span>
  );
}

/** A pessoa marcada, com o destaque do item de menção do editor; quem saiu da organização fica com o nome guardado, sem destaque. */
function PersonMark({ id, name, names }: { id: string; name: string; names?: ReadonlyMap<string, string> | undefined }) {
  const current = names?.get(id);
  // Enquanto o diretório não chegou, o nome guardado aparece sem destaque: ainda não se sabe quem é.
  if (names === undefined) return <>@{name}</>;
  const gone = current === undefined;
  return (
    <span className={gone ? "mention-person is-gone" : "mention-person"} data-person-id={id}>
      @{current ?? name}
    </span>
  );
}

interface TicketRefs {
  /** Os tickets que a pessoa enxerga, por chave; sem isso `#CHAVE` é só texto. */
  byKey?: ReadonlyMap<string, TicketSummary>;
  onOpenTicket?: (ticketId: string) => void;
  /** O nome atual de cada pessoa da organização (o diretório); sem ele, o elo `person:` mostra o nome guardado na mensagem. */
  names?: ReadonlyMap<string, string> | undefined;
}

/**
 * Mensagem de pessoa (ADR 0049): texto puro com as quebras de linha; endereços http(s) reconhecidos viram link que só abre por clique,
 * em aba nova; `#CHAVE` de ticket visível vira elo (ADR 0056).
 */
export function PersonText({ text, byKey, onOpenTicket, names }: { text: string } & TicketRefs) {
  const links = scanPersonLinks(text);
  if (links.length === 0) return <PlainText text={text} byKey={byKey} onOpenTicket={onOpenTicket} />;
  // Os elos `[@Nome](person:id)` viram o destaque da pessoa; o texto entre eles segue as regras de sempre.
  const pieces: ReactNode[] = [];
  let at = 0;
  links.forEach((link, index) => {
    if (link.start > at) pieces.push(<PlainText key={`t${index}`} text={text.slice(at, link.start)} byKey={byKey} onOpenTicket={onOpenTicket} inner />);
    pieces.push(<PersonMark key={`p${index}`} id={link.id} name={link.name} names={names} />);
    at = link.end;
  });
  if (at < text.length) pieces.push(<PlainText key="rest" text={text.slice(at)} byKey={byKey} onOpenTicket={onOpenTicket} inner />);
  return <span className="chat-text">{pieces}</span>;
}

function PlainText({ text, byKey, onOpenTicket, inner }: { text: string; inner?: boolean } & TicketRefs) {
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
  const body = (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <TextWithTickets key={index} text={part} byKey={byKey} onOpenTicket={onOpenTicket} />
        ) : (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.label}
          </a>
        ),
      )}
    </>
  );
  return inner === true ? body : <span className="chat-text">{body}</span>;
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
  const mentions = useMemo(() => (byKey === undefined || byKey.size === 0 ? undefined : { projectId: "", anyProject: true, tickets: [...byKey.values()], ...(onOpenTicket ? { onOpen: onOpenTicket } : {}) }), [byKey, onOpenTicket]);
  return <RichDescription className="is-answer" value={text} editing={false} canEdit={false} label={t("assistant.reply")} placeholder="" {...(mentions ? { mentions } : {})} {...(onOpenTicket ? { onOpenMention: onOpenTicket } : {})} />;
}

export { Initials } from "../mentions/MentionPicker.js";
