import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { TicketStatus, TicketSummary } from "../api/client.js";
import { StatusMark } from "./StatusMark.js";

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
  return hasOpenDescendants(ticket) && ticket.progress ? progressText(t, ticket.progress) : statusText(t, ticket.status);
}

/**
 * Marcador do ticket: o de ideia na raiz e dentro dela (apagado quando a ideia foi descartada), o progresso quando há
 * descendente aberto, a situação própria nos demais casos.
 */
export function TicketMark({ ticket, discarded }: { ticket: Pick<TicketSummary, "status" | "progress"> & { idea?: TicketSummary["idea"] }; discarded?: boolean }) {
  if (ticket.idea) return <StatusMark idea={{ discarded: discarded ?? (ticket.idea.root && ticket.idea.stage === "discarded") }} />;
  if (hasOpenDescendants(ticket) && ticket.progress) return <StatusMark progress={ticket.progress} />;
  return <StatusMark status={ticket.status} />;
}

/**
 * Texto curto da situação no card (sem a contagem de cancelados, que cabe no cartão de seleção). `withIdeas`, só no card
 * mais detalhado: acrescenta " · n ideia(s)" quando há ideias abaixo (ADR 0042).
 */
export function cardStateText(t: TFunction<"map">, ticket: TicketSummary, options: { withIdeas?: boolean } = {}): string {
  const idea = ideaText(t, ticket);
  if (idea !== null) return idea;
  const base = hasOpenDescendants(ticket) && ticket.progress ? t("progress.base", { done: ticket.progress.done, total: ticket.progress.total }) : statusText(t, ticket.status);
  return options.withIdeas ? base + ideasSuffix(t, ticket) : base;
}
