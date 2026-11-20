import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, ApiResult, Me, Person, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { plural } from "../plural.js";
import { SidePanel } from "../panel/SidePanel.js";
import { ticketFocus } from "../ticket/focus.js";
import { TicketPage } from "../ticket/TicketPage.js";
import type { CreateRequest } from "../ticket/TicketPage.js";
import type { PanelTab } from "../panel/SidePanel.js";
import { MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
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
  people: readonly Person[];
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>;
  onChanged: () => void;
  onImport: ((projectId: string) => void) | undefined;
  openTicketId: string | null;
  onOpenTicketChange: (ticketId: string | null) => void;
}

function MapView({ client, me, projects, people, ticketsByProject, onChanged, onImport, openTicketId, onOpenTicketChange }: MapViewProps) {
  const items = useMemo(() => buildMapItems(me.organization, projects, ticketsByProject), [me.organization, projects, ticketsByProject]);
  const [panel, setPanel] = useState<PanelState>({ open: false, tab: "areas", projectId: null });

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const pageOpen = openTicketId !== null || creating !== null;
  // Valores que os ouvintes (seleção, teclado) leem sem precisar ser refeitos a cada render.
  const live = useRef({ selectedId: null as string | null, selected: null as MapNode | null, pageOpen, openTicketId, creating, panelOpen: false });

  const openTicket = useCallback((id: string) => {
    setCreating(null);
    setPanel((current) => (current.open ? { ...current, open: false } : current));
    onOpenTicketChange(id);
  }, [onOpenTicketChange]);
  const closePage = useCallback(() => {
    setCreating(null);
    if (live.current.openTicketId !== null) onOpenTicketChange(null);
  }, [onOpenTicketChange]);

  const onSelectionChange = useCallback((node: MapNode | null) => {
    if (node?.kind === "project") setPanel({ open: true, tab: "projects", projectId: node.id });
    // Ativar um ticket que já está selecionado (clique ou Enter no nó) o abre; o primeiro clique só seleciona.
    if (node?.kind === "ticket" && node.id === live.current.selectedId) openTicket(node.id);
  }, [openTicket]);

  // Memoizado por itens: um objeto novo a cada render reiniciaria a câmera do pacote.
  const cameraOptions = useMemo(() => ({ maxScale: computeMapMaxScale(items) }), [items]);

  const canvas = useSpatialCanvas({ items, getLabel, getColor, mixColors: mixMapColors, defaultFilled: false, cameraOptions, onSelectionChange });
  const { index, layout, selected, selectedId, focusId, breadcrumb, focusNode, selectNode } = canvas;
  // Nível "detalhe" (ADR 0027): a escala vai para uma fonte externa que cada card assina; ver `detail.tsx`.
  const [scaleStore] = useState(createMapScaleStore);
  const detailData = useMemo(() => buildDetailData(items, people), [items, people]);
  scaleStore.set(canvas.camera.scale, layout);
  useLayoutEffect(() => scaleStore.notify(), [scaleStore, canvas.camera.scale, layout]);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  live.current = { selectedId, selected, pageOpen, openTicketId, creating, panelOpen: panel.open };
  const hasOpenNode = openTicketId !== null && index.itemById.has(openTicketId);

  // Abrir o painel de áreas e projetos fecha a página; abrir um ticket fecha o painel (também pela URL).
  useEffect(() => {
    if (panel.open && live.current.pageOpen) closePage();
  }, [panel.open, closePage]);
  useEffect(() => {
    if (openTicketId !== null) setPanel((current) => (current.open ? { ...current, open: false } : current));
  }, [openTicketId]);

  // O ticket aberto fica selecionado. Sem nó (projeto arquivado, ticket inexistente) não há o que selecionar.
  useEffect(() => {
    if (openTicketId !== null && hasOpenNode && live.current.selectedId !== openTicketId) selectNode(openTicketId);
  }, [openTicketId, hasOpenNode]);

  // A câmera enquadra o ticket aberto na área visível, uma vez por abertura, e de novo quando uma mudança o
  // tira do lugar no mapa (por exemplo, trocar o pai). Mudanças que não o deslocam deixam a câmera onde está.
  const framed = useRef<{ id: string; frame: string } | null>(null);
  useEffect(() => {
    const node = openTicketId === null ? undefined : layout.nodeById.get(openTicketId);
    if (!node || openTicketId === null) {
      framed.current = null;
      return;
    }
    const frame = `${node.x}|${node.y}|${node.width}`;
    if (framed.current?.id === openTicketId && framed.current.frame === frame) return;
    let inner = 0;
    // Dois quadros: o palco estreita (CSS) e o observador de tamanho do pacote atualiza antes de enquadrar.
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const current = canvasRef.current;
        const target = current.layout.nodeById.get(openTicketId);
        const rect = current.stageRef.current?.getBoundingClientRect();
        if (!target || !rect) return;
        framed.current = { id: openTicketId, frame };
        const { bounds, requiredScale } = ticketFocus(target, { width: rect.width, height: rect.height });
        current.fitBounds(bounds, false, undefined, requiredScale);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [openTicketId, layout]);

  // Fechar a página devolve o foco ao mapa (a menos que o painel tenha tomado o lugar dela).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !pageOpen && !live.current.panelOpen) canvasRef.current.stageRef.current?.focus();
    wasOpen.current = pageOpen;
  }, [pageOpen]);

  // Esc fecha a página (ou cancela a criação) e Enter abre o ticket selecionado, com o foco no mapa.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "Escape" && live.current.pageOpen) {
        if (live.current.creating) setCreating(null);
        else closePage();
        return;
      }
      if (event.key !== "Enter" || event.repeat) return;
      const target = event.target;
      const ticket = live.current.selected;
      if (!ticket || ticket.kind !== "ticket" || !(target instanceof Element)) return;
      if (target.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (!canvasRef.current.rootRef.current?.contains(target)) return;
      event.preventDefault();
      openTicket(ticket.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePage, openTicket]);

  const canCreateProject = me.roles.clerk === "admin";
  const showCreateFirst = items.length === 1 && canCreateProject;

  return (
    <div className={`map-workspace ${pageOpen ? "has-ticket-page" : ""}`}>
    <MapDetailProvider store={scaleStore} data={detailData}>
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
          {selected && selected.id !== openTicketId && (
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
              {selected.kind === "ticket" && <button onClick={() => openTicket(selected.id)}>Abrir</button>}
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
              onCreateTicket={(projectId) => {
                setPanel((current) => ({ ...current, open: false }));
                setCreating({ projectId, parentId: null });
                if (live.current.openTicketId !== null) onOpenTicketChange(null);
              }}
            />
          )}
          <div className="spatial-help">Wheel para zoom · arraste para pan · combine os dois · clique para selecionar · Explorar ramo para focar · C cores · Esc limpar</div>
        </>
      )}
    />
    </MapDetailProvider>
    {pageOpen && (
      <TicketPage
        client={client}
        me={me}
        projects={projects}
        ticketId={openTicketId}
        creating={creating}
        onOpenTicket={openTicket}
        onClose={closePage}
        onChanged={onChanged}
        onRemoved={() => {
          closePage();
          selectNode(null);
        }}
        onStartCreate={setCreating}
        onCancelCreate={() => setCreating(null)}
        onCreated={openTicket}
      />
    )}
    </div>
  );
}

export interface OrganizationMapProps {
  client: ApiClient;
  me: Me;
  /** Abre a tela de importação do projeto (ADR 0025). Sem ela, o painel não oferece a ação. */
  onImport?: (projectId: string) => void;
  /** Ticket aberto na página (`?ticket=` da URL). Sem esta prop, o mapa guarda o estado sozinho. */
  openTicketId?: string | null;
  onOpenTicketChange?: (ticketId: string | null) => void;
}

interface MapData {
  projects: readonly Project[];
  people: readonly Person[];
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>;
}

/** Projetos e pessoas primeiro; depois os tickets de cada projeto visível e não arquivado, em paralelo. Qualquer falha falha a carga. */
async function loadMapData(client: ApiClient): Promise<ApiResult<MapData>> {
  const [projects, people] = await Promise.all([client.listProjects(), client.listPeople()]);
  if (!projects.ok) return projects;
  if (!people.ok) return people;
  const visible = projects.data.filter((project) => project.archivedAt === null);
  const lists = await Promise.all(visible.map((project) => client.listTickets(project.id)));
  const ticketsByProject: Record<string, readonly TicketSummary[]> = {};
  for (const [position, list] of lists.entries()) {
    if (!list.ok) return list;
    ticketsByProject[visible[position]!.id] = list.data;
  }
  return { ok: true, data: { projects: projects.data, people: people.data, ticketsByProject } };
}

export function OrganizationMap({ client, me, onImport, openTicketId, onOpenTicketChange }: OrganizationMapProps) {
  const { state, reload, retry } = useApiResource(() => loadMapData(client));
  const [ownTicketId, setOwnTicketId] = useState<string | null>(null);
  const controlled = openTicketId !== undefined;
  const changeTicket = useCallback((id: string | null) => {
    if (!controlled) setOwnTicketId(id);
    onOpenTicketChange?.(id);
  }, [controlled, onOpenTicketChange]);

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
  return <MapView client={client} me={me} projects={state.data.projects} people={state.data.people} ticketsByProject={state.data.ticketsByProject} onChanged={reload} onImport={onImport} openTicketId={controlled ? openTicketId : ownTicketId} onOpenTicketChange={changeTicket} />;
}
