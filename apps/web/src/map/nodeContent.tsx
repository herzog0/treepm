import type { RenderNodeContent, SpatialNodeContent } from "@treepm/react";
import { plural } from "../plural.js";
import type { MapNode } from "./items.js";
import { DetailCard } from "./DetailCard.js";
import { useIsDetail } from "./detail.js";
import { TicketMark, stateText } from "./ticketState.js";

export { STATUS_TEXT, TicketMark, describeTicketState } from "./ticketState.js";

/**
 * Conteúdo do nó por nível de detalhe (ADR 0025): completo, compacto, chip e ponto; mais o "detalhe" da
 * ADR 0027, que só existe dentro do nível completo e é decidido por nó (ver `detail.tsx`).
 */
export const renderNodeContent: RenderNodeContent<MapNode> = (context) =>
  context.lod === "full" ? <FullContent context={context} /> : renderCardContent(context);

function FullContent({ context }: { context: SpatialNodeContent<MapNode> }) {
  const detail = useIsDetail(context.node.id);
  // O card do rascunho nunca usa o nível "detalhe": ele não é um ticket (ADR 0029).
  return detail && context.node.kind !== "draft" ? <DetailCard node={context.node} childCount={context.childCount} /> : renderCardContent(context);
}

function renderCardContent({ node, lod, childCount, aggregate, descendantCount }: SpatialNodeContent<MapNode>) {
  if (lod === "dot") return null;
  if (node.kind === "draft") return renderDraftContent(node, lod);
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
}

/** Card tracejado do rascunho da conversa com a IA (ADR 0029): não é um ticket, então não há marca de situação. */
function renderDraftContent(node: MapNode, lod: SpatialNodeContent<MapNode>["lod"]) {
  return (
    <span className="node-draft">
      {lod !== "chip" && <span className="spatial-key">{node.key}</span>}
      <strong>{node.label}</strong>
      {lod === "full" && <span className="node-state"><span>Ainda não criado</span></span>}
    </span>
  );
}
