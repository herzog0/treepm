import type { RenderNodeContent, SpatialNodeContent } from "@treepm/react";
import { useTranslation } from "react-i18next";
import type { MapNode } from "./items.js";
import { DetailCard } from "./DetailCard.js";
import { useIsDetail } from "./detail.js";
import { TicketMark, cardStateText } from "./ticketState.js";

// Nomes das situações para os outros diretórios: `useStatusText` / `statusText` (de `ticketState.tsx`, reexportados aqui).
// As antigas (`STATUS_TEXT`, `describeProgress`, `describeTicketState`) seguem exportadas até a limpeza final.
export { STATUS_TEXT, TicketMark, describeProgress, describeTicketState, progressText, statusText, ticketStateText, useStatusText } from "./ticketState.js";

/**
 * Conteúdo do nó por nível de detalhe (ADR 0025): completo, compacto, chip e ponto; mais o "detalhe" da
 * ADR 0027, que só existe dentro do nível completo e é decidido por nó (ver `detail.tsx`).
 */
export const renderNodeContent: RenderNodeContent<MapNode> = (context) =>
  context.lod === "full" ? <FullContent context={context} /> : <CardContent context={context} />;

function FullContent({ context }: { context: SpatialNodeContent<MapNode> }) {
  const detail = useIsDetail(context.node.id);
  // O card do rascunho nunca usa o nível "detalhe": ele não é um ticket (ADR 0029).
  return detail && context.node.kind !== "draft" ? <DetailCard node={context.node} childCount={context.childCount} /> : <CardContent context={context} />;
}

function CardContent({ context }: { context: SpatialNodeContent<MapNode> }) {
  const { t } = useTranslation("map");
  const { node, lod, childCount, aggregate, descendantCount } = context;
  if (lod === "dot") return null;
  if (node.kind === "draft") return <DraftContent node={node} lod={lod} />;
  const ticket = node.ticket;
  const aggregateCount = aggregate && (
    <span className="spatial-aggregate-count">
      {node.kind === "organization" && descendantCount === childCount ? t("count.projects", { count: descendantCount }) : t("count.items", { count: descendantCount })}
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
      <span className="spatial-key">{node.key ?? t("organizationKey")}</span>
      <strong>{node.label}</strong>
      {ticket && (
        <span className="node-state">
          <TicketMark ticket={ticket} />
          {lod === "full" && <span>{cardStateText(t, ticket)}</span>}
        </span>
      )}
      {lod === "full" && node.kind === "organization" && (
        <span className="spatial-card-meta">{t("count.projects", { count: childCount })}</span>
      )}
      {aggregateCount}
    </>
  );
}

/** Card tracejado do rascunho da conversa com a IA (ADR 0029): não é um ticket, então não há marca de situação. */
function DraftContent({ node, lod }: { node: MapNode; lod: SpatialNodeContent<MapNode>["lod"] }) {
  const { t } = useTranslation("map");
  return (
    <span className="node-draft">
      {lod !== "chip" && <span className="spatial-key">{node.key}</span>}
      <strong>{node.label}</strong>
      {lod === "full" && <span className="node-state"><span>{t("draft.notCreated")}</span></span>}
    </span>
  );
}
