import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { ApiClient, Me, Project } from "../api/client.js";
import { AreasSection } from "./AreasSection.js";
import { ProjectsSection } from "./ProjectsSection.js";
import "./panel.css";

export type PanelTab = "areas" | "projects";

export interface SidePanelProps {
  client: ApiClient;
  me: Me;
  /** Projetos do mapa (não arquivados e arquivados), já carregados e mantidos pelo mapa. */
  projects: readonly Project[];
  tab: PanelTab;
  selectedProjectId: string | null;
  onTabChange: (tab: PanelTab) => void;
  onClose: () => void;
  /** Chamado depois de qualquer alteração no servidor, para o mapa recarregar os projetos. */
  onChanged: () => void;
  /** Abre a tela de importação de um projeto; sem ela, o detalhe do projeto não oferece a ação. */
  onImportProject?: (projectId: string) => void;
  /** Abre a criação de um ticket na raiz do projeto; sem ela, o detalhe do projeto não oferece a ação. */
  onCreateTicket?: (projectId: string) => void;
}

const TABS: readonly { tab: PanelTab; label: string }[] = [
  { tab: "areas", label: "Áreas" },
  { tab: "projects", label: "Projetos" },
];

const stop = (event: PointerEvent) => event.stopPropagation();

/** Sobreposição à direita do mapa. Nada do que acontece aqui dentro chega aos gestos e atalhos do mapa. */
export function SidePanel({ client, me, projects, tab, selectedProjectId, onTabChange, onClose, onChanged, onImportProject, onCreateTicket }: SidePanelProps) {
  const ref = useRef<HTMLElement>(null);

  // A roda é um listener nativo no palco do mapa: só um listener nativo aqui o intercepta.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => event.stopPropagation();
    element.addEventListener("wheel", onWheel);
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // Foco entra no painel ao abrir e volta a quem o abriu ao fechar.
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") onClose();
  };

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <aside
      ref={ref}
      className="side-panel"
      aria-label="Áreas e projetos"
      tabIndex={-1}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    >
      <header className="side-panel-header">
        <div role="tablist" aria-label="Seções do painel">
          {TABS.map((item) => (
            <button
              key={item.tab}
              type="button"
              role="tab"
              id={`side-panel-tab-${item.tab}`}
              aria-selected={tab === item.tab}
              aria-controls="side-panel-body"
              onClick={() => onTabChange(item.tab)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="side-panel-close" onClick={onClose}>
          Fechar
        </button>
      </header>
      <div className="side-panel-body" id="side-panel-body" role="tabpanel" aria-labelledby={`side-panel-tab-${tab}`}>
        {tab === "areas" ? (
          <AreasSection client={client} me={me} selectedProject={selectedProject} onChanged={onChanged} />
        ) : (
          <ProjectsSection client={client} me={me} projects={projects} selectedProject={selectedProject} onChanged={onChanged} {...(onImportProject ? { onImportProject } : {})} {...(onCreateTicket ? { onCreateTicket } : {})} />
        )}
      </div>
    </aside>
  );
}
