import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, Me, Person, Project, TicketSummary } from "../api/client.js";
import { useTranslation } from "react-i18next";
import { useApiResource } from "../api/useApiResource.js";
import { CommandBar } from "../command/CommandBar.js";
import { splitIdeaText } from "../command/ideaText.js";
import { useDescribeApiError } from "../api/errorText.js";
import { AssistantPanel } from "../assistant/AssistantPanel.js";
import { AskPanel } from "../assistant/AskPanel.js";
import type { MapPicker } from "../assistant/types.js";
import type { ConversationSummary } from "../api/client.js";
import { canCreateTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { SidePanel } from "../panel/SidePanel.js";
import { ticketFocus } from "../ticket/focus.js";
import { TicketPage } from "../ticket/TicketPage.js";
import type { CreateRequest } from "../ticket/TicketPage.js";
import type { PanelTab } from "../panel/SidePanel.js";
import { isAgentWorkActive, useAgentWorkClock } from "./agentWork.js";
import { loadMapData, mergeMapData } from "./mapData.js";
import type { MapData } from "./mapData.js";
import { useAutoRefresh } from "./useAutoRefresh.js";
import { MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
import { DRAFT_NODE_ID, buildMapItems, mixMapColors } from "./items.js";
import type { MapDraft } from "./items.js";
import { mapGeometry } from "./mapGeometry.js";
import { computeMapMaxScale } from "./zoom.js";
import type { MapNode } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";
import "@treepm/react/styles.css";
import "../demo/Demo.css";
import "./map.css";
import "./status-mark.css";
import "./agent-work.css";
import "../assistant/assistant.css";

const getLabel = (node: MapNode) => node.label;
const getColor = (node: MapNode) => node.color;
const describeNode = (node: MapNode) => (node.key ? `${node.key} · ${node.label}` : node.label);
interface PanelState {
  open: boolean;
  tab: PanelTab;
  projectId: string | null;
}

interface AssistantState {
  /** Há conversa de novo ticket na barra (à vista ou recolhida). */
  open: boolean;
  /** A folha da conversa está à vista; recolhida, a conversa continua montada e a barra mostra "Conversa em andamento" (ADR 0036). */
  expanded: boolean;
  /** Retoma a conversa aberta mais recente do projeto (`true`) ou começa uma vazia. */
  resume: boolean;
  /** Projeto escolhido ao abrir; `null` faz a folha perguntar. */
  projectId: string | null;
  /** Ticket selecionado ao abrir: a procura da IA começa dentro dele (ADR 0031, ADR 0034). */
  scopeId: string | null;
  /** Texto da barra de pedidos, enviado como a primeira mensagem (ADR 0036). */
  message: string | null;
  /** Muda a cada abertura: uma conversa nova a partir da barra recomeça a folha, mesmo com ela já aberta. */
  nonce: number;
}

/** A pergunta sobre o projeto (ADR 0037): não é guardada; vive enquanto a tela do mapa estiver aberta. */
interface AskState {
  /** Há folha de pergunta na barra (à vista ou recolhida). */
  open: boolean;
  expanded: boolean;
  /** Projeto escolhido ao abrir; `null` faz a folha perguntar. */
  projectId: string | null;
  /** A pergunta da barra; `id` muda a cada uma. */
  question: { id: number; text: string } | null;
  /** Muda a cada folha nova; uma pergunta que continua a folha aberta não o muda. */
  nonce: number;
}

const ASK_CLOSED: AskState = { open: false, expanded: false, projectId: null, question: null, nonce: 0 };

const CLOSED: AssistantState = { open: false, expanded: false, resume: false, projectId: null, scopeId: null, message: null, nonce: 0 };

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
  focusTicketId: string | null;
  onFocusHandled: (() => void) | undefined;
}

function MapView({ client, me, projects, people, ticketsByProject, onChanged, onImport, openTicketId, onOpenTicketChange, focusTicketId, onFocusHandled }: MapViewProps) {
  const { t } = useTranslation("map");
  const labels = useMemo<SpatialCanvasLabels>(
    () => ({ canvas: t("canvas.label"), toolbar: t("canvas.toolbar"), zoomOut: t("canvas.zoomOut"), reset: t("canvas.reset"), zoomIn: t("canvas.zoomIn"), colors: t("canvas.colors") }),
    [t],
  );
  // O rótulo do nó diz "em trabalho pela IA" enquanto o marcador vale (ADR 0043) e deixa de dizer quando ele vence.
  const untils = useMemo(() => Object.values(ticketsByProject).flatMap((list) => list.map((ticket) => ticket.agentWork?.until)), [ticketsByProject]);
  const clock = useAgentWorkClock(untils);
  const getNodeAriaLabel = useCallback(
    ({ node, childCount }: SpatialNodeContent<MapNode>) =>
      node.kind === "organization"
        ? t("node.organization", { label: node.label, count: childCount })
        : node.kind === "ticket"
          ? t(isAgentWorkActive(node.ticket?.agentWork, clock) ? "node.ticketWorking" : "node.ticket", { label: describeNode(node) })
          : node.kind === "draft"
            ? t("node.draft", { label: node.label })
            : t("node.project", { label: describeNode(node) }),
    [t, clock],
  );
  const getGroupAriaLabel = useCallback(
    (members: readonly MapNode[]) => {
      const options = { count: members.length, members: members.map(describeNode).join(", ") };
      return members.every((member) => member.kind === "project") ? t("group.projects", options) : t("group.items", options);
    },
    [t],
  );
  const [draft, setDraft] = useState<MapDraft | null>(null);
  const items = useMemo(() => buildMapItems(me.organization, projects, ticketsByProject, draft, t), [me.organization, projects, ticketsByProject, draft, t]);
  const [panel, setPanel] = useState<PanelState>({ open: false, tab: "areas", projectId: null });
  // Conversa com a IA para criar ticket (ADR 0029): mora na folha da barra de pedidos (ADR 0036) e convive com a página do ticket e o painel de áreas.
  const [assistant, setAssistant] = useState<AssistantState>(CLOSED);
  const pickerRef = useRef<MapPicker | null>(null);
  // Há conversa em andamento (mensagem, resposta a caminho ou texto digitado)? Quem sabe é a conversa; recolher uma vazia a encerra.
  const progressRef = useRef(false);
  const reportProgress = useCallback((active: boolean) => {
    progressRef.current = active;
  }, []);
  const creatableProjects = useMemo(() => projects.filter((project) => canCreateTickets(me, project)), [me, projects]);
  const assistantAvailable = me.assistant?.enabled === true && creatableProjects.length > 0;
  // Perguntar não exige poder criar: qualquer pessoa com um projeto visível pergunta (ADR 0037).
  const visibleProjects = useMemo(() => projects.filter((project) => project.archivedAt === null), [projects]);
  const canAsk = me.assistant?.enabled === true && visibleProjects.length > 0;
  const [ask, setAsk] = useState<AskState>(ASK_CLOSED);
  const askProgressRef = useRef(false);
  const reportAskProgress = useCallback((active: boolean) => {
    askProgressRef.current = active;
  }, []);
  const [barFocus, setBarFocus] = useState(0);

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const pageOpen = openTicketId !== null || creating !== null;
  // Valores que os ouvintes (seleção, teclado) leem sem precisar ser refeitos a cada render.
  const live = useRef({ selectedId: null as string | null, selected: null as MapNode | null, pageOpen, openTicketId, creating, panelOpen: false, assistantExpanded: false, askExpanded: false, ask: ASK_CLOSED });

  // Encerra a conversa na barra (criou o ticket, foi para a criação manual): a conversa guardada na API continua lá.
  const closeAssistant = useCallback(() => {
    pickerRef.current = null;
    progressRef.current = false;
    setDraft(null);
    setAssistant((current) => (current.open ? { ...CLOSED, nonce: current.nonce } : current));
  }, []);
  // Recolhe a folha sem encerrar a conversa; uma conversa vazia, sem nada a guardar, se encerra.
  const collapseAssistant = useCallback(() => {
    if (!live.current.assistantExpanded) return;
    pickerRef.current?.cancel();
    if (!progressRef.current) closeAssistant();
    else setAssistant((current) => (current.expanded ? { ...current, expanded: false } : current));
  }, [closeAssistant]);

  const closeAsk = useCallback(() => {
    askProgressRef.current = false;
    setAsk((current) => (current.open ? { ...ASK_CLOSED, nonce: current.nonce } : current));
  }, []);
  // Recolhe a folha da pergunta; sem nenhuma mensagem, ela se encerra.
  const collapseAsk = useCallback(() => {
    if (!live.current.askExpanded) return;
    if (!askProgressRef.current) closeAsk();
    else setAsk((current) => (current.expanded ? { ...current, expanded: false } : current));
  }, [closeAsk]);

  const openTicket = useCallback((id: string) => {
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
    if (node?.kind === "project") setPanel({ open: true, tab: "projects", projectId: node.id });
    // Um clique num ticket (ou Enter no nó, que o navegador trata como clique) abre a página direto. O ticket aberto fica selecionado pelo efeito abaixo; esse eco não reabre.
    if (node?.kind === "ticket" && node.id !== live.current.openTicketId) openTicket(node.id);
  }, [openTicket]);

  // Memoizado por itens: um objeto novo a cada render reiniciaria a câmera do pacote.
  const maxScale = useMemo(() => computeMapMaxScale(items), [items]);
  const cameraOptions = useMemo(() => ({ maxScale }), [maxScale]);

  const geometry = useMemo(() => mapGeometry(items), [items]);
  const canvas = useSpatialCanvas({ items, geometry, getLabel, getColor, mixColors: mixMapColors, defaultFilled: false, cameraOptions, onSelectionChange });
  const { index, layout, selected, selectedId, focusId, breadcrumb, focusNode, selectNode } = canvas;
  // Nível "detalhe" (ADR 0027): a escala vai para uma fonte externa que cada card assina; ver `detail.tsx`.
  const [scaleStore] = useState(createMapScaleStore);
  const detailData = useMemo(() => buildDetailData(items, people), [items, people]);
  scaleStore.set(canvas.camera.scale, layout);
  useLayoutEffect(() => scaleStore.notify(), [scaleStore, canvas.camera.scale, layout]);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  live.current = { selectedId, selected, pageOpen, openTicketId, creating, panelOpen: panel.open, assistantExpanded: assistant.open && assistant.expanded, askExpanded: ask.open && ask.expanded, ask };
  const hasOpenNode = openTicketId !== null && index.itemById.has(openTicketId);

  // Abrir o painel de áreas e projetos fecha a página; abrir um ticket fecha o painel (também pela URL).
  useEffect(() => {
    if (panel.open && live.current.pageOpen) closePage();
  }, [panel.open, closePage]);
  useEffect(() => {
    if (openTicketId !== null) setPanel((current) => (current.open ? { ...current, open: false } : current));
  }, [openTicketId]);
  // Abrir um ticket, a criação manual ou o painel de áreas recolhe a folha da conversa, e a conversa segue (ADR 0036). O contrário não fecha nada.
  useEffect(() => {
    if (openTicketId !== null || creating !== null || panel.open) {
      collapseAssistant();
      collapseAsk();
    }
  }, [openTicketId, creating, panel.open, collapseAssistant, collapseAsk]);

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

  // "Ver no mapa" da página do ticket: o mesmo enquadramento de quando ele abre, sob demanda.
  const showOnMap = (ticketId: string) => {
    const current = canvasRef.current;
    const target = current.layout.nodeById.get(ticketId);
    const rect = current.stageRef.current?.getBoundingClientRect();
    if (!target || !rect) return;
    const { bounds, requiredScale } = ticketFocus(target, { width: rect.width, height: rect.height });
    current.fitBounds(bounds, false, undefined, requiredScale);
  };

  // "Ver no mapa" da tela "Ideias" (ADR 0042): a câmera vai ao ticket pedido, sem abrir a página, e o pedido vale uma vez. Dois
  // quadros, como no enquadramento do ticket aberto: o palco e o observador de tamanho do pacote se acertam antes.
  const focusHandled = useRef(onFocusHandled);
  focusHandled.current = onFocusHandled;
  useEffect(() => {
    if (focusTicketId === null) return;
    if (!layout.nodeById.has(focusTicketId)) {
      focusHandled.current?.();
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        showOnMap(focusTicketId);
        focusHandled.current?.();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusTicketId, layout]);

  // Fechar a página devolve o foco ao mapa (a menos que o painel tenha tomado o lugar dela).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !pageOpen && !live.current.panelOpen) canvasRef.current.stageRef.current?.focus();
    wasOpen.current = pageOpen;
  }, [pageOpen]);

  // Esc fecha a página (ou cancela a criação). Enter num ticket do mapa é o clique do nó, tratado na seleção.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "Escape" && pickerRef.current) {
        pickerRef.current.cancel();
        return;
      }
      if (event.key === "Escape" && live.current.assistantExpanded) {
        collapseAssistant();
        canvasRef.current.stageRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && live.current.askExpanded) {
        collapseAsk();
        canvasRef.current.stageRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && live.current.pageOpen) {
        if (live.current.creating) setCreating(null);
        else closePage();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePage, collapseAssistant, collapseAsk]);

  // Projeto da conversa: o do ticket ou do projeto selecionado; sem seleção, o único em que a pessoa pode criar.
  const chooseProject = () => {
    const current = live.current.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    return creatableProjects.find((project) => project.id === selectedProjectId) ?? (creatableProjects.length === 1 ? creatableProjects[0] : undefined);
  };
  const openAssistant = (message: string | null = null, resume = false) => {
    collapseAsk();
    const current = live.current.selected;
    const chosen = chooseProject();
    // A página do ticket e o painel de áreas ficam como estão (ADR 0036). Com a página aberta o ticket dela segue selecionado.
    if (live.current.openTicketId === null) canvasRef.current.selectNode(null);
    // Qualquer ticket selecionado do projeto da conversa define o escopo (ADR 0034); projeto ou nenhuma seleção procuram no projeto inteiro.
    const scopeId = current?.kind === "ticket" && chosen && current.ticket?.projectId === chosen.id ? current.ticket.id : null;
    progressRef.current = false;
    setAssistant((state) => ({ open: true, expanded: true, resume, projectId: chosen?.id ?? null, scopeId, message, nonce: state.nonce + 1 }));
  };

  // Projeto da pergunta: o do ticket aberto na página; senão o do nó selecionado; senão o único visível; senão a folha pergunta.
  const chooseAskProject = (): Project | undefined => {
    const live_ = live.current;
    const byId = (id: string | null | undefined) => visibleProjects.find((project) => project.id === id);
    if (live_.openTicketId !== null) {
      const owner = Object.entries(ticketsByProject).find(([, list]) => list.some((entry) => entry.id === live_.openTicketId))?.[0];
      const chosen = byId(owner);
      if (chosen) return chosen;
    }
    if (live_.creating) {
      const chosen = byId(live_.creating.projectId);
      if (chosen) return chosen;
    }
    const current = live_.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    return byId(selectedProjectId) ?? (visibleProjects.length === 1 ? visibleProjects[0] : undefined);
  };
  // "Perguntar ao assistente «texto»" da barra. Com uma folha de pergunta já aberta no mesmo projeto, a pergunta a continua.
  const openAsk = (text: string) => {
    collapseAssistant();
    const chosen = chooseAskProject();
    const existing = live.current.ask;
    setAsk((state) => {
      const id = (state.question?.id ?? 0) + 1;
      if (state.open && state.projectId !== null && (chosen === undefined || chosen.id === state.projectId)) return { ...state, expanded: true, question: { id, text } };
      return { open: true, expanded: true, projectId: chosen?.id ?? null, question: { id, text }, nonce: state.nonce + 1 };
    });
    if (!(existing.open && existing.projectId !== null && (chosen === undefined || chosen.id === existing.projectId))) askProgressRef.current = false;
  };

  // "Continuar conversa": o título da conversa anterior do projeto que valeria para a conversa nova (ADR 0036).
  const loadResumable = async (): Promise<string | null> => {
    const chosen = chooseProject();
    if (!chosen) return null;
    try {
      const list = await client.listConversations(chosen.id);
      if (!list.ok) return null;
      const latest: ConversationSummary | undefined = list.data.filter((entry) => entry.status === "open").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!latest) return null;
      const title = latest.draft?.title.trim();
      if (title) return title;
      const detail = await client.getConversation(latest.id);
      if (!detail.ok) return null;
      const first = detail.data.messages.find((message) => message.author === "person")?.body.trim();
      return first ? (first.length > 80 ? `${first.slice(0, 80)}…` : first) : null;
    } catch {
      return null;
    }
  };

  // "Criar ticket «texto»" da barra: a conversa com a IA, ou a criação manual com o título preenchido (ADR 0036).
  const startCreateFromBar = (text: string) => {
    if (assistantAvailable) {
      openAssistant(text);
      return;
    }
    const current = live.current.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    const chosen = creatableProjects.find((project) => project.id === selectedProjectId) ?? creatableProjects[0];
    if (!chosen) return;
    setPanel((state) => (state.open ? { ...state, open: false } : state));
    if (live.current.openTicketId !== null) onOpenTicketChange(null);
    setCreating({ projectId: chosen.id, parentId: null, draft: { title: text, description: "" } });
  };

  // "Registrar ideia «texto»" da barra (ADR 0042): cria direto, sem conversa, no estágio "Nova" e abre a página. O projeto segue a
  // regra da criação manual; o pai é o ticket aberto ou selecionado, se for desse projeto, senão a raiz dele.
  const describeError = useDescribeApiError();
  const registerIdea = async (text: string): Promise<string | null> => {
    const current = live.current.selected;
    const anchorId = live.current.openTicketId ?? (current?.kind === "ticket" ? current.id : null);
    const anchor = anchorId === null ? undefined : Object.values(ticketsByProject).flat().find((ticket) => ticket.id === anchorId);
    const selectedProjectId = anchor?.projectId ?? (current?.kind === "project" ? current.id : null);
    const chosen = creatableProjects.find((project) => project.id === selectedProjectId) ?? creatableProjects[0];
    if (!chosen) return null;
    const parentId = anchor?.projectId === chosen.id ? anchor.id : null;
    const result = await client.createTicket(chosen.id, { ...splitIdeaText(text), ...(parentId === null ? {} : { parentId }), idea: true });
    if (!result.ok) return describeError(result.error);
    onChanged();
    openTicket(result.data.id);
    return null;
  };

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
          <nav className="spatial-breadcrumb" aria-label={t("breadcrumb")}>
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
            {t("panelToggle")}
          </button>
        </section>
      )}
      renderOverlay={() => (
        <>
          <CommandBar
            tickets={ticketsByProject}
            aside={pageOpen ? "ticket" : panel.open ? "areas" : "none"}
            canCreate={creatableProjects.length > 0}
            pickerActive={() => pickerRef.current !== null}
            onOpenTicket={openTicket}
            onCreate={startCreateFromBar}
            onRegisterIdea={registerIdea}
            returnFocus={() => canvasRef.current.stageRef.current?.focus()}
            conversation={!assistant.open ? "none" : assistant.expanded ? "expanded" : "collapsed"}
            assistantAvailable={assistantAvailable}
            loadResumable={loadResumable}
            onNewConversation={() => openAssistant()}
            onResumeConversation={() => openAssistant(null, true)}
            onReopenConversation={() => {
              collapseAsk();
              setAssistant((current) => (current.open ? { ...current, expanded: true } : current));
            }}
            onCollapseConversation={collapseAssistant}
            ask={!ask.open ? "none" : ask.expanded ? "expanded" : "collapsed"}
            canAsk={canAsk}
            onAsk={openAsk}
            onReopenAsk={() => {
              collapseAssistant();
              setAsk((current) => (current.open ? { ...current, expanded: true } : current));
            }}
            onCollapseAsk={collapseAsk}
            focusRequest={barFocus}
          >
            {ask.open && (
              <AskPanel
                key={ask.nonce}
                client={client}
                projects={visibleProjects}
                initialProjectId={ask.projectId}
                incoming={ask.question}
                tickets={ticketsByProject}
                expanded={ask.expanded}
                onCollapse={() => {
                  collapseAsk();
                  canvasRef.current.stageRef.current?.focus();
                }}
                onNew={() => {
                  closeAsk();
                  setBarFocus((current) => current + 1);
                }}
                onProgress={reportAskProgress}
                onOpenTicket={(ticketId) => {
                  collapseAsk();
                  openTicket(ticketId);
                }}
              />
            )}
            {assistant.open && (
              <AssistantPanel
                key={assistant.nonce}
                client={client}
                projects={creatableProjects}
                initialProjectId={assistant.projectId}
                initialScopeId={assistant.scopeId}
                initialMessage={assistant.message}
                expanded={assistant.expanded}
                resume={assistant.resume}
                tickets={ticketsByProject}
                onCollapse={() => {
                  collapseAssistant();
                  canvasRef.current.stageRef.current?.focus();
                }}
                onProgress={reportProgress}
                onCreated={(ticketId) => {
                  closeAssistant();
                  openTicket(ticketId);
                }}
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
          </CommandBar>
          {selected && selected.kind !== "draft" && selected.kind !== "ticket" && (
            <aside
              className={`spatial-selection ${panel.open ? "is-beside-panel" : ""}`}
              aria-label={t("selection.region")}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div>
                <code>{selected.key ?? t("organizationKey")}</code>
                <button onClick={() => selectNode(null)} aria-label={t("selection.close")}>×</button>
              </div>
              <strong>{selected.label}</strong>
              <p>{(() => {
                const count = index.childrenByParentId.get(selected.id)?.length ?? 0;
                return selected.kind === "project" ? t("count.items", { count }) : t("selection.projects", { count });
              })()}</p>
              <button onClick={() => focusNode(selected.id)}>{t("selection.explore")}</button>
            </aside>
          )}
          {showCreateFirst && (
            <button
              type="button"
              className="map-create-first"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setPanel({ open: true, tab: "projects", projectId: null })}
            >
              {t("createFirst")}
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
          <div className="spatial-help">{t("help")}</div>
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
        listedAgentWork={openTicketId === null ? undefined : Object.values(ticketsByProject).flat().find((ticket) => ticket.id === openTicketId)?.agentWork}
        creating={creating}
        onOpenTicket={openTicket}
        onClose={closePage}
        onChanged={onChanged}
        onRemoved={() => {
          closePage();
          selectNode(null);
        }}
        onShowOnMap={showOnMap}
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
  /** Ticket a que a câmera vai uma vez, sem abrir a página ("Ver no mapa" da tela "Ideias"); `onFocusHandled` avisa que foi tratado. */
  focusTicketId?: string | null;
  onFocusHandled?: () => void;
}

export function OrganizationMap({ client, me, onImport, openTicketId, onOpenTicketChange, focusTicketId = null, onFocusHandled }: OrganizationMapProps) {
  const { t } = useTranslation("map");
  const { state, reload, retry, update, version } = useApiResource(() => loadMapData(client));
  // O mapa se atualiza sozinho (ADR 0043): só troca os dados se a resposta difere do que está na tela.
  useAutoRefresh(async (isActive) => {
    const startedAt = version;
    const result = await loadMapData(client);
    if (!isActive() || !result.ok) return;
    update((current: MapData) => mergeMapData(current, result.data), startedAt);
  });
  const [ownTicketId, setOwnTicketId] = useState<string | null>(null);
  const controlled = openTicketId !== undefined;
  const changeTicket = useCallback((id: string | null) => {
    if (!controlled) setOwnTicketId(id);
    onOpenTicketChange?.(id);
  }, [controlled, onOpenTicketChange]);

  if (state.status === "loading") {
    return <p className="map-state" role="status">{t("loading")}</p>;
  }
  if (state.status === "error") {
    return (
      <div className="map-state">
        <LoadError error={state.error} onRetry={retry} />
      </div>
    );
  }
  return <MapView client={client} me={me} projects={state.data.projects} people={state.data.people} ticketsByProject={state.data.ticketsByProject} onChanged={reload} onImport={onImport} openTicketId={controlled ? openTicketId : ownTicketId} onOpenTicketChange={changeTicket} focusTicketId={focusTicketId} onFocusHandled={onFocusHandled} />;
}
