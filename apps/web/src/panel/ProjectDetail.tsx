import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person, Project, ProjectMember, ProjectRole, ProjectVisibility, Team } from "../api/client.js";
import { githubEnabled } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { ProjectRepositories } from "../github/ProjectRepositories.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "./ConfirmAction.js";
import { ROLES, VISIBILITIES } from "./labels.js";
import { canCreateTickets } from "../import/permissions.js";
import { TestBadge, useNameWithBadge } from "../people/TestBadge.js";
import { safe } from "./safe.js";
import { useAction } from "./useAction.js";

interface ProjectDetailProps {
  client: ApiClient;
  me: Me;
  project: Project;
  onChanged: () => void;
  onBack: () => void;
  /** Abre a tela de importação deste projeto; sem ela a ação não aparece. */
  onImport?: ((projectId: string, mode?: "sync") => void) | undefined;
  /** Abre a página do ticket em modo de criação, na raiz deste projeto, do tipo pedido; sem ela as ações não aparecem. */
  onCreateTicket?: ((projectId: string) => void) | undefined;
  assistantAvailable?: boolean | undefined;
}

const ActionError = ({ error }: { error: ReturnType<typeof useAction>["error"] }) => {
  const describeError = useDescribeApiError();
  return error ? <p role="alert">{describeError(error)}</p> : null;
};

export function ProjectDetail({ client, me, project, onChanged, onBack, onImport, onCreateTicket, assistantAvailable = false }: ProjectDetailProps) {
  const { t } = useTranslation("panel");
  const canManage =
    me.roles.clerk === "admin" ||
    me.roles.projects.some((entry) => entry.projectId === project.id && entry.role === "manager");
  const people = useApiResource(() => safe(() => client.listPeople()));
  const teams = useApiResource(() => safe(() => client.listTeams()));
  // "Sincronizar com o Linear" (ADR 0061) só para quem pode importar, em projeto ligado a um time; sem Linear no servidor a pergunta falha e o botão não aparece.
  const importable = canCreateTickets(me, project) && onImport !== undefined;
  const linear = useApiResource(() => (importable ? safe(() => client.getProjectLinear(project.id)) : Promise.resolve({ ok: true as const, data: null })));
  const linked = linear.state.status === "ready" && linear.state.data !== null && linear.state.data.source !== null;

  return (
    <section aria-labelledby="project-title">
      <button type="button" className="panel-back" onClick={onBack}>
        {t("detail.back")}
      </button>
      <h2 id="project-title">{project.name}</h2>
      <p>
        <code>{project.key}</code>
        {project.visibility === "private" && <small className="badge">{t("projects.private")}</small>}
        {project.archivedAt !== null && <small className="badge">{t("projects.archived")}</small>}
      </p>

      {canCreateTickets(me, project) && (onCreateTicket || onImport) && (
        <div className="panel-ticket-actions">
          {onCreateTicket && (
            <button type="button" className={`panel-new-ticket ${assistantAvailable ? "" : "primary"}`} onClick={() => onCreateTicket(project.id)}>
              {assistantAvailable ? t("detail.newTicketNoAssistant") : t("detail.newTicket")}
            </button>
          )}
          {onImport && linked && (
            <button type="button" className="panel-import" onClick={() => onImport(project.id, "sync")}>
              {t("detail.syncLinear")}
            </button>
          )}
          {onImport && (
            <button type="button" className="panel-import" onClick={() => onImport(project.id)}>
              {t("detail.import")}
            </button>
          )}
        </div>
      )}

      {canManage ? (
        <ManageProject client={client} project={project} onChanged={onChanged} />
      ) : (
        <p>{t("detail.visibilityLine", { value: t(`visibility.${project.visibility}`) })}</p>
      )}

      <h3>{t("detail.people.title")}</h3>
      {people.state.status === "loading" && <p role="status">{t("detail.people.loading")}</p>}
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

      {githubEnabled(me) && <ProjectRepositories client={client} me={me} project={project} />}

      <h3>{t("detail.teams.title")}</h3>
      {teams.state.status === "loading" && <p role="status">{t("detail.teams.loading")}</p>}
      {teams.state.status === "error" && <LoadError error={teams.state.error} onRetry={teams.retry} />}
      {teams.state.status === "ready" && (
        <TeamsSection client={client} project={project} teams={teams.state.data} canManage={canManage} onChanged={onChanged} />
      )}
    </section>
  );
}

function ManageProject({ client, project, onChanged }: { client: ApiClient; project: Project; onChanged: () => void }) {
  const { t } = useTranslation("panel");
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
          {t("detail.manage.nameLabel")}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={action.busy || trimmed === "" || trimmed === project.name}>
          {t("detail.manage.saveName")}
        </button>
      </form>
      <label className="panel-field">
        {t("projects.form.visibility")}
        <select
          value={project.visibility}
          disabled={action.busy}
          onChange={(event) => void update({ visibility: event.target.value as ProjectVisibility })}
        >
          {VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {t(`visibility.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {archived ? (
        <button type="button" disabled={action.busy} onClick={() => void update({ archived: false })}>
          {t("detail.manage.unarchive")}
        </button>
      ) : (
        <ConfirmAction label={t("detail.manage.archive")} disabled={action.busy} onConfirm={() => void update({ archived: true })} />
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
  const { t } = useTranslation("panel");
  const nameOf = (personId: string) => people.find((person) => person.id === personId)?.displayName ?? t("detail.people.unknown");
  const candidates = people.filter((person) => person.active && !project.members.some((member) => member.personId === person.id));

  return (
    <>
      {project.members.length === 0 ? (
        <p>{t("detail.people.nobody")}</p>
      ) : (
        <ul className="panel-list" aria-label={t("detail.people.title")}>
          {project.members.map((member) => (
            <MemberRow
              key={member.personId}
              client={client}
              projectId={project.id}
              member={member}
              name={nameOf(member.personId)}
              isTest={people.find((person) => person.id === member.personId)?.isTest}
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
  isTest,
  canManage,
  onChanged,
}: {
  client: ApiClient;
  projectId: string;
  member: ProjectMember;
  name: string;
  isTest?: boolean | undefined;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("panel");
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
        <TestBadge person={{ isTest }} />
        {canManage ? (
          <span className="row-actions">
            <select
              aria-label={t("detail.people.roleOf", { name })}
              value={member.role}
              disabled={action.busy}
              onChange={(event) => void changeRole(event.target.value as ProjectRole)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`roles.${role}`)}
                </option>
              ))}
            </select>
            <ConfirmAction
              label={t("detail.people.revoke")}
              accessibleLabel={t("detail.people.revokeLabel", { name })}
              disabled={action.busy}
              onConfirm={() => void revoke()}
            />
          </span>
        ) : (
          <small>{t(`roles.${member.role}`)}</small>
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
  const { t } = useTranslation("panel");
  const nameWithBadge = useNameWithBadge();
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
        {t("detail.people.person")}
        <select value={personId} onChange={(event) => setPersonId(event.target.value)}>
          <option value="">{t("detail.people.pickPerson")}</option>
          {candidates.map((person) => (
            <option key={person.id} value={person.id}>
              {nameWithBadge(person)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("detail.people.newRole")}
        <select value={role} onChange={(event) => setRole(event.target.value as ProjectRole)}>
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {t(`roles.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={action.busy || personId === ""}>
        {t("detail.people.grant")}
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
  const { t } = useTranslation("panel");
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
      <p>{t("detail.teams.hint")}</p>
      {project.teamIds.length === 0 ? (
        <p>{t("detail.teams.none")}</p>
      ) : (
        <ul className="panel-list" aria-label={t("detail.teams.title")}>
          {project.teamIds.map((id) => {
            const name = teams.find((team) => team.id === id)?.name ?? t("detail.teams.unknown");
            return (
              <li key={id}>
                <div className="row">
                  <span>{name}</span>
                  {canManage && (
                    <button
                      type="button"
                      aria-label={t("detail.teams.unlinkLabel", { name })}
                      disabled={removeAction.busy}
                      onClick={() => void remove(id)}
                    >
                      {t("detail.teams.unlink")}
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
            {t("detail.teams.team")}
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">{t("detail.teams.pickTeam")}</option>
              {candidates.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={addAction.busy || teamId === ""}>
            {t("detail.teams.link")}
          </button>
          <ActionError error={addAction.error} />
        </form>
      )}
    </>
  );
}
