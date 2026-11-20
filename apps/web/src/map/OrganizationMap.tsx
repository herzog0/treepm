import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { RenderNodeContent, SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useMemo, useState } from "react";
import type { ApiClient, ApiResult, Me, Project, TicketStatus, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { SidePanel } from "../panel/SidePanel.js";
import type { PanelTab } from "../panel/SidePanel.js";
import { buildMapItems } from "./items.js";
import type { MapNode } from "./items.js";
import "@treepm/react/styles.css";
import "../demo/Demo.css";
import "./map.css";

const getLabel = (node: MapNode) => node.label;
const getColor = (node: MapNode) => node.color;
const labels: SpatialCanvasLabels = {
  canvas: "Mapa da organização",
  toolbar: "Câmera e cores",
  zoomOut: "Reduzir zoom",
  reset: "Restaurar enquadramento",
  zoomIn: "Ampliar zoom",
  colors: "Cores",
};
const STATUS_TEXT: Record<TicketStatus, string> = {
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  done: "Concluído",
  cancelled: "Cancelado",
};

/** Situação em texto; ticket com filhos mostra o progresso com a base (ADR 0024). */
function describeTicketState(ticket: TicketSummary): string {
  if (ticket.progress) {
    const { done, total, excluded } = ticket.progress;
    const base = `${done} de ${total} concluídos`;
    return excluded > 0 ? `${base} · ${excluded} ${excluded === 1 ? "cancelado" : "cancelados"}` : base;
  }
  return ticket.status ? STATUS_TEXT[ticket.status] : "";
}

const describeNode = (node: MapNode) => (node.key ? `${node.key} · ${node.label}` : node.label);
const getNodeAriaLabel = ({ node, childCount }: SpatialNodeContent<MapNode>) =>
  node.kind === "organization"
    ? `${node.label}. Organização com ${childCount} ${childCount === 1 ? "projeto" : "projetos"}.`
    : node.kind === "ticket"
      ? `${describeNode(node)}. Ticket.`
      : `${describeNode(node)}. Projeto.`;
const getGroupAriaLabel = (members: readonly MapNode[]) =>
  `${members.length} ${members.every((member) => member.kind === "project") ? "projetos" : "itens"} agrupados: ${members.map(describeNode).join(", ")}. Amplie para revelar.`;
const renderNodeContent: RenderNodeContent<MapNode> = ({ node, lod, childCount, aggregate, descendantCount }) =>
  lod === "dot" ? null : (
    <>
      <span className="spatial-key">{node.key ?? "Organização"}</span>
      <strong>{node.label}</strong>
      {lod === "full" && node.kind === "organization" && (
        <span className="spatial-card-meta">{childCount} {childCount === 1 ? "projeto" : "projetos"}</span>
      )}
      {aggregate && (
        <span className="spatial-aggregate-count">
          {descendantCount} {node.kind === "organization" && descendantCount === childCount ? "projetos" : "itens"}
        </span>
      )}
    </>
  );

interface PanelState {
  open: boolean;
  tab: PanelTab;
  projectId: string | null;
}

interface MapViewProps {
  client: ApiClient;
  me: Me;
  projects: readonly Project[];
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>;
  onChanged: () => void;
}

function MapView({ client, me, projects, ticketsByProject, onChanged }: MapViewProps) {
  const items = useMemo(() => buildMapItems(me.organization, projects, ticketsByProject), [me.organization, projects, ticketsByProject]);
  const [panel, setPanel] = useState<PanelState>({ open: false, tab: "areas", projectId: null });

  const onSelectionChange = useCallback((node: MapNode | null) => {
    if (node?.kind === "project") setPanel({ open: true, tab: "projects", projectId: node.id });
  }, []);

  const canvas = useSpatialCanvas({ items, getLabel, getColor, onSelectionChange });
  const { index, selected, focusId, breadcrumb, focusNode, selectNode } = canvas;
  const canCreateProject = me.roles.clerk === "admin";
  const showCreateFirst = items.length === 1 && canCreateProject;

  return (
    <SpatialCanvasView
      controller={canvas}
      labels={labels}
      renderNodeContent={renderNodeContent}
      getNodeAriaLabel={getNodeAriaLabel}
      getGroupAriaLabel={getGroupAriaLabel}
      renderContext={() => (
        <section className="spatial-context">
          <nav className="spatial-breadcrumb" aria-label="Caminho do foco">
            {breadcrumb.map((item, position) => (
              <span key={item.id}>
                {position > 0 && <i aria-hidden="true">›</i>}
                <button
                  className={item.id === focusId ? "is-current" : ""}
                  aria-current={item.id === focusId ? "location" : undefined}
                  title={describeNode(item)}
                  onClick={() => focusNode(item.id)}
                >
                  {item.label}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="map-panel-toggle"
            aria-expanded={panel.open}
            onClick={() => setPanel((current) => ({ ...current, open: !current.open }))}
          >
            Áreas e projetos
          </button>
        </section>
      )}
      renderOverlay={() => (
        <>
          {selected && (
            <aside
              className={`spatial-selection ${panel.open ? "is-beside-panel" : ""}`}
              aria-label="Nó selecionado"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div>
                <code>{selected.key ?? "Organização"}</code>
                <button onClick={() => selectNode(null)} aria-label="Fechar seleção">×</button>
              </div>
              <strong>{selected.label}</strong>
              {selected.ticket ? (
                <p>{describeTicketState(selected.ticket)}</p>
              ) : (
                <p>{index.childrenByParentId.get(selected.id)?.length ?? 0} {selected.kind === "project" ? "tickets" : "projetos"}</p>
              )}
              <button onClick={() => focusNode(selected.id)}>Explorar ramo</button>
            </aside>
          )}
          {showCreateFirst && (
            <button
              type="button"
              className="map-create-first"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setPanel({ open: true, tab: "projects", projectId: null })}
            >
              Criar primeiro projeto
            </button>
          )}
          {panel.open && (
            <SidePanel
              client={client}
              me={me}
              projects={projects}
              tab={panel.tab}
              selectedProjectId={panel.projectId}
              onTabChange={(tab) => setPanel((current) => ({ ...current, tab }))}
              onClose={() => setPanel((current) => ({ ...current, open: false }))}
              onChanged={onChanged}
            />
          )}
          <div className="spatial-help">Wheel para zoom · arraste para pan · combine os dois · clique para selecionar · Explorar ramo para focar · C cores · Esc limpar</div>
        </>
      )}
    />
  );
}

export interface OrganizationMapProps {
  client: ApiClient;
  me: Me;
}

interface MapData {
  projects: readonly Project[];
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>;
}

/** Projetos primeiro; depois os tickets de cada projeto visível e não arquivado, em paralelo. Qualquer falha falha a carga. */
async function loadMapData(client: ApiClient): Promise<ApiResult<MapData>> {
  const projects = await client.listProjects();
  if (!projects.ok) return projects;
  const visible = projects.data.filter((project) => project.archivedAt === null);
  const lists = await Promise.all(visible.map((project) => client.listTickets(project.id)));
  const ticketsByProject: Record<string, readonly TicketSummary[]> = {};
  for (const [position, list] of lists.entries()) {
    if (!list.ok) return list;
    ticketsByProject[visible[position]!.id] = list.data;
  }
  return { ok: true, data: { projects: projects.data, ticketsByProject } };
}

export function OrganizationMap({ client, me }: OrganizationMapProps) {
  const { state, reload, retry } = useApiResource(() => loadMapData(client));

  if (state.status === "loading") {
    return <p className="map-state" role="status">Carregando mapa…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="map-state">
        <LoadError error={state.error} onRetry={retry} />
      </div>
    );
  }
  return <MapView client={client} me={me} projects={state.data.projects} ticketsByProject={state.data.ticketsByProject} onChanged={reload} />;
}
