import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { TicketStatus, TicketSummary } from "../api/client.js";
import { effectiveSituation } from "./situation.js";
import { StatusMark } from "./StatusMark.js";
import type { SubtreeCounts } from "./items.js";

/** Os três números do pai por extenso (ADR 0069, seção 4): "31 tickets · 12 prontos · 2 livres". */
export const subtreeText = (t: TFunction<"map">, counts: SubtreeCounts): string =>
  [t("subtree.tickets", { count: counts.tickets }), t("subtree.done", { count: counts.done }), t("subtree.free", { count: counts.free })].join(" · ");
/** A forma curta, para os cards pequenos (compacto e chip): "31 · 12 · 2", na mesma ordem; a frase inteira vai na dica do ponteiro. */
export const subtreeShortText = (counts: SubtreeCounts): string => [counts.tickets, counts.done, counts.free].join(" · ");

/**
 * O ticket tem algum descendente aberto (ADR 0034)? `progress` conta todos os descendentes, em qualquer nível, sem os
 * cancelados na base: sobra trabalho quando `done < total`. Ticket sem filhos, ou com tudo finalizado, não tem.
 */
export function hasOpenDescendants(ticket: Pick<TicketSummary, "progress">): boolean {
  return ticket.progress !== null && ticket.progress.done < ticket.progress.total;
}

/**
 * Nome da situação no idioma ativo (catálogo `map`). É o caminho único das cinco situações para os outros
 * diretórios: em componente use `useStatusText()`; fora, `statusText(t, status)` com `t` de `useTranslation("map")`.
 */
export const statusText = (t: TFunction<"map">, status: TicketStatus): string => t(`status.${status}`);
export function useStatusText(): (status: TicketStatus) => string {
  const { t } = useTranslation("map");
  return (status) => statusText(t, status);
}

/**
 * A situação própria em texto: o lugar na fila num "a fazer" que tem um (livre, próximo, esperando; ADR 0069), para a cor do
 * lugar não ser o único sinal; senão, o nome da situação gravada.
 */
const ownStateText = (t: TFunction<"map">, ticket: Pick<TicketSummary, "status" | "place">): string =>
  ticket.status === "todo" && ticket.place != null ? t(`status.${ticket.place}`) : statusText(t, ticket.status);

/** O ticket está bloqueado (ADR 0051, com a ADR 0068): tem impedimento marcado e não está concluído nem cancelado; ideia não é pintada de bloqueado. */
export const isBlocked = (ticket: Pick<TicketSummary, "status" | "blocked"> & { idea?: TicketSummary["idea"] }): boolean => !ticket.idea && effectiveSituation(ticket) === "blocked";

/** "Bloqueado · <estado>": o sinal escrito, para a cor não ser o único (ADR 0051). */
const withBlocked = (t: TFunction<"map">, ticket: Pick<TicketSummary, "status" | "blocked"> & { idea?: TicketSummary["idea"] }, text: string): string =>
  isBlocked(ticket) ? `${t("status.blocked")} · ${text}` : text;

/**
 * O ticket está numa ideia descartada (a raiz ou algo dentro dela, ADR 0042)? Sobe pelos pais na lista; uma ideia dentro de
 * uma ideia descartada também conta.
 */
export function isInDiscardedIdea(ticket: TicketSummary, byId: ReadonlyMap<string, TicketSummary>): boolean {
  if (!ticket.idea) return false;
  for (let at: TicketSummary | undefined = ticket; at; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    if (at.idea?.root === true && at.idea.stage === "discarded") return true;
  }
  return false;
}

/** " · n ideia(s)" quando o ticket tem ideias abaixo (ADR 0042); vazio sem elas. */
export const ideasSuffix = (t: TFunction<"map">, ticket: Pick<TicketSummary, "progress">): string => {
  const count = ticket.progress?.ideas ?? 0;
  return count > 0 ? ` · ${t("idea.count", { count })}` : "";
};

/** Texto de um ticket em ideia: "Ideia · <estágio>" na raiz, "Ideia" dentro dela (ADR 0042); `null` num ticket comum. */
export function ideaText(t: TFunction<"map">, ticket: Pick<TicketSummary, "idea">): string | null {
  if (!ticket.idea) return null;
  return ticket.idea.root ? t("idea.root", { stage: t(`idea.stage.${ticket.idea.stage}`) }) : t("idea.inside");
}

/** Progresso com a base no idioma ativo: "n de m concluídos", mais os cancelados quando há e as ideias à parte. */
export function progressText(t: TFunction<"map">, progress: NonNullable<TicketSummary["progress"]>): string {
  const { done, total, excluded } = progress;
  const base = excluded > 0 ? t("progress.withCanceled", { done, total, count: excluded }) : t("progress.base", { done, total });
  return base + ideasSuffix(t, { progress });
}

/** Situação em texto no idioma ativo: a ideia, se for; o progresso com a base quando há descendente aberto; senão, a situação própria. */
export function ticketStateText(t: TFunction<"map">, ticket: TicketSummary): string {
  const idea = ideaText(t, ticket);
  if (idea !== null) return idea;
  return withBlocked(t, ticket, hasOpenDescendants(ticket) && ticket.progress ? progressText(t, ticket.progress) : isBlocked(ticket) ? statusText(t, ticket.status) : ownStateText(t, ticket));
}

/**
 * Marcador do ticket: o de ideia na raiz e dentro dela (apagado quando a ideia foi descartada), o progresso quando há
 * descendente aberto, a situação própria nos demais casos.
 */
export function TicketMark({ ticket, discarded }: { ticket: Pick<TicketSummary, "status" | "progress" | "blocked"> & { idea?: TicketSummary["idea"]; place?: TicketSummary["place"] }; discarded?: boolean }) {
  if (ticket.idea) return <StatusMark idea={{ discarded: discarded ?? (ticket.idea.root && ticket.idea.stage === "discarded") }} />;
  if (hasOpenDescendants(ticket) && ticket.progress) return <StatusMark progress={ticket.progress} blocked={isBlocked(ticket)} />;
  return <StatusMark status={ticket.status} blocked={isBlocked(ticket)} place={ticket.place ?? null} />;
}

/**
 * Texto curto da situação no card (sem a contagem de cancelados, que cabe no cartão de seleção). `withIdeas`, só no card
 * mais detalhado: acrescenta " · n ideia(s)" quando há ideias abaixo (ADR 0042). `counts`: os três números do pai (ADR 0069).
 */
export function cardStateText(t: TFunction<"map">, ticket: TicketSummary, options: { withIdeas?: boolean; counts?: SubtreeCounts | undefined } = {}): string {
  const idea = ideaText(t, ticket);
  if (idea !== null) return idea;
  // Num pai, os três números (ADR 0069) já dizem quantos estão prontos: tomam o lugar de "N de M concluídos". Com tudo finalizado
  // abaixo, a situação do pai vem antes deles, como vinha sozinha.
  const base = options.counts
    ? hasOpenDescendants(ticket)
      ? subtreeText(t, options.counts)
      : `${statusText(t, ticket.status)} · ${subtreeText(t, options.counts)}`
    : hasOpenDescendants(ticket) && ticket.progress
      ? t("progress.base", { done: ticket.progress.done, total: ticket.progress.total })
      : isBlocked(ticket)
        ? statusText(t, ticket.status)
        : ownStateText(t, ticket);
  const text = withBlocked(t, ticket, base);
  return options.withIdeas ? text + ideasSuffix(t, ticket) : text;
}
