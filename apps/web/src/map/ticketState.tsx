import type { TicketStatus, TicketSummary } from "../api/client.js";
import { StatusMark } from "./StatusMark.js";

export const STATUS_TEXT: Record<TicketStatus, string> = {
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  done: "Concluído",
  cancelled: "Cancelado",
};

/**
 * Agrupador sem nenhum ticket abaixo (progresso 0 de 0, sem cancelados) e sem itens: "vazio" (ADR 0031).
 * `itemCount` é o número de filhos diretos, quando quem chama o sabe; sem ele, vale só o progresso.
 */
export function isEmptyGroup(ticket: TicketSummary, itemCount?: number): boolean {
  const { progress } = ticket;
  return ticket.kind === "group" && progress !== null && progress.total === 0 && progress.excluded === 0 && (itemCount ?? 0) === 0;
}

/** Situação em texto; agrupador mostra o progresso com a base (ADR 0024) ou "vazio" (ADR 0031). */
export function describeTicketState(ticket: TicketSummary, itemCount?: number): string {
  if (isEmptyGroup(ticket, itemCount)) return "vazio";
  if (ticket.progress) {
    const { done, total, excluded } = ticket.progress;
    const base = `${done} de ${total} concluídos`;
    return excluded > 0 ? `${base} · ${excluded} ${excluded === 1 ? "cancelado" : "cancelados"}` : base;
  }
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}

/** Marcador do ticket: progresso no agrupador (vazio quando 0 de 0), situação própria no ticket. */
export function TicketMark({ ticket }: { ticket: TicketSummary }) {
  if (ticket.progress) return <StatusMark progress={ticket.progress} />;
  return ticket.status ? <StatusMark status={ticket.status} /> : null;
}

/** Texto curto da situação no card (sem a contagem de cancelados, que cabe no cartão de seleção). */
export function stateText(ticket: TicketSummary, itemCount?: number): string {
  if (isEmptyGroup(ticket, itemCount)) return "vazio";
  if (ticket.progress) return `${ticket.progress.done} de ${ticket.progress.total} concluídos`;
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}
