import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person, Team, TeamRole } from "../api/client.js";
import type { ResourceState } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { TestBadge, useNameWithBadge } from "../people/TestBadge.js";
import { useMutation } from "./useMutation.js";

export interface TeamDetailProps {
  client: ApiClient;
  me: Me;
  team: Team;
  people: ResourceState<Person[]>;
  onRetryPeople: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}

const ROLE_KEY = { admin: "detail.roleAdmin", member: "detail.roleMember" } as const satisfies Record<TeamRole, string>;

export function TeamDetail({ client, me, team, people, onRetryPeople, onChanged, onRemoved }: TeamDetailProps) {
  const { t } = useTranslation("teams");
  const isOrgAdmin = me.roles.clerk === "admin";
  const isTeamAdmin = me.roles.teams.some((entry) => entry.teamId === team.id && entry.role === "admin");
  const canManage = isOrgAdmin || isTeamAdmin;
  const titleId = useId();

  return (
    <section className="teams-open" aria-label={t("detail.region", { name: team.name })}>
      <h2 id={titleId}>{team.name}</h2>
      {canManage && <RenameForm client={client} team={team} onChanged={onChanged} />}
      {isOrgAdmin && <RemoveTeam client={client} team={team} onRemoved={onRemoved} />}
      <h3>{t("detail.members")}</h3>
      {people.status === "loading" && <p role="status">{t("detail.loadingPeople")}</p>}
      {people.status === "error" && <LoadError error={people.error} onRetry={onRetryPeople} />}
      {people.status === "ready" && (
        <Members client={client} team={team} people={people.data} canManage={canManage} onChanged={onChanged} />
      )}
    </section>
  );
}

function RenameForm({ client, team, onChanged }: { client: ApiClient; team: Team; onChanged: () => void }) {
  const { t } = useTranslation("teams");
  const [name, setName] = useState(team.name);
  const { pending, error, run } = useMutation();
  const inputId = useId();
  const errorId = useId();
  const trimmed = name.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await run(() => client.renameTeam(team.id, { name: trimmed }))) onChanged();
  };

  return (
    <form className="teams-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId}>{t("detail.rename.label")}</label>
      <div className="teams-row">
        <input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
        />
        <button type="submit" disabled={pending || trimmed === "" || trimmed === team.name}>
          {t("detail.rename.submit")}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="teams-error">
          {error}
        </p>
      )}
    </form>
  );
}

function RemoveTeam({ client, team, onRemoved }: { client: ApiClient; team: Team; onRemoved: () => void }) {
  const { t } = useTranslation("teams");
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useMutation();

  const confirm = async () => {
    if (await run(() => client.removeTeam(team.id))) onRemoved();
  };

  return (
    <div className="teams-danger">
      {confirming ? (
        <div className="teams-row">
          <button
            type="button"
            className="teams-destructive"
            aria-label={t("detail.remove.confirmLabel")}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {t("detail.remove.confirm")}
          </button>
          <button type="button" disabled={pending} onClick={() => setConfirming(false)}>
            {t("detail.remove.cancel")}
          </button>
        </div>
      ) : (
        <button type="button" className="destructive" onClick={() => setConfirming(true)}>
          {t("detail.remove.action")}
        </button>
      )}
      {error && (
        <p role="alert" className="teams-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface MembersProps {
  client: ApiClient;
  team: Team;
  people: Person[];
  canManage: boolean;
  onChanged: () => void;
}

function Members({ client, team, people, canManage, onChanged }: MembersProps) {
  const { t } = useTranslation("teams");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const { pending, error, run } = useMutation();
  const byId = new Map(people.map((p) => [p.id, p]));

  const changeRole = async (personId: string, role: TeamRole) => {
    if (await run(() => client.putTeamMember(team.id, personId, { role }))) onChanged();
  };
  const remove = async (personId: string) => {
    if (await run(() => client.removeTeamMember(team.id, personId))) {
      setConfirmingId(null);
      onChanged();
    }
  };

  return (
    <>
      {team.members.length === 0 ? (
        <p>{t("detail.noMembers")}</p>
      ) : (
        <ul className="teams-members">
          {team.members.map((member) => {
            const person = byId.get(member.personId);
            const label = person?.displayName ?? member.personId;
            return (
              <li key={member.personId}>
                <div className="teams-who">
                  <strong>{label}</strong>
                  <TestBadge person={person} />
                  {person && <small>{person.email}</small>}
                </div>
                {canManage ? (
                  <div className="teams-row">
                    <select
                      aria-label={t("detail.roleOf", { name: label })}
                      value={member.role}
                      disabled={pending}
                      onChange={(event) => void changeRole(member.personId, event.target.value as TeamRole)}
                    >
                      <option value="admin">{t(ROLE_KEY.admin)}</option>
                      <option value="member">{t(ROLE_KEY.member)}</option>
                    </select>
                    {confirmingId === member.personId ? (
                      <>
                        <button
                          type="button"
                          className="teams-destructive"
                          aria-label={t("detail.confirmRemoveMember", { name: label })}
                          disabled={pending}
                          onClick={() => void remove(member.personId)}
                        >
                          {t("detail.remove.confirm")}
                        </button>
                        <button type="button" disabled={pending} onClick={() => setConfirmingId(null)}>
                          {t("detail.remove.cancel")}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="destructive" onClick={() => setConfirmingId(member.personId)}>
                        {t("detail.removeMemberLabel", { name: label })}
                      </button>
                    )}
                  </div>
                ) : (
                  <span>{t(ROLE_KEY[member.role])}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="teams-error">
          {error}
        </p>
      )}
      {canManage && <AddMember client={client} team={team} people={people} onChanged={onChanged} />}
    </>
  );
}

function AddMember({ client, team, people, onChanged }: { client: ApiClient; team: Team; people: Person[]; onChanged: () => void }) {
  const { t } = useTranslation("teams");
  const nameWithBadge = useNameWithBadge();
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const { pending, error, run } = useMutation();
  const inTeam = new Set(team.members.map((m) => m.personId));
  const candidates = people.filter((p) => p.active && !inTeam.has(p.id));

  if (candidates.length === 0) return <p>{t("detail.everyoneIn")}</p>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!personId) return;
    if (await run(() => client.putTeamMember(team.id, personId, { role }))) {
      setPersonId("");
      onChanged();
    }
  };

  return (
    <form className="teams-form" onSubmit={(event) => void submit(event)}>
      <div className="teams-row">
        <select aria-label={t("detail.personToAdd")} value={personId} onChange={(event) => setPersonId(event.target.value)}>
          <option value="">{t("detail.pickPerson")}</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {nameWithBadge(p)}
            </option>
          ))}
        </select>
        <select aria-label={t("detail.roleToAdd")} value={role} onChange={(event) => setRole(event.target.value as TeamRole)}>
          <option value="member">{t(ROLE_KEY.member)}</option>
          <option value="admin">{t(ROLE_KEY.admin)}</option>
        </select>
        <button type="submit" disabled={pending || personId === ""}>
          {t("detail.add")}
        </button>
      </div>
      {error && (
        <p role="alert" className="teams-error">
          {error}
        </p>
      )}
    </form>
  );
}
