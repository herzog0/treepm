import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, GithubRepository, Me, Project, ProjectRepository } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import "./github.css";
import { useDescribeApiError } from "../api/errorText.js";

/** Seção "Repositórios" do detalhe do projeto (ADR 0032). O pai só a monta com `github.enabled`; sem organização ligada ela não aparece. */
export function ProjectRepositories({ client, me, project }: { client: ApiClient; me: Me; project: Project }) {
  const installation = useApiResource(() => safe(() => client.getGithubInstallation()));
  if (installation.state.status !== "ready" || installation.state.data.installation === null) return null;
  return <LinkedRepositories client={client} me={me} project={project} />;
}

function LinkedRepositories({ client, me, project }: { client: ApiClient; me: Me; project: Project }) {
  const { t } = useTranslation("github");
  const linked = useApiResource(() => safe(() => client.listProjectRepositories(project.id)));
  const [choosing, setChoosing] = useState(false);
  const canManage = me.roles.clerk === "admin" || me.roles.projects.some((entry) => entry.projectId === project.id && entry.role === "manager");
  const canEdit = canManage && project.archivedAt === null;

  return (
    <section className="panel-repositories" aria-labelledby={`project-repositories-${project.id}`}>
      <h3 id={`project-repositories-${project.id}`}>{t("repositories.title")}</h3>
      {linked.state.status === "loading" && <p role="status">{t("repositories.loading")}</p>}
      {linked.state.status === "error" && <LoadError error={linked.state.error} onRetry={linked.retry} />}
      {linked.state.status === "ready" &&
        (linked.state.data.length === 0 ? (
          <p>{t("repositories.empty")}</p>
        ) : (
          <ul className="panel-list" aria-label={t("repositories.list")}>
            {linked.state.data.map((repository) => (
              <RepositoryRow key={repository.id} client={client} projectId={project.id} repository={repository} canEdit={canEdit} onRemoved={linked.reload} />
            ))}
          </ul>
        ))}
      {canEdit && linked.state.status === "ready" && !choosing && (
        <button type="button" onClick={() => setChoosing(true)}>
          {t("repositories.link")}
        </button>
      )}
      {canEdit && linked.state.status === "ready" && choosing && (
        <Choice
          client={client}
          projectId={project.id}
          linkedRepoIds={linked.state.data.map((entry) => entry.repoId)}
          onCancel={() => setChoosing(false)}
          onLinked={() => {
            setChoosing(false);
            linked.reload();
          }}
        />
      )}
    </section>
  );
}

function RepositoryRow({
  client,
  projectId,
  repository,
  canEdit,
  onRemoved,
}: {
  client: ApiClient;
  projectId: string;
  repository: ProjectRepository;
  canEdit: boolean;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("github");
  const describeError = useDescribeApiError();
  const action = useAction();
  const remove = async () => {
    const result = await action.run(() => client.unlinkProjectRepository(projectId, repository.id));
    if (result.ok) onRemoved();
  };
  return (
    <li>
      <div className="row">
        <span className="repo-name">
          <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer">
            {repository.fullName}
          </a>
          {repository.private && <small className="badge repo-private">{t("repositories.private")}</small>}
        </span>
        {canEdit && (
          <ConfirmAction
            label={t("repositories.remove")}
            accessibleLabel={t("repositories.removeLabel", { name: repository.fullName })}
            message={t("repositories.removeWarning")}
            disabled={action.busy}
            onConfirm={() => void remove()}
          />
        )}
      </div>
      {action.error && <p role="alert">{describeError(action.error)}</p>}
    </li>
  );
}

/** Escolha de repositório: busca os do app na hora em que abre, sem os já ligados, com filtro por nome. */
function Choice({
  client,
  projectId,
  linkedRepoIds,
  onCancel,
  onLinked,
}: {
  client: ApiClient;
  projectId: string;
  linkedRepoIds: readonly number[];
  onCancel: () => void;
  onLinked: () => void;
}) {
  const { t } = useTranslation("github");
  const describeError = useDescribeApiError();
  const available = useApiResource(() => safe(() => client.listGithubRepositories()));
  const [filter, setFilter] = useState("");
  const link = useAction();

  const choose = async (repository: GithubRepository) => {
    const result = await link.run(() => client.linkProjectRepository(projectId, { repoId: repository.repoId }));
    if (result.ok) onLinked();
  };

  const candidates = available.state.status === "ready" ? available.state.data.filter((entry) => !linkedRepoIds.includes(entry.repoId)) : [];
  const needle = filter.trim().toLowerCase();
  const shown = candidates.filter((entry) => entry.fullName.toLowerCase().includes(needle));

  return (
    <div className="repo-choice">
      {available.state.status === "loading" && <p role="status">{t("repositories.searching")}</p>}
      {available.state.status === "error" && <LoadError error={available.state.error} onRetry={available.retry} />}
      {available.state.status === "ready" && (
        <>
          <label>
            {t("repositories.filter")}
            <input value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          {candidates.length === 0 ? (
            <p>{t("repositories.allLinked")}</p>
          ) : shown.length === 0 ? (
            <p>{t("repositories.none")}</p>
          ) : (
            <div className="repo-choice-list" role="group" aria-label={t("repositories.available")}>
              {shown.map((entry) => (
                <button key={entry.repoId} type="button" disabled={link.busy} onClick={() => void choose(entry)}>
                  {entry.fullName}
                  {entry.private && <small className="badge">{t("repositories.private")}</small>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {link.error && <p role="alert">{describeError(link.error)}</p>}
      <button type="button" className="text" onClick={onCancel}>
        {t("repositories.cancel")}
      </button>
    </div>
  );
}
