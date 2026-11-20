import type { RenderNodeContent } from "@treepm/react";
import type { TicketStatus, TicketSummary } from "../api/client.js";
import { plural } from "../plural.js";
import type { MapNode } from "./items.js";
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

/** Texto curto da situação no card completo (sem a contagem de cancelados, que cabe no cartão de seleção). */
function stateText(ticket: TicketSummary): string {
  if (ticket.progress) return `${ticket.progress.done} de ${ticket.progress.total} concluídos`;
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}

/** Conteúdo do nó por nível de detalhe (ADR 0025): completo, compacto, chip e ponto. */
export const renderNodeContent: RenderNodeContent<MapNode> = ({ node, lod, childCount, aggregate, descendantCount }) => {
  if (lod === "dot") return null;
  const ticket = node.ticket;
  const aggregateCount = aggregate && (
    <span className="spatial-aggregate-count">
      {node.kind === "organization" && descendantCount === childCount ? plural(descendantCount, "projeto", "projetos") : plural(descendantCount, "item", "itens")}
    </span>
  );

  if (lod === "chip") {
    return (
      <>
        {ticket && <TicketMark ticket={ticket} />}
        <strong>{node.label}</strong>
      </>
    );
  }

  return (
    <>
      <span className="spatial-key">{node.key ?? "Organização"}</span>
      <strong>{node.label}</strong>
      {ticket && (
        <span className="node-state">
          <TicketMark ticket={ticket} />
          {lod === "full" && <span>{stateText(ticket)}</span>}
        </span>
      )}
      {lod === "full" && node.kind === "organization" && (
        <span className="spatial-card-meta">{childCount} {childCount === 1 ? "projeto" : "projetos"}</span>
      )}
      {aggregateCount}
    </>
  );
};
