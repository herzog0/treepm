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

/** Progresso com a base no idioma ativo: "n de m concluídos", mais os cancelados quando há. */
export function progressText(t: TFunction<"map">, { done, total, excluded }: NonNullable<TicketSummary["progress"]>): string {
  return excluded > 0 ? t("progress.withCanceled", { done, total, count: excluded }) : t("progress.base", { done, total });
}

/** Situação em texto no idioma ativo: o progresso com a base quando há descendente aberto; senão, a situação própria. */
export function ticketStateText(t: TFunction<"map">, ticket: TicketSummary): string {
  return hasOpenDescendants(ticket) && ticket.progress ? progressText(t, ticket.progress) : statusText(t, ticket.status);
}

/** Marcador do ticket: progresso quando há descendente aberto, situação própria nos demais casos. */
export function TicketMark({ ticket }: { ticket: TicketSummary }) {
  if (hasOpenDescendants(ticket) && ticket.progress) return <StatusMark progress={ticket.progress} />;
  return <StatusMark status={ticket.status} />;
}

/** Texto curto da situação no card (sem a contagem de cancelados, que cabe no cartão de seleção). */
export function cardStateText(t: TFunction<"map">, ticket: TicketSummary): string {
  if (hasOpenDescendants(ticket) && ticket.progress) return t("progress.base", { done: ticket.progress.done, total: ticket.progress.total });
  return statusText(t, ticket.status);
}
