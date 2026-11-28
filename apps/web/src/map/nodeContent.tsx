import type { RenderNodeContent, SpatialNodeContent } from "@treepm/react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MapNode } from "./items.js";
import { DetailCard } from "./DetailCard.js";
import { useIsDetail } from "./detail.js";
import { AgentWorkMark } from "./agentWork.js";
import { CANCELLED_COLOR } from "./situation.js";
import { TicketMark, cardStateText, subtreeShortText, subtreeText } from "./ticketState.js";

// Nomes das situações para os outros diretórios: `useStatusText` / `statusText` (de `ticketState.tsx`, reexportados aqui).
export { TicketMark, progressText, statusText, ticketStateText, useStatusText } from "./ticketState.js";

/** Rótulo acessível de um nó de ticket: o nome, a IA quando trabalha nele, a marca de habilitador e os três números do pai (ADR 0069). */
export function ticketAriaLabel(t: TFunction<"map">, node: MapNode, working: boolean): string {
  const parts = [t(working ? "node.ticketWorking" : "node.ticket", { label: node.key ? `${node.key} · ${node.label}` : node.label })];
  if (node.enabler === true) parts.push(`${t("enabler")}.`);
  if (node.counts) parts.push(`${subtreeText(t, node.counts)}.`);
  return parts.join(" ");
}

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
  // O ponto não tem conteúdo; só o ticket em trabalho pela IA leva a marca do contorno (ADR 0043). Os três números do pai (ADR 0069)
  // ficam na dica do ponteiro, sem texto.
  if (lod === "dot") {
    const working = node.ticket?.agentWork ? <AgentWorkMark agentWork={node.ticket.agentWork} /> : null;
    if (!node.counts) return working;
    return (
      <>
        {working}
        <span className="node-dot-hint" title={subtreeText(t, node.counts)} />
      </>
    );
  }
  if (node.kind === "draft") return <DraftContent node={node} lod={lod} />;
  const ticket = node.ticket;
  // O pai que é ticket conta pelos três números (ADR 0069): o "n itens" do agregado fica para a organização e o projeto.
  const aggregateCount = aggregate && !node.counts && (
    <span className="spatial-aggregate-count">
      {node.kind === "organization" && descendantCount === childCount ? t("count.projects", { count: descendantCount }) : t("count.items", { count: descendantCount })}
    </span>
  );

  // Cancelado e ideia descartada são cinza e magenta apagados: o texto escuro do cartão colorido não leria sobre eles (ADR 0051).
  const ink = node.color === CANCELLED_COLOR || node.ideaDiscarded === true ? ({ color: "var(--tp-text)" } as const) : undefined;
  const working = ticket?.agentWork ? <AgentWorkMark agentWork={ticket.agentWork} /> : null;
  // Os três números do pai na forma curta (compacto e chip), com a frase inteira na dica do ponteiro (ADR 0069, seção 4).
  const shortCounts = node.counts && (
    <span className="node-counts" style={ink} title={subtreeText(t, node.counts)}>
      {subtreeShortText(node.counts)}
    </span>
  );

  const enablerMark = node.enabler === true && <span className="node-enabler" style={ink}>{t("enabler")}</span>;

  if (lod === "chip") {
    return (
      <>
        {working}
        {ticket && <TicketMark ticket={ticket} discarded={node.ideaDiscarded} />}
        <strong style={ink}>{node.label}</strong>
        {node.enabler === true && <span className="node-enabler" title={t("enabler")} />}
        {shortCounts}
      </>
    );
  }

  return (
    <>
      {working}
      {lod === "compact" && shortCounts ? (
        // No compacto pequeno o card corta as linhas de baixo: os números do pai ficam na de cima, ao lado da chave (ADR 0069).
        <span className="node-key-row">
          <span className="spatial-key" style={ink}>{node.key ?? t("organizationKey")}</span>
          {shortCounts}
        </span>
      ) : (
        <span className="spatial-key" style={ink}>{node.key ?? t("organizationKey")}</span>
      )}
      <strong style={ink}>{node.label}</strong>
      {ticket && (
        <span className="node-state" style={ink}>
          <TicketMark ticket={ticket} discarded={node.ideaDiscarded} />
          {lod === "full" && <span className={node.counts ? "node-counts-long" : undefined}>{cardStateText(t, ticket, { counts: node.counts })}</span>}
          {/* No compacto a linha do marcador tem espaço; abaixo dela o card corta (ADR 0069). */}
          {lod === "compact" && enablerMark}
        </span>
      )}
      {lod === "full" && enablerMark}
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
