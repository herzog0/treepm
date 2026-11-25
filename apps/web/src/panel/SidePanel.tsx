import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
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
  onImportProject?: (projectId: string, mode?: "sync") => void;
  /** Abre a criação de um ticket na raiz do projeto; sem ela, o detalhe do projeto não oferece a ação. */
  onCreateTicket?: (projectId: string) => void;
  assistantAvailable?: boolean;
}

const TABS: readonly PanelTab[] = ["areas", "projects"];

const stop = (event: PointerEvent) => event.stopPropagation();

/** Sobreposição à direita do mapa. Nada do que acontece aqui dentro chega aos gestos e atalhos do mapa. */
export function SidePanel({ client, me, projects, tab, selectedProjectId, onTabChange, onClose, onChanged, onImportProject, onCreateTicket, assistantAvailable }: SidePanelProps) {
  const { t } = useTranslation("panel");
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
      aria-label={t("panel.label")}
      tabIndex={-1}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    >
      <header className="side-panel-header">
        <div role="tablist" aria-label={t("panel.sections")}>
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`side-panel-tab-${item}`}
              aria-selected={tab === item}
              aria-controls="side-panel-body"
              onClick={() => onTabChange(item)}
            >
              {t(`panel.tabs.${item}`)}
            </button>
          ))}
        </div>
        <button type="button" className="side-panel-close" onClick={onClose}>
          {t("panel.close")}
        </button>
      </header>
      <div className="side-panel-body" id="side-panel-body" role="tabpanel" aria-labelledby={`side-panel-tab-${tab}`}>
        {tab === "areas" ? (
          <AreasSection client={client} me={me} selectedProject={selectedProject} onChanged={onChanged} />
        ) : (
          <ProjectsSection client={client} me={me} projects={projects} selectedProject={selectedProject} onChanged={onChanged} {...(onImportProject ? { onImportProject } : {})} {...(onCreateTicket ? { onCreateTicket } : {})} assistantAvailable={assistantAvailable} />
        )}
      </div>
    </aside>
  );
}
