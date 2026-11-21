import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { ApiClient, ImportItem, Me, TicketStatus } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { useTranslation } from "react-i18next";
import { LoadError } from "../LoadError.js";
import { StatusMark } from "../map/StatusMark.js";
import { useStatusText } from "../map/nodeContent.js";
import { useAction } from "../panel/useAction.js";
import { parseTicketList, useTicketListIssueText } from "../tickets/parseTicketList.js";
import { canCreateTickets } from "./permissions.js";
import "./import.css";
import { useDescribeApiError } from "../api/errorText.js";

export interface ImportScreenProps {
  client: ApiClient;
  me: Me;
  projectId: string | null;
  /** Volta ao mapa: pelo "Cancelar", pelo "Voltar ao mapa" ou depois de importar. */
  onExit: () => void;
}

const MARKERS: readonly { marker: string; status: TicketStatus }[] = [
  { marker: "- [ ]", status: "todo" },
  { marker: "- [/]", status: "in_progress" },
  { marker: "- [r]", status: "in_review" },
  { marker: "- [x]", status: "done" },
  { marker: "- [-]", status: "cancelled" },
];


function countItems(items: readonly ImportItem[]): { total: number; leaves: number } {
  let total = 0;
  let leaves = 0;
  for (const item of items) {
    const below = countItems(item.children ?? []);
    total += 1 + below.total;
    leaves += below.leaves + (item.children && item.children.length > 0 ? 0 : 1);
  }
  return { total, leaves };
}

function PreviewTree({ items, label }: { items: readonly ImportItem[]; label?: string }) {
  const { t } = useTranslation("import");
  const statusText = useStatusText();
  return (
    <ul className="import-tree" {...(label ? { "aria-label": label } : {})}>
      {items.map((item, position) => {
        const children = item.children ?? [];
        return (
          <li key={position}>
            <div className={`import-tree-row ${children.length > 0 ? "is-parent" : ""}`}>
              {children.length === 0 && <StatusMark status={item.status ?? "todo"} />}
              <span className="import-tree-title">{item.title}</span>
              <small>{children.length === 0 ? statusText(item.status ?? "todo") : t("preview.subitems", { count: children.length })}</small>
            </div>
            {children.length > 0 && <PreviewTree items={children} />}
          </li>
        );
      })}
    </ul>
  );
}

function Unavailable({ message, onExit }: { message: string; onExit: () => void }) {
  const { t } = useTranslation("import");
  return (
    <div className="import-unavailable">
      <p>{message}</p>
      <button type="button" onClick={onExit}>
        {t("unavailable.back")}
      </button>
    </div>
  );
}

export function ImportScreen({ client, me, projectId, onExit }: ImportScreenProps) {
  const { t } = useTranslation("import");
  const projects = useApiResource(() => client.listProjects());
  const project = projects.state.status === "ready" ? (projects.state.data.find((entry) => entry.id === projectId) ?? null) : null;

  return (
    <main className="import-screen">
      {projects.state.status === "loading" && <p role="status">{t("loading")}</p>}
      {projects.state.status === "error" && <LoadError error={projects.state.error} onRetry={projects.retry} />}
      {projects.state.status === "ready" && !project && <Unavailable message={t("unavailable.notFound")} onExit={onExit} />}
      {project && project.archivedAt !== null && <Unavailable message={t("unavailable.archived")} onExit={onExit} />}
      {project && project.archivedAt === null && !canCreateTickets(me, project) && (
        <Unavailable message={t("unavailable.noPermission")} onExit={onExit} />
      )}
      {project && canCreateTickets(me, project) && (
        <ImportForm client={client} projectId={project.id} projectKey={project.key} projectName={project.name} onExit={onExit} />
      )}
    </main>
  );
}

interface ImportFormProps {
  client: ApiClient;
  projectId: string;
  projectKey: string;
  projectName: string;
  onExit: () => void;
}

function ImportForm({ client, projectId, projectKey, projectName, onExit }: ImportFormProps) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  const describeIssue = useTicketListIssueText();
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState(false);
  const action = useAction();
  const blank = text.trim() === "";
  const parsed = useMemo(() => (blank ? null : parseTicketList(text)), [text, blank]);
  const items = parsed?.ok ? parsed.items : null;
  const counts = items ? countItems(items) : null;
  const canSubmit = items !== null && items.length > 0 && !action.busy;

  const submit = async () => {
    if (!items || !canSubmit) return;
    const result = await action.run(() => client.importTickets(projectId, { items }));
    if (result.ok) onExit();
  };

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      setText(await file.text());
      setFileError(false);
    } catch {
      setFileError(true);
    }
    input.value = "";
  };

  return (
    <>
      <header className="import-header">
        <nav className="import-path" aria-label={t("header.path")}>
          <code>{projectKey}</code>
          <span>{projectName}</span>
        </nav>
        <h1>{t("header.title")}</h1>
        <p>{t("header.intro")}</p>
      </header>

      <div className="import-columns">
        <section className="import-input" aria-labelledby="import-list-label">
          <div className="import-label-row">
            <label id="import-list-label" htmlFor="import-list">
              {t("input.label")}
            </label>
            <label className="import-file">
              {t("input.chooseFile")}
              <input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={(event) => void loadFile(event)} />
            </label>
          </div>
          <textarea
            id="import-list"
            value={text}
            spellCheck={false}
            wrap="off"
            placeholder={t("input.placeholder")}
            onChange={(event) => setText(event.target.value)}
          />
          {fileError && <p className="import-error-text">{t("input.fileError")}</p>}
          <ul className="import-legend" aria-label={t("input.markers")}>
            {MARKERS.map((entry) => (
              <li key={entry.marker}>
                <code>{entry.marker}</code> <span>{t(`legend.${entry.status}`)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="import-preview" aria-labelledby="import-preview-title">
          <h2 id="import-preview-title">{t("preview.title")}</h2>
          {parsed === null && <p className="import-muted">{t("preview.empty")}</p>}
          {parsed && !parsed.ok && (
            <ul className="import-errors" aria-label={t("preview.errors")}>
              {parsed.errors.map((issue, position) => (
                <li key={position}>{describeIssue(issue)}</li>
              ))}
            </ul>
          )}
          {parsed?.ok && counts && (
            <>
              <p className="import-summary">
                {t("summary.line", {
                  tickets: t("summary.tickets", { count: counts.total }),
                  roots: t("summary.roots", { count: parsed.items.length }),
                  leaves: t("summary.leaves", { count: counts.leaves }),
                })}
              </p>
              {parsed.warnings.length > 0 && (
                <ul className="import-warnings" aria-label={t("preview.warnings")}>
                  {parsed.warnings.map((issue, position) => (
                    <li key={position}>{describeIssue(issue)}</li>
                  ))}
                </ul>
              )}
              <PreviewTree items={parsed.items} label={t("preview.tree")} />
            </>
          )}
        </section>
      </div>

      <footer className="import-footer">
        {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
        <button type="button" onClick={onExit}>
          {t("actions.cancel")}
        </button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {action.busy ? t("actions.importing") : counts ? t("actions.importCount", { count: counts.total }) : t("actions.import")}
        </button>
      </footer>
    </>
  );
}
