import type { TicketStatus, TicketSummary } from "../api/client.js";
import { StatusMark } from "./StatusMark.js";

export const STATUS_TEXT: Record<TicketStatus, string> = {
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  done: "Concluído",
  cancelled: "Cancelado",
};

/** Situação em texto; ticket com filhos mostra o progresso com a base (ADR 0024). */
export function describeTicketState(ticket: TicketSummary): string {
  if (ticket.progress) {
    const { done, total, excluded } = ticket.progress;
    const base = `${done} de ${total} concluídos`;
    return excluded > 0 ? `${base} · ${excluded} ${excluded === 1 ? "cancelado" : "cancelados"}` : base;
  }
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}

/** Marcador da situação do ticket: progresso quando tem filhos, situação própria nos demais. */
export function TicketMark({ ticket }: { ticket: TicketSummary }) {
  if (ticket.progress) return <StatusMark progress={ticket.progress} />;
  return ticket.status ? <StatusMark status={ticket.status} /> : null;
}

/** Texto curto da situação no card (sem a contagem de cancelados, que cabe no cartão de seleção). */
export function stateText(ticket: TicketSummary): string {
  if (ticket.progress) return `${ticket.progress.done} de ${ticket.progress.total} concluídos`;
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}
