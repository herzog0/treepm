import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ApiClient, Me, Person, Project, ProjectMember, ProjectRole, ProjectVisibility, Team } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "./ConfirmAction.js";
import { ROLES, ROLE_LABELS, VISIBILITIES, VISIBILITY_LABELS } from "./labels.js";
import { safe } from "./safe.js";
import { useAction } from "./useAction.js";

interface ProjectDetailProps {
  client: ApiClient;
  me: Me;
  project: Project;
  onChanged: () => void;
  onBack: () => void;
}

const ActionError = ({ error }: { error: ReturnType<typeof useAction>["error"] }) =>
  error ? <p role="alert">{describeApiError(error)}</p> : null;

export function ProjectDetail({ client, me, project, onChanged, onBack }: ProjectDetailProps) {
  const canManage =
    me.roles.clerk === "admin" ||
    me.roles.projects.some((entry) => entry.projectId === project.id && entry.role === "manager");
  const people = useApiResource(() => safe(() => client.listPeople()));
  const teams = useApiResource(() => safe(() => client.listTeams()));

  return (
    <section aria-labelledby="project-title">
      <button type="button" className="panel-back" onClick={onBack}>
        Voltar para a lista
      </button>
      <h2 id="project-title">{project.name}</h2>
      <p>
        <code>{project.key}</code>
        {project.visibility === "private" && <small className="badge">Privado</small>}
        {project.archivedAt !== null && <small className="badge">Arquivado</small>}
      </p>

      {canManage ? (
        <ManageProject client={client} project={project} onChanged={onChanged} />
      ) : (
        <p>Visibilidade: {VISIBILITY_LABELS[project.visibility]}</p>
      )}

      <h3>Pessoas com acesso</h3>
      {people.state.status === "loading" && <p role="status">Carregando pessoas…</p>}
      {people.state.status === "error" && <LoadError error={people.state.error} onRetry={people.retry} />}
      {people.state.status === "ready" && (
        <MembersSection
          client={client}
          project={project}
          people={people.state.data}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}

      <h3>Times do projeto</h3>
      {teams.state.status === "loading" && <p role="status">Carregando times…</p>}
      {teams.state.status === "error" && <LoadError error={teams.state.error} onRetry={teams.retry} />}
      {teams.state.status === "ready" && (
        <TeamsSection client={client} project={project} teams={teams.state.data} canManage={canManage} onChanged={onChanged} />
      )}
    </section>
  );
}

function ManageProject({ client, project, onChanged }: { client: ApiClient; project: Project; onChanged: () => void }) {
  const [name, setName] = useState(project.name);
  const action = useAction();
  const archived = project.archivedAt !== null;

  useEffect(() => setName(project.name), [project.name]);

  const update = async (body: Parameters<ApiClient["updateProject"]>[1]) => {
    const result = await action.run(() => client.updateProject(project.id, body));
    if (result.ok) onChanged();
  };

  const trimmed = name.trim();
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed !== "" && trimmed !== project.name) void update({ name: trimmed });
  };

  return (
    <div className="panel-manage">
      <form className="panel-form" onSubmit={rename}>
        <label>
          Nome do projeto
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={action.busy || trimmed === "" || trimmed === project.name}>
          Salvar nome
        </button>
      </form>
      <label className="panel-field">
        Visibilidade
        <select
          value={project.visibility}
          disabled={action.busy}
          onChange={(event) => void update({ visibility: event.target.value as ProjectVisibility })}
        >
          {VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      {archived ? (
        <button type="button" disabled={action.busy} onClick={() => void update({ archived: false })}>
          Desarquivar projeto
        </button>
      ) : (
        <ConfirmAction label="Arquivar projeto" disabled={action.busy} onConfirm={() => void update({ archived: true })} />
      )}
      <ActionError error={action.error} />
    </div>
  );
}

function MembersSection({
  client,
  project,
  people,
  canManage,
  onChanged,
}: {
  client: ApiClient;
  project: Project;
  people: readonly Person[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const nameOf = (personId: string) => people.find((person) => person.id === personId)?.displayName ?? "Pessoa desconhecida";
  const candidates = people.filter((person) => person.active && !project.members.some((member) => member.personId === person.id));

  return (
    <>
      {project.members.length === 0 ? (
        <p>Ninguém tem papel neste projeto.</p>
      ) : (
        <ul className="panel-list" aria-label="Pessoas com acesso">
          {project.members.map((member) => (
            <MemberRow
              key={member.personId}
              client={client}
              projectId={project.id}
              member={member}
              name={nameOf(member.personId)}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {canManage && <AddMember client={client} projectId={project.id} candidates={candidates} onChanged={onChanged} />}
    </>
  );
}

function MemberRow({
  client,
  projectId,
  member,
  name,
  canManage,
  onChanged,
}: {
  client: ApiClient;
  projectId: string;
  member: ProjectMember;
  name: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const action = useAction();

  const changeRole = async (role: ProjectRole) => {
    const result = await action.run(() => client.putProjectMember(projectId, member.personId, { role }));
    if (result.ok) onChanged();
  };
  const revoke = async () => {
    const result = await action.run(() => client.removeProjectMember(projectId, member.personId));
    if (result.ok) onChanged();
  };

  return (
    <li>
      <div className="row">
        <span>{name}</span>
        {canManage ? (
          <span className="row-actions">
            <select
              aria-label={`Papel de ${name}`}
              value={member.role}
              disabled={action.busy}
              onChange={(event) => void changeRole(event.target.value as ProjectRole)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <ConfirmAction
              label="Revogar"
              accessibleLabel={`Revogar acesso de ${name}`}
              disabled={action.busy}
              onConfirm={() => void revoke()}
            />
          </span>
        ) : (
          <small>{ROLE_LABELS[member.role]}</small>
        )}
      </div>
      <ActionError error={action.error} />
    </li>
  );
}

function AddMember({
  client,
  projectId,
  candidates,
  onChanged,
}: {
  client: ApiClient;
  projectId: string;
  candidates: readonly Person[];
  onChanged: () => void;
}) {
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<ProjectRole>("reader");
  const action = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (personId === "") return;
    const result = await action.run(() => client.putProjectMember(projectId, personId, { role }));
    if (result.ok) {
      setPersonId("");
      onChanged();
    }
  };

  return (
    <form className="panel-form" onSubmit={(event) => void submit(event)}>
      <label>
        Pessoa
        <select value={personId} onChange={(event) => setPersonId(event.target.value)}>
          <option value="">Escolha uma pessoa</option>
          {candidates.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Papel da nova pessoa
        <select value={role} onChange={(event) => setRole(event.target.value as ProjectRole)}>
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={action.busy || personId === ""}>
        Dar acesso
      </button>
      <ActionError error={action.error} />
    </form>
  );
}

function TeamsSection({
  client,
  project,
  teams,
  canManage,
  onChanged,
}: {
  client: ApiClient;
  project: Project;
  teams: readonly Team[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const addAction = useAction();
  const removeAction = useAction();
  const candidates = teams.filter((team) => !project.teamIds.includes(team.id));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (teamId === "") return;
    const result = await addAction.run(() => client.putProjectTeam(project.id, teamId));
    if (result.ok) {
      setTeamId("");
      onChanged();
    }
  };
  const remove = async (id: string) => {
    const result = await removeAction.run(() => client.removeProjectTeam(project.id, id));
    if (result.ok) onChanged();
  };

  return (
    <>
      <p>Associar um time não dá acesso às pessoas dele; o acesso vem dos papéis acima.</p>
      {project.teamIds.length === 0 ? (
        <p>Nenhum time associado.</p>
      ) : (
        <ul className="panel-list" aria-label="Times do projeto">
          {project.teamIds.map((id) => {
            const name = teams.find((team) => team.id === id)?.name ?? "Time desconhecido";
            return (
              <li key={id}>
                <div className="row">
                  <span>{name}</span>
                  {canManage && (
                    <button
                      type="button"
                      aria-label={`Desassociar ${name}`}
                      disabled={removeAction.busy}
                      onClick={() => void remove(id)}
                    >
                      Desassociar
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ActionError error={removeAction.error} />
      {canManage && (
        <form className="panel-form" onSubmit={(event) => void add(event)}>
          <label>
            Time
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">Escolha um time</option>
              {candidates.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={addAction.busy || teamId === ""}>
            Associar time
          </button>
          <ActionError error={addAction.error} />
        </form>
      )}
    </>
  );
}
