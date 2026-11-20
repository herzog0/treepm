import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ApiClient, Me, Project, ProjectVisibility, TicketKind } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { ProjectDetail } from "./ProjectDetail.js";
import { PROJECT_KEY_HELP, PROJECT_KEY_PATTERN, VISIBILITIES, VISIBILITY_LABELS } from "./labels.js";
import { useAction } from "./useAction.js";

export interface ProjectsSectionProps {
  client: ApiClient;
  me: Me;
  /** Extra em relação ao brief: o mapa já carregou os projetos e os mantém atualizados. */
  projects: readonly Project[];
  selectedProject: Project | null;
  onChanged: () => void;
  onImportProject?: ((projectId: string) => void) | undefined;
  onCreateTicket?: ((projectId: string, kind: TicketKind) => void) | undefined;
  /** Com o assistente ligado, o botão flutuante do mapa é a ação principal e a criação manual vira secundária. */
  assistantAvailable?: boolean | undefined;
}

export function ProjectsSection({ client, me, projects, selectedProject, onChanged, onImportProject, onCreateTicket, assistantAvailable }: ProjectsSectionProps) {
  const [openId, setOpenId] = useState<string | null>(selectedProject?.id ?? null);
  // O projeto recém-criado pode demorar a chegar em `projects`; até lá usamos a resposta da API.
  const [created, setCreated] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const selectedId = selectedProject?.id ?? null;

  // Um clique novo em um nó do mapa (a seleção mudou) abre aquele projeto aqui dentro.
  useEffect(() => {
    if (selectedId !== null) setOpenId(selectedId);
  }, [selectedId]);

  const canCreate = me.roles.clerk === "admin";
  const open = projects.find((project) => project.id === openId) ?? (created?.id === openId ? created : null);

  if (open) {
    return (
      <ProjectDetail
        key={open.id}
        client={client}
        me={me}
        project={open}
        onChanged={onChanged}
        onBack={() => setOpenId(null)}
        onImport={onImportProject}
        onCreateTicket={onCreateTicket}
        assistantAvailable={assistantAvailable}
      />
    );
  }

  const showForm = canCreate && (creating || projects.length === 0);

  return (
    <section aria-labelledby="projects-title">
      <h2 id="projects-title">Projetos</h2>
      {canCreate && projects.length > 0 && !creating && (
        <button type="button" className="panel-add" onClick={() => setCreating(true)}>
          Novo projeto
        </button>
      )}
      {showForm && (
        <CreateProjectForm
          client={client}
          onCancel={projects.length > 0 ? () => setCreating(false) : null}
          onCreated={(project) => {
            setCreated(project);
            setOpenId(project.id);
            setCreating(false);
            onChanged();
          }}
        />
      )}
      {projects.length === 0 ? (
        !canCreate && <p>Nenhum projeto criado.</p>
      ) : (
        <ul className="panel-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button type="button" className="panel-item" onClick={() => setOpenId(project.id)}>
                <span>{project.name}</span> <code>{project.key}</code>
                {project.visibility === "private" && <small className="badge">Privado</small>}
                {project.archivedAt !== null && <small className="badge">Arquivado</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateProjectForm({
  client,
  onCancel,
  onCreated,
}: {
  client: ApiClient;
  onCancel: (() => void) | null;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("organization");
  const [nameMissing, setNameMissing] = useState(false);
  const [keyInvalid, setKeyInvalid] = useState(false);
  const action = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const badName = trimmed === "";
    const badKey = !PROJECT_KEY_PATTERN.test(key);
    setNameMissing(badName);
    setKeyInvalid(badKey);
    if (badName || badKey) return;
    const result = await action.run(() => client.createProject({ name: trimmed, key, visibility }));
    if (result.ok) onCreated(result.data);
  };

  const keyTaken = action.error?.code === "project_key_taken";
  const keyMessage = keyInvalid ? PROJECT_KEY_HELP : keyTaken && action.error ? describeApiError(action.error) : null;

  return (
    <form className="panel-form" onSubmit={(event) => void submit(event)} aria-label="Novo projeto">
      <label>
        Nome
        <input value={name} onChange={(event) => setName(event.target.value)} aria-invalid={nameMissing} />
      </label>
      {nameMissing && <p role="alert">Informe o nome do projeto.</p>}
      <label>
        Chave
        <input
          value={key}
          onChange={(event) => setKey(event.target.value.toUpperCase())}
          aria-invalid={keyMessage !== null}
          aria-describedby={keyMessage !== null ? "project-key-message" : undefined}
        />
      </label>
      {keyMessage !== null && (
        <p role="alert" id="project-key-message">
          {keyMessage}
        </p>
      )}
      <label>
        Visibilidade
        <select value={visibility} onChange={(event) => setVisibility(event.target.value as ProjectVisibility)}>
          {VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <div className="row-actions">
        <button type="submit" className="primary" disabled={action.busy}>
          Criar projeto
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
      {action.error && !keyTaken && <p role="alert">{describeApiError(action.error)}</p>}
    </form>
  );
}
