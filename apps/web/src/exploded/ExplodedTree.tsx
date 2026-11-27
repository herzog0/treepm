import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { explodedTree, isFinished } from "@treepm/domain";
import type { ExplodedNode } from "@treepm/domain";
import { useSpatialCamera } from "@treepm/react";
import type { TicketSummary } from "../api/client.js";
import { dependencyEdges } from "../map/items.js";
import { SelectionArrows } from "../map/SelectionArrows.js";
import type { Arrow } from "../map/arrows.js";
import { cardText, firstCamera, headline } from "./cards.js";
import type { ExplodedFocus } from "./focus.js";
import { COLUMN_WIDTH, arrowEnds, cameraLayout, cardBox, cardLevel, hangPath, onScreen, segmentOnScreen } from "./geometry.js";
import type { Box, Camera } from "./geometry.js";
import "./exploded.css";

export interface ExplodedTreeProps {
  /** Os tickets do projeto em foco, como a lista do projeto os traz (com as dependências, ADR 0069). */
  readonly tickets: readonly TicketSummary[];
  readonly focus: ExplodedFocus;
  readonly selectedId: string | null;
  /** Clique num card: o mesmo do mapa (seleciona e abre o ticket). */
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  /** O caminho até o foco (o projeto, os pais, o foco), para subir; o último é o foco. */
  readonly focusPath: readonly { readonly id: string; readonly label: string }[];
  /** O pai do ticket selecionado, quando ele não é o foco: "Ver só <pai>" leva o foco para ele. */
  readonly narrowTo: { readonly id: string; readonly label: string } | null;
  /** Leva o foco do mapa para o nó (o mesmo foco do mapa, ADR 0070, seção 2). */
  readonly onFocus: (id: string) => void;
}

/** A câmera do mapa vai até bem longe aqui: um projeto grande vira uma grade larga e alta (ADR 0070, Consequências). */
const CAMERA_OPTIONS = { minScale: 0.005 };
/** Quantas chaves a manchete mostra por parte antes de "+N". */
const HEADLINE_KEYS = 8;

/**
 * O tom do card, numa paleta só desta visão: livre e próximo nas cores fortes; esperando num neutro calmo; em andamento, em revisão,
 * concluído e bloqueado em tons calmos que guardam o sentido (os tokens `--tp-tree-*` de `theme.css`).
 */
export type CardTone = "free" | "next" | "waiting" | "doing" | "review" | "done" | "cancelled" | "blocked";
export function cardTone(ticket: Pick<TicketSummary, "status" | "blocked">, place: ExplodedNode["place"]): CardTone {
  if (ticket.status === "done") return "done";
  if (ticket.status === "cancelled") return "cancelled";
  if (ticket.blocked === true) return "blocked";
  if (place === "free") return "free";
  if (place === "next") return "next";
  if (ticket.status === "in_progress") return "doing";
  if (ticket.status === "in_review") return "review";
  return "waiting";
}

/** O nome da situação do card, para o rótulo acessível: o tom, que já diz o lugar na fila ou a situação. */
const toneText = (t: TFunction<"map">, tone: CardTone) => t(`status.${tone === "doing" ? "in_progress" : tone === "review" ? "in_review" : tone}`);

/**
 * A árvore explodida (ADR 0070): o projeto (ou um ticket com filhos) como caminho, da esquerda para a direita, lida como o quadro de
 * referência do dono: cards pequenos com o código e o título, colunas de passo com cabeçalho, uma seta suave por ticket e a manchete
 * do que pegar agora. Os cards ficam parados no mundo; a câmera do mapa (`useSpatialCamera`, sem mudança) move e escala. Só o que está
 * na tela é desenhado. Os eventos de ponteiro e de roda param aqui: o mapa embaixo não se move.
 */
export function ExplodedTree({ tickets, focus, selectedId, onSelect, onClearSelection, focusPath, narrowTo, onFocus }: ExplodedTreeProps) {
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
  const lead = useMemo(() => headline(tree.nodes, byId), [tree, byId]);
  const nowIds = useMemo(() => tree.nodes.filter((node) => !node.outside && node.place === "free" && byId.get(node.id)?.blocked !== true).map((node) => node.id), [tree, byId]);

  const stageRef = useRef<HTMLDivElement>(null);
  const camera = useSpatialCamera(layout, stageRef, CAMERA_OPTIONS);
  const { scale } = camera.camera;
  // A primeira vista, ao abrir e a cada mudança de tamanho, até a pessoa mexer na câmera: numa escala de leitura, com o passo 0 na
  // borda esquerda e o primeiro "pegue agora" na altura do meio. O ⌂ enquadra a árvore inteira.
  const moved = useRef(false);
  const live = useRef({ camera, layout, tree, nowIds });
  live.current = { camera, layout, tree, nowIds };
  useLayoutEffect(() => {
    if (moved.current) return;
    const { camera: current, layout: grid, tree: shown, nowIds: now } = live.current;
    const target = firstCamera(shown.nodes, shown.columns, shown.rows, current.size, now);
    if ("fitAll" in target) {
      current.fitBounds(grid.bounds, true);
      return;
    }
    // A câmera do pacote não tem um "vá para": `fitBounds` com a escala pedida e um nó de mentira no centro dá a mesma câmera.
    const center = { x: (current.size.width / 2 - target.x) / target.scale, y: (current.size.height / 2 - target.y) / target.scale };
    const point = { ...grid.nodes[0]!, x: center.x, y: center.y, height: 0 };
    current.fitBounds(grid.bounds, true, undefined, target.scale, point);
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
  const list = (keys: readonly string[]) =>
    keys.length === 0 ? t("exploded.nothing") : keys.slice(0, HEADLINE_KEYS).join(", ") + (keys.length > HEADLINE_KEYS ? ` ${t("exploded.more", { count: keys.length - HEADLINE_KEYS })}` : "");

  return (
    <div className="exploded">
      {tree.nodes.length > 0 && (
        <p className="exploded-headline" aria-live="polite">
          {t("exploded.headline", { now: list(lead.now), next: list(lead.next) })}
        </p>
      )}
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
              <defs>
                <marker id="exploded-hang-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" />
                </marker>
              </defs>
              {hangs.map((hang) => (
                <path key={hang.key} className="exploded-hang" d={hang.path} markerEnd="url(#exploded-hang-head)" />
              ))}
            </svg>
            <div className="exploded-world" style={{ transform: `translate(${camera.camera.x}px, ${camera.camera.y}px) scale(${scale})` }}>
              {visible.map((node) => {
                const ticket = byId.get(node.id);
                if (!ticket) return null;
                const parent = ticket.parentId === null ? undefined : byId.get(ticket.parentId);
                return (
                  <TreeCard
                    key={node.id}
                    node={node}
                    box={boxes.get(node.id)!}
                    ticket={ticket}
                    parentCode={parent ? cardText(parent).code : null}
                    parentTitle={parent?.title ?? null}
                    level={level}
                    selected={selectedId === node.id}
                    onSelect={onSelect}
                  />
                );
              })}
            </div>
            <StepHeaders columns={tree.columns} camera={camera.camera} width={size.width} />
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
      <div className="spatial-toolbar exploded-toolbar" role="toolbar" aria-label={t("exploded.toolbar")} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => camera.zoomBy(-1)} aria-label={t("canvas.zoomOut")}>−</button>
        <button type="button" onClick={() => camera.fitBounds(layout.bounds)} aria-label={t("exploded.fitAll")}>⌂</button>
        <button type="button" onClick={() => camera.zoomBy(1)} aria-label={t("canvas.zoomIn")}>+</button>
      </div>
      <div className="spatial-help exploded-help">{t("exploded.help")}</div>
    </div>
  );
}

/** Os cabeçalhos "Passo N" no topo da árvore: seguem a câmera na horizontal e ficam presos no alto ao descer. */
function StepHeaders({ columns, camera, width }: { columns: number; camera: Camera; width: number }) {
  const { t } = useTranslation("map");
  const step = COLUMN_WIDTH * camera.scale;
  const first = Math.max(0, Math.floor(-camera.x / step) - 1);
  const last = Math.min(columns - 1, Math.ceil((width - camera.x) / step));
  const shown: number[] = [];
  for (let column = first; column <= last; column += 1) shown.push(column);
  return (
    <div className="exploded-steps" aria-hidden="true">
      {shown.map((column) => (
        <span key={column} style={{ left: column * step + camera.x, width: step }}>
          {step >= 48 ? t("exploded.step", { number: column }) : column}
        </span>
      ))}
    </div>
  );
}

/**
 * As setas do ticket selecionado (ADR 0070, seção 5): todas as dependências dele, nos dois sentidos, com as cores e o tracejado da ADR 0069.
 * Só entre cards que aparecem na árvore.
 */
function selectionArrows(
  selectedId: string | null,
  byId: ReadonlyMap<string, TicketSummary>,
  edges: ReturnType<typeof dependencyEdges>,
  boxes: ReadonlyMap<string, Box>,
  camera: Camera,
): Arrow[] {
  const selected = selectedId === null ? undefined : boxes.get(selectedId);
  if (selectedId === null || !selected) return [];
  const arrows: Arrow[] = [];
  for (const edge of edges) {
    const waits = edge.from === selectedId;
    if (!waits && edge.to !== selectedId) continue;
    const otherId = waits ? edge.to : edge.from;
    const other = boxes.get(otherId);
    if (!other) continue;
    const ends = waits ? arrowEnds(other, selected, camera) : arrowEnds(selected, other, camera);
    arrows.push({ key: `${waits ? "waits" : "unlocks"}:${otherId}`, kind: waits ? "waits" : "unlocks", need: edge.need, finished: isFinished(byId.get(otherId)?.status ?? "todo"), ...ends });
  }
  return arrows;
}

interface CardProps {
  readonly node: ExplodedNode;
  readonly box: Box;
  readonly ticket: TicketSummary;
  readonly parentCode: string | null;
  readonly parentTitle: string | null;
  readonly level: "card" | "code" | "block";
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

/**
 * O card desta visão: linha 1 o código (o `[CÓDIGO]` do título, ou a chave) em negrito, com a marca do pai direto quando há; linha 2 o
 * título numa linha só. O tom diz o lugar na fila ou a situação; em andamento e em revisão levam um ponto. Um nó com tickets dobrados
 * dentro mostra quantos. Com o zoom longe, só o retângulo com o tom. Memorizado: mover a câmera não refaz o conteúdo.
 */
const TreeCard = memo(function TreeCard({ node, box, ticket, parentCode, parentTitle, level, selected, onSelect }: CardProps) {
  const { t } = useTranslation("map");
  const text = cardText(ticket);
  const tone = cardTone(ticket, node.place);
  const parts = [`${ticket.key} · ${ticket.title}`, toneText(t, tone)];
  if (node.inside > 0) parts.push(t("exploded.inside", { count: node.inside }));
  if (parentTitle !== null) parts.push(t("exploded.parentOf", { name: parentTitle }));
  if (node.outside) parts.push(t("exploded.outside"));
  const label = `${parts.join(". ")}.`;
  const style = { left: box.x, top: box.y, width: box.width, height: box.height } as CSSProperties;
  return (
    <button
      type="button"
      className="exploded-card"
      data-level={level}
      data-tone={tone}
      data-status={ticket.status}
      data-outside={node.outside ? "true" : "false"}
      style={style}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={() => onSelect(node.id)}
    >
      {level === "code" && <b className="exploded-card-big">{text.code}</b>}
      {level === "card" && (
        <>
          <span className="exploded-card-code">
            <b>{text.code}</b>
            {(ticket.status === "in_progress" || ticket.status === "in_review") && <i className="exploded-card-dot" aria-hidden="true" />}
            {node.inside > 0 && <span className="exploded-card-inside">{t("exploded.insideShort", { count: node.inside })}</span>}
            {parentCode !== null && <span className="exploded-card-parent">{parentCode}</span>}
          </span>
          <span className="exploded-card-title">{text.title}</span>
        </>
      )}
    </button>
  );
});
