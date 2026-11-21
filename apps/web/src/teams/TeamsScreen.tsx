import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Team } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { TeamDetail } from "./TeamDetail.js";
import { useMutation } from "./useMutation.js";
import "./teams.css";

export interface TeamsScreenProps {
  client: ApiClient;
  me: Me;
}

export function TeamsScreen({ client, me }: TeamsScreenProps) {
  const { t } = useTranslation("teams");
  const teams = useApiResource(() => client.listTeams());
  const people = useApiResource(() => client.listPeople());
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const create = useMutation();
  const isOrgAdmin = me.roles.clerk === "admin";

  const reload = () => {
    teams.reload();
    people.reload();
  };

  // Time aberto que sumiu da lista (removido aqui ou em outro lugar): volta para a lista.
  const list: Team[] | null = teams.state.status === "ready" ? teams.state.data : null;
  // O time recém-criado ainda não está na lista até a recarga terminar; não o feche antes disso.
  const awaitingId = useRef<string | null>(null);
  useEffect(() => {
    if (!list || openId === null) return;
    if (list.some((team) => team.id === openId)) {
      if (awaitingId.current === openId) awaitingId.current = null;
    } else if (awaitingId.current !== openId) {
      setOpenId(null);
    }
  }, [list, openId]);
  const openTeam = list?.find((team) => team.id === openId) ?? null;

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    let createdId: string | null = null;
    const ok = await create.run(async () => {
      const result = await client.createTeam({ name: trimmed });
      if (result.ok) createdId = result.data.id;
      return result;
    });
    if (ok) {
      setName("");
      awaitingId.current = createdId;
      setOpenId(createdId);
      reload();
    }
  };

  return (
    <main className="teams-screen">
      <h1>{t("title")}</h1>
      <p className="teams-hint">
        {t("hint")}
      </p>
      <div className="teams-layout">
        <section className="teams-list" aria-labelledby="teams-list-title">
          <h2 id="teams-list-title">{t("list.title")}</h2>
          {teams.state.status === "loading" && <p role="status">{t("list.loading")}</p>}
          {teams.state.status === "error" && <LoadError error={teams.state.error} onRetry={teams.retry} />}
          {list &&
            (list.length === 0 ? (
              <p>{t("list.empty")}</p>
            ) : (
              <ul>
                {list.map((team) => (
                  <li key={team.id}>
                    <button type="button" aria-current={team.id === openId ? "true" : undefined} onClick={() => setOpenId(team.id)}>
                      <span>{team.name}</span> <small>{t("list.members", { count: team.members.length })}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          {isOrgAdmin && (
            <form className="teams-form" onSubmit={(event) => void submitCreate(event)}>
              <label htmlFor="new-team-name">{t("create.label")}</label>
              <div className="teams-row">
                <input
                  id="new-team-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-describedby={create.error ? "new-team-error" : undefined}
                  aria-invalid={create.error ? true : undefined}
                />
                <button type="submit" className="primary" disabled={create.pending || name.trim() === ""}>
                  {t("create.submit")}
                </button>
              </div>
              {create.error && (
                <p id="new-team-error" role="alert" className="teams-error">
                  {create.error}
                </p>
              )}
            </form>
          )}
        </section>
        <div className="teams-detail">
          {openTeam ? (
            <TeamDetail
              key={openTeam.id}
              client={client}
              me={me}
              team={openTeam}
              people={people.state}
              onRetryPeople={people.retry}
              onChanged={reload}
              onRemoved={() => {
                setOpenId(null);
                reload();
              }}
            />
          ) : (
            teams.state.status === "ready" && <p>{t("list.pick")}</p>
          )}
        </div>
      </div>
    </main>
  );
}
