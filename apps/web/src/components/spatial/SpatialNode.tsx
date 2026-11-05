import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ticketIdentifier } from "@treepm/domain";
import type { TicketStatus, TreeIndex, User } from "@treepm/domain";
import { Avatars } from "../Avatars.js";
import type { SpatialLayoutNode } from "./spatialLayout.js";
import type { SpatialLod, SpatialSceneNode, SpatialSceneRegion } from "./spatialScene.js";

export type VisualStatus = TicketStatus | "mixed" | "not_started" | "active";
type Lod = SpatialLod;

interface SpatialNodeProps extends SpatialSceneNode {
  status: VisualStatus;
  selected: boolean;
  projectKey: string;
  treeIndex: TreeIndex;
  users: User[];
  reducedMotion: boolean;
  onSelect: (id: string) => void;
}

const STATUS_LABEL: Record<TicketStatus, string> = { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" };

export function visualStatus(ticket: SpatialLayoutNode["ticket"], index: TreeIndex): VisualStatus {
  const counts = index.leafCountsById.get(ticket.id);
  if (!counts) return ticket.status;
  const present = (["todo", "in_progress", "done"] as const).filter((status) => counts[status] > 0);
  if (present.length > 1) return "mixed";
  if (present.length === 1) return present[0] ?? "mixed";
  return "not_started";
}

function progressLabel(ticket: SpatialLayoutNode["ticket"], index: TreeIndex) {
  if ((index.childrenByParentId.get(ticket.id)?.length ?? 0) === 0) return STATUS_LABEL[ticket.status];
  return index.progressById.get(ticket.id)?.label ?? "Sem folhas";
}

function LodContent({ lod, ticket, index, users, aggregate, projectKey }: { lod: Lod; ticket: SpatialLayoutNode["ticket"]; index: TreeIndex; users: User[]; aggregate: boolean; projectKey: string }) {
  const label = progressLabel(ticket, index);
  if (lod === "dot") return <span className="spatial-sr-only">{ticket.title}. {label}</span>;
  return <>
    <span className="spatial-key">{ticketIdentifier(ticket, projectKey)}</span>
    <strong>{ticket.title}</strong>
    {lod === "full" && <span className="spatial-card-meta"><Avatars userIds={ticket.assigneeIds} users={users} compact /><span>{label}</span></span>}
    {lod === "chip" && <span className="spatial-chip-status">{label}</span>}
    {aggregate && <span className="spatial-aggregate-count">{index.subtreeCountById.get(ticket.id) ?? 1} no trabalho</span>}
  </>;
}

export function SpatialRegion(props: SpatialSceneRegion) {
  return <div className="spatial-region" aria-hidden="true" data-region-id={props.id} style={{ width: props.width, height: props.height, opacity: props.opacity, transform: `translate3d(${props.x}px, ${props.y}px, 0)` }} />;
}

export function SpatialNode(props: SpatialNodeProps) {
  const { node, lod, aggregate, reveal, representation } = props;
  const ticket = node.ticket;
  const [content, setContent] = useState({ lod, aggregate });
  const [contentVisible, setContentVisible] = useState(true);
  const label = progressLabel(ticket, props.treeIndex);
  const indicator = representation === "indicator";
  const interactive = !indicator && props.width >= 20 && reveal >= 0.5;
  const style: CSSProperties & { "--spatial-reveal": number; "--spatial-indicator-scale": number } = {
    "--spatial-reveal": reveal,
    "--spatial-indicator-scale": props.indicatorScale,
    width: props.width, height: props.height, opacity: props.opacity,
    transform: `translate3d(${props.x}px, ${props.y}px, 0) translateX(-50%)`,
  };
  // A positive local surface avoids the browser's minimum border box at subpixel sizes.
  const surfaceWidth = Math.max(6, props.width);
  const surfaceHeight = Math.max(6, props.height);
  const surfaceStyle: CSSProperties = {
    width: surfaceWidth,
    height: surfaceHeight,
    transform: `scale(${props.width / surfaceWidth}, ${props.height / surfaceHeight})`,
  };

  useEffect(() => {
    if (content.lod === lod && content.aggregate === aggregate) {
      setContentVisible(true);
      return;
    }
    if (props.reducedMotion) {
      setContent({ lod, aggregate });
      setContentVisible(true);
      return;
    }
    setContentVisible(false);
    const timer = window.setTimeout(() => {
      setContent({ lod, aggregate });
      setContentVisible(true);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [lod, aggregate, content.lod, content.aggregate, props.reducedMotion]);

  return <article className={`spatial-node spatial-lod-${lod} spatial-status-${props.status} ${aggregate ? "is-aggregate" : ""} ${props.selected ? "is-selected" : ""}`}
    data-spatial-id={ticket.id}
    data-depth={node.depth}
    data-lod={lod}
    data-representation={representation}
    data-reveal={reveal}
    data-lod-transition={contentVisible ? "stable" : "changing"}
    data-aggregate={aggregate ? "true" : "false"}
    data-status={props.status}
    style={style}
    role={indicator ? "img" : undefined}
    title={indicator ? `${ticket.title}. ${label}` : undefined}
    aria-label={`${ticketIdentifier(ticket, props.projectKey)} ${ticket.title}. ${label}`}>
    <div className="spatial-card-visual" style={surfaceStyle}>
      <button className="spatial-card-button" style={{ opacity: props.contentOpacity }} tabIndex={interactive ? 0 : -1} aria-hidden={indicator ? true : undefined} onClick={() => { if (interactive) props.onSelect(ticket.id); }}>
        <span className="spatial-lod-content" data-lod-transition={contentVisible ? "stable" : "changing"}>
          <LodContent lod={content.lod} ticket={ticket} index={props.treeIndex} users={props.users} aggregate={content.aggregate} projectKey={props.projectKey} />
        </span>
      </button>
    </div>
  </article>;
}
