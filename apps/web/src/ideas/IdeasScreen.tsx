import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, IdeaListItem, IdeaStage, Me, Project } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatActivityTime, formatDateTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { canCreateTickets, canTriageIdeas } from "../import/permissions.js";
import { loadErrorText } from "../LoadError.js";
import { StatusMark } from "../map/StatusMark.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { useAction } from "../panel/useAction.js";
import { fullPath, shortPath } from "./path.js";
import { lastIdeasProject, rememberIdeasProject } from "./session.js";
import "./ideas.css";

export interface IdeasScreenProps {
  client: ApiClient;
  me: Me;
  /** Abre a página da ideia (no mapa). */
  onOpenIdea: (ideaId: string) => void;
  /** Vai para o mapa com a câmera na ideia. */
  onShowOnMap: (ideaId: string) => void;
}

/** A ordem dos grupos da tela: o que está pronto para decidir vem primeiro (ADR 0042). */
const STAGES: readonly IdeaStage[] = ["ready", "refining", "new", "discarded"];

/**
 * Tela "Ideias" (ADR 0042, fatia 3): as ideias de um projeto por estágio, com o caminho na árvore, e a triagem — abrir, ver no
 * mapa e, para o gestor, aceitar e descartar. O projeto escolhido é lembrado só durante a sessão.
 */
export function IdeasScreen({ client, me, onOpenIdea, onShowOnMap }: IdeasScreenProps) {
  const { t } = useTranslation("ideas");
  const { t: tApp } = useTranslation();
  const selectId = useId();
  const projects = useApiResource(() => client.listProjects());
  const [chosenId, setChosenId] = useState<string | null>(() => lastIdeasProject());

  let body;
  let selector = null;
  if (projects.state.status === "loading") {
    body = <p role="status">{t("loading")}</p>;
  } else if (projects.state.status === "error") {
    body = <LoadFailure message={loadErrorText(projects.state.error, tApp)} onRetry={projects.retry} />;
  } else if (projects.state.data.length === 0) {
    body = <p className="ideas-empty">{t("noProjects")}</p>;
  } else {
    const list = projects.state.data;
    const project = list.find((entry) => entry.id === chosenId) ?? list[0]!;
    selector =
      list.length > 1 ? (
        <div className="ideas-project">
          <label htmlFor={selectId}>{t("project.label")}</label>
          <select
            id={selectId}
            value={project.id}
            onChange={(event) => {
              rememberIdeasProject(event.target.value);
              setChosenId(event.target.value);
            }}
          >
            {list.map((entry) => (
              <option key={entry.id} value={entry.id}>{t("project.option", { key: entry.key, name: entry.name })}</option>
            ))}
          </select>
        </div>
      ) : (
        <p className="ideas-project">{t("project.option", { key: project.key, name: project.name })}</p>
      );
    body = <ProjectIdeas key={project.id} client={client} me={me} project={project} onOpenIdea={onOpenIdea} onShowOnMap={onShowOnMap} />;
  }

  return (
    <main className="ideas-screen">
      <h1>{t("title")}</h1>
      <p className="ideas-hint">{t("hint")}</p>
      {selector}
      {body}
    </main>
  );
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation("ideas");
  return (
    <div className="load-error" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>{t("retry")}</button>
    </div>
  );
}

interface ProjectIdeasProps extends Pick<IdeasScreenProps, "client" | "me" | "onOpenIdea" | "onShowOnMap"> {
  project: Project;
}

function ProjectIdeas({ client, me, project, onOpenIdea, onShowOnMap }: ProjectIdeasProps) {
  const { t } = useTranslation("ideas");
  const { t: tApp } = useTranslation();
  const ideas = useApiResource(() => client.listIdeas(project.id));
  const [discardedOpen, setDiscardedOpen] = useState(false);

  if (ideas.state.status === "loading") return <p role="status">{t("loading")}</p>;
  if (ideas.state.status === "error") return <LoadFailure message={loadErrorText(ideas.state.error, tApp)} onRetry={ideas.retry} />;
  const list = ideas.state.data;
  if (list.length === 0) {
    return (
      <div className="ideas-empty">
        <p className="ideas-empty-title">{t("empty.title")}</p>
        <p>{t("empty.hint")}</p>
      </div>
    );
  }
  return (
    <div className="ideas-groups">
      {STAGES.map((stage) => {
        const group = list.filter((entry) => entry.stage === stage);
        if (group.length === 0) return null;
        return (
          <StageGroup
            key={stage}
            stage={stage}
            ideas={group}
            open={stage !== "discarded" || discardedOpen}
            onToggle={stage === "discarded" ? () => setDiscardedOpen((current) => !current) : undefined}
            client={client}
            me={me}
            project={project}
            onChanged={ideas.reload}
            onOpenIdea={onOpenIdea}
            onShowOnMap={onShowOnMap}
          />
        );
      })}
    </div>
  );
}

interface StageGroupProps extends ProjectIdeasProps {
  stage: IdeaStage;
  ideas: readonly IdeaListItem[];
  open: boolean;
  /** Só o grupo "Descartada" recolhe. */
  onToggle: (() => void) | undefined;
  onChanged: () => void;
}

function StageGroup({ stage, ideas, open, onToggle, client, me, project, onChanged, onOpenIdea, onShowOnMap }: StageGroupProps) {
  const { t: tMap } = useTranslation("map");
  const headingId = useId();
  const listId = useId();
  const title = (
    <>
      <StatusMark idea={{ discarded: stage === "discarded" }} />
      <span className="ideas-stage-name">{tMap(`idea.stage.${stage}`)}</span>
      <span className="ideas-count">{ideas.length}</span>
    </>
  );
  return (
    <section className="ideas-group" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {onToggle ? (
          <button type="button" className="ideas-fold" aria-expanded={open} aria-controls={listId} onClick={onToggle}>{title}</button>
        ) : (
          title
        )}
      </h2>
      {open && (
        <ul id={listId} className="ideas-list">
          {ideas.map((entry) => (
            <IdeaRow key={entry.id} idea={entry} client={client} me={me} project={project} onChanged={onChanged} onOpenIdea={onOpenIdea} onShowOnMap={onShowOnMap} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface IdeaRowProps extends ProjectIdeasProps {
  idea: IdeaListItem;
  onChanged: () => void;
}

function IdeaRow({ idea, client, me, project, onChanged, onOpenIdea, onShowOnMap }: IdeaRowProps) {
  const { t, i18n } = useTranslation("ideas");
  const { t: tTicket } = useTranslation("ticket");
  const describeError = useDescribeApiError();
  const action = useAction();
  const language = i18n.language as Language;
  const canTriage = canTriageIdeas(me, project);
  const canRefine = canCreateTickets(me, project);

  const run = async (call: () => ReturnType<typeof client.acceptIdea>) => {
    if (action.busy) return;
    const result = await action.run(call);
    if (result.ok) onChanged();
  };

  return (
    <li className="ideas-row">
      <div className="ideas-main">
        <span className="ideas-key">{idea.key}</span>
        <span className="ideas-title">{idea.title}</span>
      </div>
      <div className="ideas-meta">
        <span className="ideas-path" title={idea.path.length > 0 ? fullPath(idea.path) : undefined}>
          {idea.path.length > 0 ? shortPath(idea.path) : t("row.root")}
        </span>
        <time className="ideas-age" dateTime={idea.createdAt} title={formatDateTime(language, idea.createdAt)}>
          {formatActivityTime(language, idea.createdAt, new Date())}
        </time>
      </div>
      <div className="ideas-actions">
        <button type="button" aria-label={t("actions.openFor", { key: idea.key })} onClick={() => onOpenIdea(idea.id)}>{t("actions.open")}</button>
        <button type="button" aria-label={t("actions.showOnMapFor", { key: idea.key })} onClick={() => onShowOnMap(idea.id)}>{t("actions.showOnMap")}</button>
        {idea.stage === "discarded" ? (
          canRefine && (
            <button type="button" aria-label={t("actions.reopenFor", { key: idea.key })} disabled={action.busy} onClick={() => void run(() => client.putIdeaStage(idea.id, { stage: "refining" }))}>{tTicket("idea.reopen")}</button>
          )
        ) : (
          canTriage && (
            <>
              <ConfirmAction
                label={tTicket("idea.accept")}
                accessibleLabel={t("actions.acceptFor", { key: idea.key })}
                tone="neutral"
                message={tTicket("idea.acceptMessage")}
                disabled={action.busy}
                onConfirm={() => void run(() => client.acceptIdea(idea.id))}
              />
              <ConfirmAction
                label={tTicket("idea.discard")}
                accessibleLabel={t("actions.discardFor", { key: idea.key })}
                message={tTicket("idea.discardMessage")}
                disabled={action.busy}
                onConfirm={() => void run(() => client.discardIdea(idea.id))}
              />
            </>
          )
        )}
      </div>
      {action.error && <p role="alert" className="ideas-error">{describeError(action.error)}</p>}
    </li>
  );
}
