import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, ApiResult, Me, Person, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { AssistantPanel } from "../assistant/AssistantPanel.js";
import type { MapPicker } from "../assistant/types.js";
import { canCreateTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { usePreferences } from "../preferences/context.js";
import { plural } from "../plural.js";
import { SidePanel } from "../panel/SidePanel.js";
import { ticketFocus } from "../ticket/focus.js";
import { TicketPage } from "../ticket/TicketPage.js";
import type { CreateRequest } from "../ticket/TicketPage.js";
import type { PanelTab } from "../panel/SidePanel.js";
import { MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
import { DRAFT_NODE_ID, buildMapItems, mixMapColors } from "./items.js";
import type { MapDraft } from "./items.js";
import { useRestoreCameraPlace } from "./cameraPlace.js";
import { computeMapMaxScale } from "./zoom.js";
import type { MapNode } from "./items.js";
import { TicketMark, describeTicketState, renderNodeContent } from "./nodeContent.js";
import "@treepm/react/styles.css";
import "../demo/Demo.css";
import "./map.css";
import "./status-mark.css";
import "../assistant/assistant.css";

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
      : node.kind === "draft"
        ? `Rascunho do ticket: ${node.label}. Ainda não criado.`
        : `${describeNode(node)}. Projeto.`;
const getGroupAriaLabel = (members: readonly MapNode[]) =>
  `${members.every((member) => member.kind === "project") ? plural(members.length, "projeto", "projetos") : plural(members.length, "item", "itens")} agrupados: ${members.map(describeNode).join(", ")}. Amplie para revelar.`;
interface PanelState {
  open: boolean;
  tab: PanelTab;
  projectId: string | null;
}

interface AssistantState {
  open: boolean;
  /** Projeto escolhido ao abrir; `null` faz o painel perguntar. */
  projectId: string | null;
  /** Ticket selecionado ao abrir: a procura da IA começa dentro dele (ADR 0031, ADR 0034). */
  scopeId: string | null;
}

const PlusIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M7 2.5v9M2.5 7h9" />
  </svg>
);

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
  const [draft, setDraft] = useState<MapDraft | null>(null);
  const items = useMemo(() => buildMapItems(me.organization, projects, ticketsByProject, draft), [me.organization, projects, ticketsByProject, draft]);
  const [panel, setPanel] = useState<PanelState>({ open: false, tab: "areas", projectId: null });
  // Conversa com a IA para criar ticket (ADR 0029): um painel por vez com a página do ticket e o painel de projetos.
  const [assistant, setAssistant] = useState<AssistantState>({ open: false, projectId: null, scopeId: null });
  const pickerRef = useRef<MapPicker | null>(null);
  const creatableProjects = useMemo(() => projects.filter((project) => canCreateTickets(me, project)), [me, projects]);
  const assistantAvailable = me.assistant?.enabled === true && creatableProjects.length > 0;

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const pageOpen = openTicketId !== null || creating !== null;
  // Valores que os ouvintes (seleção, teclado) leem sem precisar ser refeitos a cada render.
  const live = useRef({ selectedId: null as string | null, selected: null as MapNode | null, pageOpen, openTicketId, creating, panelOpen: false, assistantOpen: false });

  const closeAssistant = useCallback(() => {
    pickerRef.current = null;
    setDraft(null);
    setAssistant((current) => (current.open ? { open: false, projectId: null, scopeId: null } : current));
  }, []);

  const openTicket = useCallback((id: string) => {
    closeAssistant();
    setCreating(null);
    setPanel((current) => (current.open ? { ...current, open: false } : current));
    onOpenTicketChange(id);
  }, [onOpenTicketChange, closeAssistant]);
  const closePage = useCallback(() => {
    setCreating(null);
    if (live.current.openTicketId !== null) onOpenTicketChange(null);
  }, [onOpenTicketChange]);

  const onSelectionChange = useCallback((node: MapNode | null) => {
    // "Escolher no mapa" (ADR 0029): o clique vira o destino do ticket novo e não faz mais nada.
    const picker = pickerRef.current;
    if (picker) {
      if (node && node.kind !== "draft") {
        picker.pick(node);
        queueMicrotask(() => canvasRef.current.selectNode(null));
      }
      return;
    }
    if (node?.kind === "draft") return;
    // Com a conversa aberta, o painel de projetos não toma o lugar dela.
    if (node?.kind === "project" && !live.current.assistantOpen) setPanel({ open: true, tab: "projects", projectId: node.id });
    // Ativar um ticket que já está selecionado (clique ou Enter no nó) o abre; o primeiro clique só seleciona.
    if (node?.kind === "ticket" && node.id === live.current.selectedId) openTicket(node.id);
  }, [openTicket]);

  // Memoizado por itens: um objeto novo a cada render reiniciaria a câmera do pacote.
  const maxScale = computeMapMaxScale(items);
  const cameraOptions = useMemo(() => ({ maxScale }), [maxScale]);

  const canvas = useSpatialCanvas({ items, getLabel, getColor, mixColors: mixMapColors, defaultFilled: false, cameraOptions, onSelectionChange });
  const { index, layout, selected, selectedId, focusId, breadcrumb, focusNode, selectNode } = canvas;
  // Nível "detalhe" (ADR 0027): a escala vai para uma fonte externa que cada card assina; ver `detail.tsx`.
  const [scaleStore] = useState(createMapScaleStore);
  const detailData = useMemo(() => buildDetailData(items, people), [items, people]);
  scaleStore.set(canvas.camera.scale, layout);
  useLayoutEffect(() => scaleStore.notify(), [scaleStore, canvas.camera.scale, layout]);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  live.current = { selectedId, selected, pageOpen, openTicketId, creating, panelOpen: panel.open, assistantOpen: assistant.open };
  const hasOpenNode = openTicketId !== null && index.itemById.has(openTicketId);

  // Abrir o painel de áreas e projetos fecha a página; abrir um ticket fecha o painel (também pela URL).
  useEffect(() => {
    if (panel.open && live.current.pageOpen) closePage();
  }, [panel.open, closePage]);
  useEffect(() => {
    if (openTicketId !== null) setPanel((current) => (current.open ? { ...current, open: false } : current));
  }, [openTicketId]);
  useEffect(() => {
    if (panel.open && assistant.open) closeAssistant();
  }, [panel.open, assistant.open, closeAssistant]);
  useEffect(() => {
    if (openTicketId !== null) closeAssistant();
  }, [openTicketId, closeAssistant]);

  // O ticket aberto fica selecionado. Sem nó (projeto arquivado, ticket inexistente) não há o que selecionar.
  useEffect(() => {
    if (openTicketId !== null && hasOpenNode && live.current.selectedId !== openTicketId) selectNode(openTicketId);
  }, [openTicketId, hasOpenNode]);

  // A câmera enquadra o ticket aberto na área visível, uma vez por abertura, e de novo quando uma mudança o
  // tira do lugar no mapa (por exemplo, trocar o pai). Mudanças que não o deslocam deixam a câmera onde está.
  // O card tracejado do rascunho recebe o mesmo enquadramento (ADR 0029): a câmera vai até o destino dele.
  // Com o rascunho, o enquadramento é o do destino (o pai), com o card tracejado entre os filhos dele.
  const draftParentId = draft !== null ? index.itemById.get(DRAFT_NODE_ID)?.parentId ?? null : null;
  const frameId = openTicketId ?? draftParentId;
  const framesDraft = openTicketId === null && draftParentId !== null;
  const framed = useRef<{ id: string; frame: string } | null>(null);
  useEffect(() => {
    const node = frameId === null ? undefined : layout.nodeById.get(frameId);
    if (!node || frameId === null) {
      framed.current = null;
      return;
    }
    const sub = node.subtreeBounds;
    const frame = `${node.x}|${node.y}|${node.width}${framesDraft ? `|${sub.minX}|${sub.maxX}|${sub.minY}|${sub.maxY}` : ""}`;
    if (framed.current?.id === frameId && framed.current.frame === frame) return;
    let inner = 0;
    // Dois quadros: o palco estreita (CSS) e o observador de tamanho do pacote atualiza antes de enquadrar.
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const current = canvasRef.current;
        const target = current.layout.nodeById.get(frameId);
        const rect = current.stageRef.current?.getBoundingClientRect();
        if (!target || !rect) return;
        framed.current = { id: frameId, frame };
        const { bounds, requiredScale } = ticketFocus(target, { width: rect.width, height: rect.height });
        current.fitBounds(bounds, false, undefined, requiredScale);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [frameId, framesDraft, layout]);

  // Ao fechar a página, a câmera volta ao lugar de antes, se a pessoa não preferir ficar onde está (ADR 0028).
  const { preferences } = usePreferences();
  // A conversa com a IA conta como a página: fechá-la sem criar devolve a câmera ao lugar de antes, pela mesma preferência.
  useRestoreCameraPlace({
    pageOpen: pageOpen || assistant.open,
    mode: preferences.camera.onTicketClose,
    getView: () => ({ camera: canvasRef.current.camera, size: canvasRef.current.size }),
    restore: ({ bounds, requiredScale }) => canvasRef.current.fitBounds(bounds, false, undefined, requiredScale),
  });

  // Fechar a página devolve o foco ao mapa (a menos que o painel tenha tomado o lugar dela).
  const wasOpen = useRef(false);
  useEffect(() => {
    const sideOpen = pageOpen || assistant.open;
    if (wasOpen.current && !sideOpen && !live.current.panelOpen) canvasRef.current.stageRef.current?.focus();
    wasOpen.current = sideOpen;
  }, [pageOpen, assistant.open]);

  // Esc fecha a página (ou cancela a criação) e Enter abre o ticket selecionado, com o foco no mapa.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "Escape" && pickerRef.current) {
        pickerRef.current.cancel();
        return;
      }
      if (event.key === "Escape" && live.current.assistantOpen) {
        closeAssistant();
        return;
      }
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
  }, [closePage, closeAssistant, openTicket]);

  // Projeto da conversa: o do ticket ou do projeto selecionado; sem seleção, o único em que a pessoa pode criar.
  const openAssistant = () => {
    const current = live.current.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    const chosen = creatableProjects.find((project) => project.id === selectedProjectId) ?? (creatableProjects.length === 1 ? creatableProjects[0] : undefined);
    setCreating(null);
    setPanel((state) => (state.open ? { ...state, open: false } : state));
    if (live.current.openTicketId !== null) onOpenTicketChange(null);
    canvasRef.current.selectNode(null);
    // Qualquer ticket selecionado do projeto da conversa define o escopo (ADR 0034); projeto ou nenhuma seleção procuram no projeto inteiro.
    const scopeId = current?.kind === "ticket" && chosen && current.ticket?.projectId === chosen.id ? current.ticket.id : null;
    setAssistant({ open: true, projectId: chosen?.id ?? null, scopeId });
  };

  const canCreateProject = me.roles.clerk === "admin";
  const showCreateFirst = items.length === 1 && canCreateProject;

  return (
    <div className={`map-workspace ${pageOpen ? "has-ticket-page" : ""} ${assistant.open ? "has-assistant" : ""}`}>
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
          {selected && selected.kind !== "draft" && selected.id !== openTicketId && (
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
                <p>{(() => {
                  const count = index.childrenByParentId.get(selected.id)?.length ?? 0;
                  return selected.kind === "project" ? plural(count, "item", "itens") : `${count} projetos`;
                })()}</p>
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
          {assistantAvailable && !assistant.open && (
            <button
              type="button"
              className="map-new-ticket"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={openAssistant}
            >
              <PlusIcon />
              Novo ticket
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
              assistantAvailable={assistantAvailable}
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
    {assistant.open && (
      <AssistantPanel
        client={client}
        projects={creatableProjects}
        initialProjectId={assistant.projectId}
        initialScopeId={assistant.scopeId}
        tickets={ticketsByProject}
        onClose={closeAssistant}
        onCreated={openTicket}
        onManualCreate={(request) => {
          closeAssistant();
          setCreating(request);
        }}
        onDraftChange={setDraft}
        onChanged={onChanged}
        registerPicker={(picker) => {
          pickerRef.current = picker;
        }}
      />
    )}
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
