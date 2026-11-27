import { useLayoutEffect, useRef } from "react";
import type { Person } from "../api/client.js";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toUpper } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { stripMarkdown } from "../ticket/description/excerpt.js";
import { AgentWorkMark } from "./agentWork.js";
import { useMapDetailData } from "./detail.js";
import type { LeafStatusCounts } from "./detail.js";
import type { MapNode } from "./items.js";
import { TicketMark, cardStateText } from "./ticketState.js";

const MAX_PEOPLE = 5;

/** Iniciais da pessoa: primeira e última palavra do nome; um nome só dá as duas primeiras letras. */
export function initialsOf(name: string, language: Language): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!;
  const letters = words.length === 1 ? Array.from(first).slice(0, 2) : [Array.from(first)[0]!, Array.from(words[words.length - 1]!)[0]!];
  return toUpper(language, letters.join(""));
}

function describeChildren(t: TFunction<"map">, node: MapNode, childCount: number): string {
  if (node.kind === "organization") return t("count.projects", { count: childCount });
  if (node.kind === "project") return t("count.itemsAtRoot", { count: childCount });
  return childCount === 0 ? "" : t("count.items", { count: childCount });
}

function describeLeaves(t: TFunction<"map">, counts: LeafStatusCounts | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.in_review) parts.push(t("leaves.in_review", { number: counts.in_review }));
  if (counts.in_progress) parts.push(t("leaves.in_progress", { number: counts.in_progress }));
  if (counts.todo) parts.push(t("leaves.todo", { number: counts.todo }));
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
  const { t, i18n } = useTranslation("map");
  const shown = ids.slice(0, MAX_PEOPLE);
  const hidden = ids.length - shown.length;
  return (
    <span className="node-detail-people">
      {shown.map((id) => {
        const person = people.get(id);
        const name = person?.displayName ?? t("person.unknown");
        return (
          <span key={id} role="img" aria-label={name} title={name} className="node-detail-person">
            {person ? initialsOf(person.displayName, i18n.language as Language) : "?"}
          </span>
        );
      })}
      {hidden > 0 && <span className="node-detail-more">+{hidden}</span>}
    </span>
  );
}

/** Card em nível "detalhe" (ADR 0027): o mesmo bloco do quadro aprovado, com as medidas dele em `map.css`. */
export function DetailCard({ node, childCount }: { node: MapNode; childCount: number }) {
  const { t } = useTranslation("map");
  const { people, leaves } = useMapDetailData();
  const ticket = node.ticket;
  // Um pai com os três números (ADR 0069) não repete "n itens": seriam dois números para a mesma pergunta.
  const more = node.counts ? "" : describeChildren(t, node, childCount);
  const breakdown = ticket ? describeLeaves(t, leaves.get(node.id)) : "";
  const excerpt = stripMarkdown(ticket?.descriptionExcerpt ?? "");
  return (
    <span className="node-detail">
      {ticket?.agentWork && <AgentWorkMark agentWork={ticket.agentWork} />}
      <span className="node-detail-top">
        <span className="spatial-key">{node.key ?? t("organizationKey")}</span>
        {more && <span className="node-detail-count">{more}</span>}
      </span>
      <strong className="node-detail-title">{node.label}</strong>
      {ticket && (
        <span className="node-detail-state">
          <TicketMark ticket={ticket} discarded={node.ideaDiscarded} />
          <span>{cardStateText(t, ticket, { withIdeas: true, counts: node.counts })}</span>
        </span>
      )}
      {node.enabler === true && <span className="node-enabler">{t("enabler")}</span>}
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
