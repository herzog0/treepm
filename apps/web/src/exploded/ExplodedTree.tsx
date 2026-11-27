import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { explodedTree, isFinished } from "@treepm/domain";
import type { ExplodedNode } from "@treepm/domain";
import { useSpatialCamera } from "@treepm/react";
import type { TicketSummary } from "../api/client.js";
import { dependencyEdges } from "../map/items.js";
import type { MapNode } from "../map/items.js";
import { ticketAriaLabel } from "../map/nodeContent.js";
import { SelectionArrows } from "../map/SelectionArrows.js";
import type { Arrow, ArrowLink } from "../map/arrows.js";
import { CANCELLED_COLOR } from "../map/situation.js";
import { TicketMark, cardStateText } from "../map/ticketState.js";
import type { ExplodedFocus } from "./focus.js";
import { arrowEnds, cameraLayout, cardBox, cardLevel, hangPath, onScreen, segmentOnScreen } from "./geometry.js";
import type { Box } from "./geometry.js";
import "./exploded.css";

export interface ExplodedTreeProps {
  /** Os tickets do projeto em foco, como a lista do projeto os traz (com as dependências, ADR 0069). */
  readonly tickets: readonly TicketSummary[];
  /** Os nós do mapa por id: a cor, a marca de habilitador e os números do pai saem deles, para o card ser o do mapa. */
  readonly nodes: ReadonlyMap<string, MapNode>;
  readonly focus: ExplodedFocus;
  readonly selectedId: string | null;
  /** O modo "Cores" do mapa (o mesmo atalho C). */
  readonly filled: boolean;
  /** Clique num card: o mesmo do mapa (seleciona e abre o ticket). */
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onToggleColors: () => void;
  /** O caminho até o foco (o projeto, os pais, o foco), para subir; o último é o foco. */
  readonly focusPath: readonly { readonly id: string; readonly label: string }[];
  /** O pai do ticket selecionado, quando ele não é o foco: "Ver só <pai>" leva o foco para ele. */
  readonly narrowTo: { readonly id: string; readonly label: string } | null;
  /** Leva o foco do mapa para o nó (o mesmo foco do mapa, ADR 0070, seção 2). */
  readonly onFocus: (id: string) => void;
}

/** A câmera do mapa vai até bem longe aqui: um projeto grande vira uma grade larga e alta (ADR 0070, Consequências). */
const CAMERA_OPTIONS = { minScale: 0.005 };

/**
 * A árvore explodida (ADR 0070): o projeto (ou um ticket com filhos) como caminho, da esquerda para a direita. Os cards ficam parados no
 * mundo; a câmera do mapa (`useSpatialCamera`, sem mudança) move e escala, com a roda no ponto do cursor e o arrasto. Só o que está na
 * tela é desenhado. Os eventos de ponteiro e de roda param aqui: o mapa embaixo não se move.
 */
export function ExplodedTree({ tickets, nodes, focus, selectedId, filled, onSelect, onClearSelection, onToggleColors, focusPath, narrowTo, onFocus }: ExplodedTreeProps) {
  const { t } = useTranslation("map");
  const edges = useMemo(() => dependencyEdges(tickets), [tickets]);
  const tree = useMemo(() => {
    const orderNodes = tickets.map((ticket) => ({
      id: ticket.id,
      parentId: ticket.parentId,
      status: ticket.status,
      ideaStage: ticket.idea?.root === true ? ticket.idea.stage : null,
      number: ticket.number,
      priority: ticket.priority ?? 0,
    }));
    return explodedTree(orderNodes, edges, focus.ticketId);
  }, [tickets, edges, focus.ticketId]);
  const byId = useMemo(() => new Map(tickets.map((ticket) => [ticket.id, ticket] as const)), [tickets]);
  const boxes = useMemo(() => new Map(tree.nodes.map((node) => [node.id, cardBox(node)] as const)), [tree]);
  const layout = useMemo(() => cameraLayout(tree.columns, tree.rows), [tree.columns, tree.rows]);

  const stageRef = useRef<HTMLDivElement>(null);
  const camera = useSpatialCamera(layout, stageRef, CAMERA_OPTIONS);
  const { scale } = camera.camera;
  // Enquadra a grade inteira ao abrir e a cada mudança de tamanho, até a pessoa mexer na câmera.
  const moved = useRef(false);
  const fitAll = useRef(camera.fitBounds);
  fitAll.current = camera.fitBounds;
  useLayoutEffect(() => {
    if (!moved.current) fitAll.current(layout.bounds, true);
  }, [camera.size.width, camera.size.height, layout]);
  // A roda chega primeiro à câmera desta tela (no mesmo elemento) e para aqui: o mapa embaixo não recebe.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const stop = (event: WheelEvent) => {
      moved.current = true;
      event.stopPropagation();
    };
    stage.addEventListener("wheel", stop, { passive: true });
    return () => stage.removeEventListener("wheel", stop);
  }, []);
  const handlers = camera.gestureHandlers;
  const stopped = <E extends SyntheticEvent>(handler: (event: E) => void) => (event: E) => {
    handler(event);
    event.stopPropagation();
  };

  const size = camera.size;
  const visible = tree.nodes.filter((node) => onScreen(boxes.get(node.id)!, camera.camera, size));
  const level = cardLevel(scale);
  const hangs = tree.nodes.flatMap((node) => {
    if (node.hangOn === null) return [];
    const from = boxes.get(node.hangOn);
    const to = boxes.get(node.id);
    return from && to && segmentOnScreen(from, to, camera.camera, size) ? [{ key: node.id, path: hangPath(from, to, camera.camera) }] : [];
  });
  const arrows = selectionArrows(selectedId, byId, edges, boxes, camera.camera);

  return (
    <div className="exploded" data-filled={filled ? "true" : "false"}>
      <div
        ref={stageRef}
        className={`exploded-stage ${camera.isDragging ? "is-dragging" : ""}`}
        role="region"
        aria-label={t("exploded.canvas")}
        onPointerDown={stopped((event) => {
          moved.current = true;
          handlers.onPointerDown(event);
        })}
        onPointerMove={stopped(handlers.onPointerMove)}
        onPointerUp={stopped(handlers.onPointerUp)}
        onPointerCancel={stopped(handlers.onPointerCancel)}
        onLostPointerCapture={stopped(handlers.onLostPointerCapture)}
        onClickCapture={handlers.onClickCapture}
        onDragStartCapture={handlers.onDragStartCapture}
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) onClearSelection();
        }}
      >
        {tree.nodes.length === 0 ? (
          <p className="exploded-empty">{t("exploded.empty")}</p>
        ) : (
          <>
            <svg className="exploded-hangs" aria-hidden="true" focusable="false">
              {hangs.map((hang) => (
                <path key={hang.key} className="exploded-hang" d={hang.path} />
              ))}
            </svg>
            <div className="exploded-world" style={{ transform: `translate(${camera.camera.x}px, ${camera.camera.y}px) scale(${scale})` }}>
              {visible.map((node) => (
                <ExplodedCard
                  key={node.id}
                  node={node}
                  box={boxes.get(node.id)!}
                  mapNode={nodes.get(node.id)}
                  parentTitle={parentTitle(byId, node.id)}
                  dimmedText={node.outside ? t(insideFocus(byId, node.id, focus.ticketId) ? "exploded.parent" : "exploded.outside") : null}
                  level={level}
                  selected={selectedId === node.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
            <SelectionArrows arrows={arrows} />
          </>
        )}
      </div>
      <div className="exploded-focus" onPointerDown={(event) => event.stopPropagation()}>
        <nav aria-label={t("exploded.focusPath")}>
          {focusPath.map((item, position) => (
            <span key={item.id}>
              {position > 0 && <i aria-hidden="true">›</i>}
              <button type="button" aria-current={position === focusPath.length - 1 ? "location" : undefined} onClick={() => onFocus(item.id)}>
                {item.label}
              </button>
            </span>
          ))}
        </nav>
        {narrowTo !== null && (
          <button type="button" className="exploded-narrow" onClick={() => onFocus(narrowTo.id)}>
            {t("exploded.narrow", { name: narrowTo.label })}
          </button>
        )}
      </div>
      <div className="spatial-toolbar exploded-toolbar" role="toolbar" aria-label={t("canvas.toolbar")} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => camera.zoomBy(-1)} aria-label={t("canvas.zoomOut")}>−</button>
        <button type="button" onClick={() => camera.fitBounds(layout.bounds)} aria-label={t("canvas.reset")}>⌂</button>
        <button type="button" onClick={() => camera.zoomBy(1)} aria-label={t("canvas.zoomIn")}>+</button>
        <button type="button" className="spatial-color-toggle" onClick={onToggleColors} aria-pressed={filled} aria-keyshortcuts="C">{t("canvas.colors")}</button>
      </div>
      <div className="spatial-help exploded-help">{t("exploded.help")}</div>
    </div>
  );
}

/**
 * O ticket está dentro do foco? Um card apagado dentro do foco é um ticket com filhos (a árvore só mostra os sem filhos); fora dele, é
 * uma dependência que aponta para fora (ADR 0070, seção 6). A lista é a do projeto: com o projeto em foco, tudo está dentro.
 */
function insideFocus(byId: ReadonlyMap<string, TicketSummary>, id: string, focusId: string | null): boolean {
  if (focusId === null) return true;
  const seen = new Set<string>();
  for (let up = byId.get(id)?.parentId ?? null; up !== null && !seen.has(up); up = byId.get(up)?.parentId ?? null) {
    if (up === focusId) return true;
    seen.add(up);
  }
  return false;
}

/** O título do pai direto do ticket (ADR 0070, seção 2); nulo na raiz do projeto. */
function parentTitle(byId: ReadonlyMap<string, TicketSummary>, id: string): string | null {
  const parentId = byId.get(id)?.parentId ?? null;
  return parentId === null ? null : (byId.get(parentId)?.title ?? null);
}

/**
 * As setas do ticket selecionado (ADR 0070, seção 5): todas as dependências dele, nos dois sentidos, com as cores e o tracejado da ADR 0069.
 * Só entre cards que aparecem na árvore: quem depende dele e está fora do foco não tem card.
 */
function selectionArrows(
  selectedId: string | null,
  byId: ReadonlyMap<string, TicketSummary>,
  edges: ReturnType<typeof dependencyEdges>,
  boxes: ReadonlyMap<string, Box>,
  camera: { x: number; y: number; scale: number },
): Arrow[] {
  const selected = selectedId === null ? undefined : boxes.get(selectedId);
  if (selectedId === null || !selected) return [];
  const finished = (id: string) => isFinished(byId.get(id)?.status ?? "todo");
  const arrows: Arrow[] = [];
  for (const edge of edges) {
    const waits = edge.from === selectedId;
    if (!waits && edge.to !== selectedId) continue;
    const otherId = waits ? edge.to : edge.from;
    const other = boxes.get(otherId);
    if (!other) continue;
    const link: ArrowLink = { id: otherId, need: edge.need, finished: finished(otherId) };
    const ends = waits ? arrowEnds(other, selected, camera) : arrowEnds(selected, other, camera);
    arrows.push({ key: `${waits ? "waits" : "unlocks"}:${otherId}`, kind: waits ? "waits" : "unlocks", need: link.need, finished: link.finished, ...ends });
  }
  return arrows;
}

interface CardProps {
  readonly node: ExplodedNode;
  readonly box: Box;
  readonly mapNode: MapNode | undefined;
  readonly parentTitle: string | null;
  /** O texto do card apagado: "Fora do foco" ou "Ticket com filhos"; nulo num card comum. */
  readonly dimmedText: string | null;
  readonly level: "card" | "block";
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

/**
 * O card da árvore explodida, o mesmo do mapa (ADR 0070, seção 8): a cor da situação ou do lugar na fila, o texto do lugar, o vermelho do
 * bloqueado, a marca de habilitador; mais o pai direto em texto pequeno. Com o zoom longe, só o retângulo com a cor. Memorizado: mover a
 * câmera não refaz o conteúdo.
 */
const ExplodedCard = memo(function ExplodedCard({ node, box, mapNode, parentTitle, dimmedText, level, selected, onSelect }: CardProps) {
  const { t } = useTranslation("map");
  const ticket = mapNode?.ticket ?? null;
  if (!mapNode || !ticket) return null;
  const label = ticketAriaLabel(t, mapNode, false) + (dimmedText !== null ? ` ${dimmedText}.` : "");
  const muted = mapNode.color === CANCELLED_COLOR || mapNode.ideaDiscarded === true;
  const style = { left: box.x, top: box.y, width: box.width, height: box.height, "--card-color": mapNode.color } as CSSProperties;
  return (
    <button
      type="button"
      className="exploded-card"
      data-level={level}
      data-outside={node.outside ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      style={style}
      aria-label={label}
      aria-pressed={selected}
      title={level === "block" ? label : undefined}
      onClick={() => onSelect(node.id)}
    >
      {level === "card" && (
        <>
          <span className="exploded-card-top">
            <span className="spatial-key">{mapNode.key}</span>
            {parentTitle !== null && <span className="exploded-card-parent">{parentTitle}</span>}
          </span>
          <strong>{mapNode.label}</strong>
          <span className="node-state">
            <TicketMark ticket={ticket} discarded={mapNode.ideaDiscarded} />
            <span>{cardStateText(t, ticket, { counts: mapNode.counts })}</span>
            {mapNode.enabler === true && <span className="node-enabler">{t("enabler")}</span>}
          </span>
          {dimmedText !== null && <span className="exploded-outside">{dimmedText}</span>}
        </>
      )}
    </button>
  );
});
