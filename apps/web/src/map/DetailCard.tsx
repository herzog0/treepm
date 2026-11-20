import { useLayoutEffect, useRef } from "react";
import type { Person } from "../api/client.js";
import { plural } from "../plural.js";
import { useMapDetailData } from "./detail.js";
import type { LeafStatusCounts } from "./detail.js";
import type { MapNode } from "./items.js";
import { TicketMark, stateText } from "./ticketState.js";

const MAX_PEOPLE = 5;

/** Iniciais da pessoa: primeira e última palavra do nome; um nome só dá as duas primeiras letras. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!;
  const letters = words.length === 1 ? Array.from(first).slice(0, 2) : [Array.from(first)[0]!, Array.from(words[words.length - 1]!)[0]!];
  return letters.join("").toLocaleUpperCase("pt-BR");
}

function describeChildren(node: MapNode, childCount: number): string {
  if (node.kind === "organization") return plural(childCount, "projeto", "projetos");
  if (node.kind === "project") return `${childCount} ${childCount === 1 ? "ticket" : "tickets"} na raiz`;
  return childCount === 0 ? "" : plural(childCount, "subticket", "subtickets");
}

function describeLeaves(counts: LeafStatusCounts | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.in_review) parts.push(`${counts.in_review} em revisão`);
  if (counts.in_progress) parts.push(`${counts.in_progress} em andamento`);
  if (counts.todo) parts.push(`${counts.todo} a fazer`);
  return parts.join(" · ");
}

/**
 * O trecho da descrição ocupa a altura que sobra no card e termina em reticências na última linha inteira que
 * cabe. A altura muda a cada quadro de zoom e o conteúdo não se redesenha, então a conta é feita no próprio
 * elemento, por observador de tamanho, sem passar pelo React.
 */
function Description({ text }: { text: string }) {
  const area = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const outer = area.current;
    const inner = body.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(inner).lineHeight);
      if (!(lineHeight > 0)) return;
      const lines = Math.max(1, Math.floor(outer.clientHeight / lineHeight));
      inner.style.setProperty("-webkit-line-clamp", String(lines));
      inner.style.maxHeight = `${lines * lineHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={area} className="node-detail-description">
      <span ref={body}>{text}</span>
    </span>
  );
}

function People({ ids, people }: { ids: readonly string[]; people: ReadonlyMap<string, Person> }) {
  const shown = ids.slice(0, MAX_PEOPLE);
  const hidden = ids.length - shown.length;
  return (
    <span className="node-detail-people">
      {shown.map((id) => {
        const person = people.get(id);
        const name = person?.displayName ?? "Pessoa desconhecida";
        return (
          <span key={id} role="img" aria-label={name} title={name} className="node-detail-person">
            {person ? initialsOf(person.displayName) : "?"}
          </span>
        );
      })}
      {hidden > 0 && <span className="node-detail-more">+{hidden}</span>}
    </span>
  );
}

/** Card em nível "detalhe" (ADR 0027): o mesmo bloco do quadro aprovado, com as medidas dele em `map.css`. */
export function DetailCard({ node, childCount }: { node: MapNode; childCount: number }) {
  const { people, leaves } = useMapDetailData();
  const ticket = node.ticket;
  const more = describeChildren(node, childCount);
  const breakdown = ticket ? describeLeaves(leaves.get(node.id)) : "";
  const excerpt = ticket?.descriptionExcerpt ?? "";
  return (
    <span className="node-detail">
      <span className="node-detail-top">
        <span className="spatial-key">{node.key ?? "Organização"}</span>
        {more && <span className="node-detail-count">{more}</span>}
      </span>
      <strong className="node-detail-title">{node.label}</strong>
      {ticket && (
        <span className="node-detail-state">
          <TicketMark ticket={ticket} />
          <span>{stateText(ticket)}</span>
        </span>
      )}
      {excerpt !== "" && <Description text={excerpt} />}
      {ticket && (ticket.assigneeIds.length > 0 || breakdown !== "") && (
        <span className="node-detail-footer">
          {ticket.assigneeIds.length > 0 && <People ids={ticket.assigneeIds} people={people} />}
          {breakdown !== "" && <span className="node-detail-breakdown">{breakdown}</span>}
        </span>
      )}
    </span>
  );
}
