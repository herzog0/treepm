import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTreeIndex } from "@treepm/domain";
import type { BootstrapData, TicketEdge, TicketStatus } from "@treepm/domain";
import { api } from "./api.js";
import { TreeCanvas } from "./components/TreeCanvas.js";
import { EdgeEditor, TicketPanel } from "./components/TicketPanel.js";
import { TicketForm } from "./components/TicketForm.js";
import { KanbanView, ListView } from "./components/WorkViews.js";
import { PrototypeExperience } from "./components/prototypes/PrototypeExperience.js";
import { parsePrototypeVariant } from "./components/prototypes/shared.js";
import type { PrototypeVariant } from "./components/prototypes/shared.js";

type View = "tree" | "list" | "kanban";

export function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [view, setView] = useState<View>("tree");
  const [prototypeVariant, setPrototypeVariant] = useState<PrototypeVariant | null>(() => import.meta.env.DEV ? parsePrototypeVariant(window.location.search) : null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const initialLoadRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const nextData = await api.bootstrap();
      startTransition(() => setData(nextData));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a API.");
    }
  }, []);
  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void load();
  }, [load]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"))) return;
      setSelectedTicketId(null);
      setSelectedEdgeId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const project = data?.projects[0];
  const tickets = useMemo(() => data?.tickets.filter((ticket) => ticket.projectId === project?.id) ?? [], [data, project?.id]);
  const treeIndex = useMemo(() => buildTreeIndex(tickets), [tickets]);
  const edges = useMemo(() => data?.edges.filter((edge) => edge.projectId === project?.id) ?? [], [data, project?.id]);
  const selectedTicket = selectedTicketId ? treeIndex.ticketById.get(selectedTicketId) : undefined;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const projectProgress = tickets.length > 0 ? treeIndex.projectProgress : null;

  const refresh = async (message: string) => {
    await load();
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };
  const showError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "A operação falhou.");
  const selectTicket = (ticketId: string) => {
    if (linkSourceId && project) {
      void api.createDependency(project.id, linkSourceId, ticketId).then(async (edge) => {
        await refresh("Dependência criada sem alterar a hierarquia.");
        setLinkSourceId(null);
        setSelectedTicketId(null);
        setSelectedEdgeId(edge.id);
      }).catch(showError);
      return;
    }
    setSelectedTicketId(ticketId);
    setSelectedEdgeId(null);
  };

  if (!project || !data) return <main className="loading-screen"><div className="brand-mark large">T</div><h1>TreePM</h1>{error ? <><p className="form-error">{error}</p><button className="button primary" onClick={() => void load()}>Tentar novamente</button></> : <p>Organizando a árvore do projeto…</p>}</main>;

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setView("tree"); }}><span className="brand-mark">T</span><span>TreePM<small>PROJECTS, IN PERSPECTIVE</small></span></a>
      <div className="project-identity"><span className="project-badge">{project.key}</span><div><strong>{project.name}</strong><span>{tickets.length} tickets · espaço demonstrativo</span></div></div>
      <div className="header-actions"><div className="local-badge"><span />Dados locais</div>{!prototypeVariant && <button className="button primary" onClick={() => { setFormParentId(null); setFormOpen(true); }}>+ Novo ticket</button>}</div>
    </header>
    <div className="project-subheader">
      {prototypeVariant ? <div className="proto-header-mode">EXPLORAÇÃO UX · variante {prototypeVariant}</div> : <nav className="view-tabs" aria-label="Visualizações do projeto">{([{ id: "tree", label: "Árvore", symbol: "⌘" }, { id: "list", label: "Lista", symbol: "≡" }, { id: "kanban", label: "Kanban", symbol: "▥" }] as const).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}><span aria-hidden="true">{item.symbol}</span>{item.label}</button>)}</nav>}
      {projectProgress && <div className="project-progress"><span>Progresso do projeto</span><strong>{projectProgress.doneLeaves}/{projectProgress.totalLeaves} folhas</strong><div className="progress-track"><span style={{ width: `${projectProgress.percent}%` }} /></div><b>{projectProgress.percent}%</b></div>}
    </div>
    {(error || notice) && <div className={`global-notice ${error ? "error" : ""}`} role="status"><span>{error || notice}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Dispensar aviso">×</button></div>}
    {linkSourceId && <div className="linking-bar"><span>Criando dependência de <strong>{treeIndex.ticketById.get(linkSourceId)?.title}</strong>. Selecione o destino na árvore.</span><button onClick={() => setLinkSourceId(null)}>Cancelar</button></div>}
    <main className={`workspace ${!prototypeVariant && (selectedTicket || selectedEdge) ? "with-panel" : ""}`}>
      <div className="primary-view">
        {prototypeVariant && <PrototypeExperience variant={prototypeVariant} data={{ project, tickets, users: data.users }} onVariantChange={setPrototypeVariant} />}
        {!prototypeVariant && view === "tree" && <TreeCanvas tickets={tickets} treeIndex={treeIndex} edges={edges} users={data.users} projectKey={project.key} selectedTicketId={selectedTicketId} selectedEdgeId={selectedEdgeId} linkSourceId={linkSourceId} onClearSelection={() => { setSelectedTicketId(null); setSelectedEdgeId(null); }} onSelectTicket={selectTicket} onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); setSelectedTicketId(null); }} onConnect={(sourceId, targetId) => {
          void api.createDependency(project.id, sourceId, targetId).then(() => refresh("Dependência criada.")).catch(showError);
        }} />}
        {!prototypeVariant && view === "list" && <ListView project={project} tickets={tickets} treeIndex={treeIndex} users={data.users} onSelect={selectTicket} onStatus={async (ticketId, status) => { await api.updateTicket(ticketId, { status }); await refresh("Status atualizado."); }} />}
        {!prototypeVariant && view === "kanban" && <KanbanView project={project} tickets={tickets} treeIndex={treeIndex} users={data.users} onSelect={selectTicket} onStatus={async (ticketId: string, status: TicketStatus) => { try { await api.updateTicket(ticketId, { status }); await refresh("Status atualizado."); } catch (cause) { showError(cause); } }} />}
      </div>
      {!prototypeVariant && selectedTicket && <TicketPanel key={selectedTicket.id} ticket={selectedTicket} tickets={tickets} users={data.users} projectKey={project.key} onClose={() => setSelectedTicketId(null)} onSave={async (input) => { await api.updateTicket(selectedTicket.id, input); await refresh("Ticket atualizado."); }} onDelete={async (recursive) => { await api.deleteTicket(selectedTicket.id, recursive); setSelectedTicketId(null); await refresh("Exclusão concluída e conexões associadas removidas."); }} onAddSubticket={() => { setFormParentId(selectedTicket.id); setFormOpen(true); }} onStartLink={() => { setView("tree"); setLinkSourceId(selectedTicket.id); }} />}
      {!prototypeVariant && selectedEdge && <EdgeEditor key={selectedEdge.id} edge={selectedEdge} tickets={tickets} onClose={() => setSelectedEdgeId(null)} onSave={async (style: TicketEdge["style"]) => { await api.updateEdge(selectedEdge.id, style); await refresh("Estilo salvo somente nesta conexão."); }} onDelete={async () => { await api.deleteEdge(selectedEdge.id); setSelectedEdgeId(null); await refresh("Dependência removida; hierarquia preservada."); }} />}
    </main>
    <footer className="app-footer"><span>Árvore top-down · progresso derivado das folhas</span><span>Protótipo executável local · autenticação e banco transacional são próximas etapas</span></footer>
    {!prototypeVariant && formOpen && <TicketForm project={project} tickets={tickets} users={data.users} initialParentId={formParentId} onClose={() => setFormOpen(false)} onCreated={() => refresh("Ticket criado na posição confirmada.")} />}
  </div>;
}
