import type { ApiClient, Me, Project } from "../api/client.js";

export interface ProjectsSectionProps {
  client: ApiClient;
  me: Me;
  /** Extra em relação ao brief: o mapa já carregou os projetos e os mantém atualizados. */
  projects: readonly Project[];
  selectedProject: Project | null;
  onChanged: () => void;
}

/** Nesta fatia: só a lista somente leitura. Criação e edição entram em outra tarefa. */
export function ProjectsSection({ projects, selectedProject }: ProjectsSectionProps) {
  return (
    <section aria-labelledby="projects-title">
      <h2 id="projects-title">Projetos</h2>
      {projects.length === 0 ? (
        <p>Nenhum projeto criado.</p>
      ) : (
        <ul className="panel-list">
          {projects.map((project) => (
            <li key={project.id} aria-current={project.id === selectedProject?.id ? "true" : undefined}>
              <span>{project.name}</span> <code>{project.key}</code>
              {project.archivedAt !== null && <small> (arquivado)</small>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
