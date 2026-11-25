import { SpatialCanvasView, useSpatialCanvas } from "@treepm/react";
import type { SpatialCanvasLabels, SpatialNodeContent } from "@treepm/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, Me, Person, Project, TicketSummary } from "../api/client.js";
import { useTranslation } from "react-i18next";
import { useApiResource } from "../api/useApiResource.js";
import { emptyQueueReason, playTemplate, playTemplates, workQueue } from "@treepm/domain";
import type { PlayInput, PlayTemplateId, WorkScope } from "@treepm/domain";
import { CommandBar } from "../command/CommandBar.js";
import { PlayBar } from "../play/PlayBar.js";
import { toWorkTickets, turnOf } from "../play/playModel.js";
import type { PlayRun } from "../play/playModel.js";
import { splitIdeaText } from "../command/ideaText.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useChats } from "../chat/ChatsContext.js";
import { RecentPlacesProvider } from "../assistant/RecentPlacesContext.js";
import { createRecentPlaces } from "../assistant/recentPlaces.js";
import type { MapPicker } from "../assistant/types.js";
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
import { StatusLegend } from "./StatusLegend.js";
import { renderNodeContent } from "./nodeContent.js";
import "@treepm/react/styles.css";
import "../demo/Demo.css";
import "./map.css";
import "./status-mark.css";
import "./agent-work.css";
import "../assistant/assistant.css";
import type { CommandRequest } from "./commandRequest.js";

const getLabel = (node: MapNode) => node.label;
const getColor = (node: MapNode) => node.color;
const describeNode = (node: MapNode) => (node.key ? `${node.key} · ${node.label}` : node.label);
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
  onImport: ((projectId: string, mode?: "sync") => void) | undefined;
  openTicketId: string | null;
  onOpenTicketChange: (ticketId: string | null) => void;
  focusTicketId: string | null;
  onFocusHandled: (() => void) | undefined;
  commandRequest: CommandRequest | null;
  onCommandHandled: (() => void) | undefined;
}

function MapView({ client, me, projects, people, ticketsByProject, onChanged, onImport, openTicketId, onOpenTicketChange, focusTicketId, onFocusHandled, commandRequest, onCommandHandled }: MapViewProps) {
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
  const pickerRef = useRef<MapPicker | null>(null);
  const creatableProjects = useMemo(() => projects.filter((project) => canCreateTickets(me, project)), [me, projects]);
  const assistantAvailable = me.assistant?.enabled === true && creatableProjects.length > 0;
  // Conversar no Meu chat não exige poder criar: qualquer pessoa com a IA ligada manda o texto livre ao Meu chat (ADR 0056).
  const chats = useChats();
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const canChat = me.assistant?.enabled === true;
  const [barFocus, setBarFocus] = useState(0);
  // Modo play (ADR 0048): a lista fotografada ao começar e a posição; só em memória, nada é gravado.
  const [play, setPlay] = useState<PlayRun | null>(null);
  const [playFocus, setPlayFocus] = useState(0);
  const [playNotice, setPlayNotice] = useState<string | null>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const { t: tPlay } = useTranslation("play");

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const pageOpen = openTicketId !== null || creating !== null;
  // Os lugares em que a pessoa esteve agora há pouco (TREEPM-358): guardados neste navegador, por organização, projeto e pessoa.
  const recents = useMemo(() => createRecentPlaces(me.organization.orgId, me.person.id), [me.organization.orgId, me.person.id]);
  const openedProjectId = openTicketId === null ? null : Object.values(ticketsByProject).flat().find((ticket) => ticket.id === openTicketId)?.projectId ?? null;
  useEffect(() => {
    if (openTicketId !== null && openedProjectId !== null) recents.record(openedProjectId, openTicketId);
  }, [openTicketId, openedProjectId, recents]);
  // Valores que os ouvintes (seleção, teclado) leem sem precisar ser refeitos a cada render.
  const live = useRef({ selectedId: null as string | null, selected: null as MapNode | null, pageOpen, openTicketId, creating, panelOpen: false, play: null as PlayRun | null });

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
  live.current = { selectedId, selected, pageOpen, openTicketId, creating, panelOpen: panel.open, play };
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

  // ---- Modo play (ADR 0047, ADR 0048) ----
  const workTickets = useMemo(() => toWorkTickets(ticketsByProject), [ticketsByProject]);
  const playFrame = useRef(0);
  const showOnMapRef = useRef(showOnMap);
  showOnMapRef.current = showOnMap;
  const workTicketsRef = useRef(workTickets);
  workTicketsRef.current = workTickets;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const playPeople = useCallback(() => peopleRef.current.map((person) => ({ id: person.id, displayName: person.displayName })), []);

  // O alcance é o ramo selecionado no mapa (projeto ou ticket); sem seleção, tudo o que a pessoa enxerga.
  const currentScope = (): { scope: WorkScope; label: string } => {
    const node = live.current.selected;
    if (node?.kind === "ticket" && node.ticket) return { scope: { ticketId: node.ticket.id }, label: tPlay("menu.scopeIn", { key: node.ticket.key, title: node.ticket.title }) };
    if (node?.kind === "project") return { scope: { projectId: node.id }, label: tPlay("menu.scopeIn", { key: node.key ?? "", title: node.label }) };
    return { scope: {}, label: tPlay("menu.scopeAll") };
  };
  const playInput = (scope: WorkScope): PlayInput => ({ tickets: workTicketsRef.current, people: playPeople(), me: me.person.id, scope, now: Date.now() });

  // Leva a câmera e a página ao ticket do passo, como um clique (ou "Ver no mapa" se ele já está aberto). Ticket que sumiu: a página fecha.
  const visitStep = (run: PlayRun, index: number) => {
    const ticketId = run.steps[index]?.ticketId;
    if (ticketId === undefined) return;
    if (!workTicketsRef.current.some((ticket) => ticket.id === ticketId)) {
      closePage();
      return;
    }
    if (live.current.openTicketId === ticketId) showOnMap(ticketId);
    else openTicket(ticketId);
    // A câmera vai de qualquer jeito, pelo caminho de "Ver no mapa": o enquadramento da abertura só dispara quando o ticket está no
    // layout da hora, e o play precisa que ele chegue em todo passo. Dois quadros, para o palco estreitar antes (como no enquadramento).
    cancelAnimationFrame(playFrame.current);
    playFrame.current = requestAnimationFrame(() => {
      playFrame.current = requestAnimationFrame(() => showOnMapRef.current(ticketId));
    });
  };
  const goToStep = (index: number) => {
    const run = live.current.play;
    if (!run || index < 0 || index >= run.steps.length) return;
    const next = { ...run, index };
    live.current.play = next;
    setPlay(next);
    visitStep(next, index);
  };
  const startPlay = (id: PlayTemplateId) => {
    const { scope, label } = currentScope();
    const template = playTemplate(id, playInput(scope));
    if (template.steps.length === 0) return;
    const run: PlayRun = { template: id, scope, scopeLabel: label, steps: template.steps, index: 0 };
    live.current.play = run;
    setPlayNotice(null);
    setPlay(run);
    visitStep(run, 0);
  };
  const exitPlay = (notice: string | null = null) => {
    live.current.play = null;
    setPlay(null);
    setPlayNotice(notice);
    setPlayFocus((count) => count + 1);
  };
  const restartPlay = () => {
    const run = live.current.play;
    if (!run) return;
    const template = playTemplate(run.template, playInput(run.scope));
    if (template.steps.length === 0) {
      exitPlay(tPlay("ended"));
      return;
    }
    const next: PlayRun = { ...run, steps: template.steps, index: 0 };
    live.current.play = next;
    setPlay(next);
    visitStep(next, 0);
  };
  const exitRef = useRef(exitPlay);
  exitRef.current = exitPlay;
  const goRef = useRef(goToStep);
  goRef.current = goToStep;

  // As teclas do play: seta para a direita ou J avança; seta para a esquerda ou K volta; Esc sai (com a página aberta o primeiro Esc a
  // fecha, como sempre). Em fase de captura, porque a página do ticket para a propagação das teclas; não agem num campo de texto,
  // num editor ou num menu aberto.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const run = live.current.play;
      if (!run || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=''], [contenteditable='true'], [role=menu], [role=listbox], [role=combobox], [role=dialog]")) return;
      if (target?.closest("[aria-expanded='true']") && target.matches("button")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "ArrowRight" || key === "j") {
        event.preventDefault();
        goRef.current(run.index + 1);
      } else if (key === "ArrowLeft" || key === "k") {
        event.preventDefault();
        goRef.current(run.index - 1);
      } else if (key === "Escape") {
        const l = live.current;
        if (l.pageOpen || l.creating || l.panelOpen || pickerRef.current) return;
        event.preventDefault();
        exitRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  // Ao começar, o foco vai ao "Avançar" da barra do play (a página do ticket não o toma enquanto ele estiver ali).
  const playing = play !== null;
  useEffect(() => {
    if (playing) nextButton.current?.focus();
  }, [playing]);
  // O aviso de que o play terminou some sozinho.
  useEffect(() => {
    if (playNotice === null) return;
    const timer = setTimeout(() => setPlayNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [playNotice]);

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
      if (event.key === "Escape" && live.current.pageOpen) {
        if (live.current.creating) setCreating(null);
        else closePage();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePage]);

  // Projeto da conversa: o do ticket ou do projeto selecionado; sem seleção, o único em que a pessoa pode criar.
  const chooseProject = () => {
    const current = live.current.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    return creatableProjects.find((project) => project.id === selectedProjectId) ?? (creatableProjects.length === 1 ? creatableProjects[0] : undefined);
  };
  // A thread de criação (ADR 0056) mora na coluna da conversa, fora do mapa: o mapa lhe empresta o projeto aberto e as ações dele.
  const scopeTicketId = () => {
    const current = live.current.selected;
    return current?.kind === "ticket" ? current.id : live.current.openTicketId;
  };
  const hostRef = useRef({ chooseProject, scopeTicketId, onChanged, setCreating, setDraft });
  hostRef.current = { chooseProject, scopeTicketId, onChanged, setCreating, setDraft };
  const setMapHost = chats?.setMapHost;
  useEffect(() => {
    if (!setMapHost) return;
    setMapHost({
      projectId: () => hostRef.current.chooseProject()?.id ?? null,
      creatable: creatableProjects,
      scopeTicketId: () => hostRef.current.scopeTicketId(),
      registerPicker: (picker) => {
        pickerRef.current = picker;
      },
      onDraftChange: (next) => hostRef.current.setDraft(next),
      onChanged: () => hostRef.current.onChanged(),
      onManualCreate: (request) => hostRef.current.setCreating(request),
    });
    return () => setMapHost(null);
  }, [setMapHost, creatableProjects]);

  // "Novo ticket" e "Buscar" da barra lateral (ADR 0055): o pedido vale uma vez. Sem assistente (ou sem projeto onde criar) "Novo ticket" só leva o foco ao campo.
  const commandHandled = useRef(onCommandHandled);
  commandHandled.current = onCommandHandled;
  useEffect(() => {
    if (commandRequest === null) return;
    if (commandRequest.kind === "new" && assistantAvailable && chatsRef.current) chatsRef.current.startNewTicket();
    else setBarFocus((current) => current + 1);
    commandHandled.current?.();
  }, [commandRequest, assistantAvailable]);

  // "Criar ticket «texto»" da barra: a conversa com a IA, ou a criação manual com o título preenchido (ADR 0036).
  const startCreateFromBar = (text: string): string | null => {
    // Com a IA, o texto vira uma thread de criação no Meu chat (ADR 0056); a recusa (já há um pedido em andamento) volta à barra.
    if (assistantAvailable && chatsRef.current) return chatsRef.current.startCreation(text);
    const current = live.current.selected;
    const selectedProjectId = current?.kind === "project" ? current.id : current?.kind === "ticket" ? current.ticket?.projectId ?? null : null;
    const chosen = creatableProjects.find((project) => project.id === selectedProjectId) ?? creatableProjects[0];
    if (!chosen) return "";
    setPanel((state) => (state.open ? { ...state, open: false } : state));
    if (live.current.openTicketId !== null) onOpenTicketChange(null);
    setCreating({ projectId: chosen.id, parentId: null, draft: { title: text, description: "" } });
    return null;
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

  // "Próximo ticket para trabalhar" da barra (ADR 0047): o primeiro da fila do alcance selecionado; nada é mudado. Fila vazia: o motivo.
  const nextTicket = () => {
    const { scope } = currentScope();
    const [next] = workQueue(workTicketsRef.current, me.person.id, scope);
    if (next === undefined) return emptyQueueReason(workTicketsRef.current, me.person.id, scope) ?? "none";
    if (live.current.openTicketId === next) showOnMap(next);
    else openTicket(next);
    return null;
  };

  const playStepTicket = play === null ? undefined : Object.values(ticketsByProject).flat().find((ticket) => ticket.id === play.steps[play.index]?.ticketId);
  const playTurn = play === null ? null : turnOf(play.steps, play.index);
  const playBar =
    play === null ? null : (
      <PlayBar
        ref={nextButton}
        template={play.template}
        scopeText={play.scopeLabel}
        current={play.index + 1}
        total={play.steps.length}
        person={playTurn === null ? null : { name: people.find((person) => person.id === playTurn.personId)?.displayName ?? "—", position: playTurn.position, total: playTurn.total }}
        ticket={playStepTicket === undefined ? null : { key: playStepTicket.key, title: playStepTicket.title }}
        onPrevious={() => goToStep(play.index - 1)}
        onNext={() => goToStep(play.index + 1)}
        onRestart={restartPlay}
        onExit={() => exitPlay()}
      />
    );

  const canCreateProject = me.roles.clerk === "admin";
  const showCreateFirst = items.length === 1 && canCreateProject;

  return (
    <RecentPlacesProvider value={recents}>
    <div className={`map-workspace ${pageOpen ? "has-ticket-page" : ""} ${play !== null ? "has-play" : ""}`}>
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
            onNextTicket={nextTicket}
            play={{
              menu: () => {
                const { scope, label } = currentScope();
                return { scopeText: label, templates: playTemplates(playInput(scope)) };
              },
              onStart: startPlay,
              bar: playBar,
              focusRequest: playFocus,
              notice: playNotice,
            }}
            returnFocus={() => canvasRef.current.stageRef.current?.focus()}
            canChat={canChat}
            onChat={(text) => (chats ? chats.startTopic(text) : "")}
            onOpenChat={() => chats?.openGeneral()}
            focusRequest={barFocus}
          />
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
          <StatusLegend />
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
    </RecentPlacesProvider>
  );
}

export interface OrganizationMapProps {
  client: ApiClient;
  me: Me;
  /** Abre a tela de importação do projeto (ADR 0025). Sem ela, o painel não oferece a ação. */
  onImport?: (projectId: string, mode?: "sync") => void;
  /** Ticket aberto na página (`?ticket=` da URL). Sem esta prop, o mapa guarda o estado sozinho. */
  openTicketId?: string | null;
  onOpenTicketChange?: (ticketId: string | null) => void;
  /** Ticket a que a câmera vai uma vez, sem abrir a página ("Ver no mapa" da tela "Ideias"); `onFocusHandled` avisa que foi tratado. */
  focusTicketId?: string | null;
  onFocusHandled?: () => void;
  /** Pedido da barra lateral ("Novo ticket", "Buscar"); `onCommandHandled` avisa que foi tratado. */
  commandRequest?: CommandRequest | null;
  onCommandHandled?: () => void;
}

export function OrganizationMap({ client, me, onImport, openTicketId, onOpenTicketChange, focusTicketId = null, onFocusHandled, commandRequest = null, onCommandHandled }: OrganizationMapProps) {
  const { t } = useTranslation("map");
  const { state, reload, retry, update, version } = useApiResource(() => loadMapData(client));
  // O mapa se atualiza sozinho (ADR 0043): só troca os dados se a resposta difere do que está na tela.
  useAutoRefresh(async (isActive) => {
    const startedAt = version;
    if (state.status !== "ready") return;
    const result = await loadMapData(client, state.data); // com as versões que a tela tem: o servidor responde 304 se nada mudou (ADR 0046)
    if (!isActive() || !result.ok) return;
    update((current: MapData) => mergeMapData(current, result.data), startedAt);
  });
  // O chat usa os tickets que o mapa já leu (e que ele mantém atualizados) em vez de pedir de novo (ADR 0056).
  const shareTickets = useChats()?.shareTickets;
  const shared = state.status === "ready" ? state.data.ticketsByProject : null;
  useEffect(() => shareTickets?.(shared), [shareTickets, shared]);
  useEffect(() => () => shareTickets?.(null), [shareTickets]);
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
  return <MapView client={client} me={me} projects={state.data.projects} people={state.data.people} ticketsByProject={state.data.ticketsByProject} onChanged={reload} onImport={onImport} openTicketId={controlled ? openTicketId : ownTicketId} onOpenTicketChange={changeTicket} focusTicketId={focusTicketId} onFocusHandled={onFocusHandled} commandRequest={commandRequest} onCommandHandled={onCommandHandled} />;
}
