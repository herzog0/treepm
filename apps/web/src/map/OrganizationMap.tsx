import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useMemo, useState } from "react";
import type { ApiClient, ApiResult, Me, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { plural } from "../plural.js";
import { SidePanel } from "../panel/SidePanel.js";
import type { PanelTab } from "../panel/SidePanel.js";
import { buildMapItems, mixMapColors } from "./items.js";
import { computeMapMaxScale } from "./zoom.js";
import type { MapNode } from "./items.js";
import { TicketMark, describeTicketState, renderNodeContent } from "./nodeContent.js";
import "@treepm/react/styles.css";
import "../demo/Demo.css";
import "./map.css";
import "./status-mark.css";

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
const describeNode = (node: MapNode) => (node.key ? `${node.key} · ${node.label}` : node.label);
const getNodeAriaLabel = ({ node, childCount }: SpatialNodeContent<MapNode>) =>
  node.kind === "organization"
    ? `${node.label}. Organização com ${plural(childCount, "projeto", "projetos")}.`
    : node.kind === "ticket"
      ? `${describeNode(node)}. Ticket.`
      : `${describeNode(node)}. Projeto.`;
const getGroupAriaLabel = (members: readonly MapNode[]) =>
  `${members.every((member) => member.kind === "project") ? plural(members.length, "projeto", "projetos") : plural(members.length, "item", "itens")} agrupados: ${members.map(describeNode).join(", ")}. Amplie para revelar.`;
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
  onImport: ((projectId: string) => void) | undefined;
}

function MapView({ client, me, projects, ticketsByProject, onChanged, onImport }: MapViewProps) {
  const items = useMemo(() => buildMapItems(me.organization, projects, ticketsByProject), [me.organization, projects, ticketsByProject]);
  const [panel, setPanel] = useState<PanelState>({ open: false, tab: "areas", projectId: null });

  const onSelectionChange = useCallback((node: MapNode | null) => {
    if (node?.kind === "project") setPanel({ open: true, tab: "projects", projectId: node.id });
  }, []);

  // Memoizado por itens: um objeto novo a cada render reiniciaria a câmera do pacote.
  const cameraOptions = useMemo(() => ({ maxScale: computeMapMaxScale(items) }), [items]);

  const canvas = useSpatialCanvas({ items, getLabel, getColor, mixColors: mixMapColors, defaultFilled: false, cameraOptions, onSelectionChange });
  const { index, selected, focusId, breadcrumb, focusNode, selectNode } = canvas;
  const canCreateProject = me.roles.clerk === "admin";
  const showCreateFirst = items.length === 1 && canCreateProject;

  return (
    <SpatialCanvasView
      controller={canvas}
      className="org-map"
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
                <p className="selection-state">
                  <TicketMark ticket={selected.ticket} />
                  <span>{describeTicketState(selected.ticket)}</span>
                </p>
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
              {...(onImport ? { onImportProject: onImport } : {})}
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
  /** Abre a tela de importação do projeto (ADR 0025). Sem ela, o painel não oferece a ação. */
  onImport?: (projectId: string) => void;
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

export function OrganizationMap({ client, me, onImport }: OrganizationMapProps) {
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
  return <MapView client={client} me={me} projects={state.data.projects} ticketsByProject={state.data.ticketsByProject} onChanged={reload} onImport={onImport} />;
}
