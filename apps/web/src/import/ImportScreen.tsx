import { useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { ApiClient, ImportItem, LinearConnection, Me, TicketStatus } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { useTranslation } from "react-i18next";
import { LoadError } from "../LoadError.js";
import { StatusMark } from "../map/StatusMark.js";
import { useStatusText } from "../map/nodeContent.js";
import { useAction } from "../panel/useAction.js";
import { parseTicketList, useTicketListIssueText } from "../tickets/parseTicketList.js";
import { safe } from "../panel/safe.js";
import { LinearImportPanel } from "./LinearImport.js";
import { canCreateTickets } from "./permissions.js";
import "./import.css";
import { useDescribeApiError } from "../api/errorText.js";

export interface ImportScreenProps {
  client: ApiClient;
  me: Me;
  projectId: string | null;
  /** Volta ao mapa: pelo "Cancelar", pelo "Voltar ao mapa" ou depois de importar. */
  onExit: () => void;
  /** Leva às Configurações → Linear (a ligação do projeto e a chave pessoal moram lá). */
  onOpenSettings?: () => void;
  /** Abre o ticket no mapa (a lista "a conferir" da procura do lugar dos itens importados). */
  onOpenTicket?: (ticketId: string) => void;
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

export function ImportScreen({ client, me, projectId, onExit, onOpenSettings, onOpenTicket }: ImportScreenProps) {
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
        <ImportForm client={client} projectId={project.id} projectKey={project.key} projectName={project.name} onExit={onExit} {...(onOpenSettings ? { onOpenSettings } : {})} {...(onOpenTicket ? { onOpenTicket } : {})} />
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
  onOpenSettings?: () => void;
  onOpenTicket?: (ticketId: string) => void;
}

type Tab = "list" | "linear";
type LinearEntry = { status: "loading" } | { status: "off" } | { status: "on"; connection: LinearConnection; initialTab: Tab };

/**
 * Se a importação do Linear (ADR 0060) aparece nesta tela: só quando o servidor a tem configurada. A aba inicial é a do Linear
 * quando a pessoa veio das Configurações (`#linear`) ou quando já há uma rodada aberta no projeto, que a tela retoma sozinha.
 * Qualquer falha ao perguntar deixa a tela como era, só com a lista.
 */
function useLinearEntry(client: ApiClient, projectId: string): LinearEntry {
  const [entry, setEntry] = useState<LinearEntry>({ status: "loading" });
  useEffect(() => {
    let active = true;
    void (async () => {
      const connection = await safe(() => client.getLinearConnection());
      if (!active) return;
      if (!connection.ok || !connection.data.configured) return setEntry({ status: "off" });
      const current = await safe(() => client.getCurrentLinearRun(projectId));
      if (!active) return;
      const open = current.ok && current.data.run !== null && !current.data.run.done;
      setEntry({ status: "on", connection: connection.data, initialTab: open || window.location.hash === "#linear" ? "linear" : "list" });
    })();
    return () => {
      active = false;
    };
  }, [client, projectId]);
  return entry;
}

function ImportForm({ client, projectId, projectKey, projectName, onExit, onOpenSettings, onOpenTicket }: ImportFormProps) {
  const { t } = useTranslation("import");
  const entry = useLinearEntry(client, projectId);
  // Sem Linear a tela é a de sempre; com ele, espera a pergunta (rápida) para já abrir na aba certa.
  if (entry.status === "loading") return <p role="status">{t("loading")}</p>;
  return <ImportTabs client={client} projectId={projectId} projectKey={projectKey} projectName={projectName} onExit={onExit} onOpenSettings={onOpenSettings} onOpenTicket={onOpenTicket} entry={entry} />;
}

interface ImportTabsProps extends ImportFormProps {
  entry: Exclude<LinearEntry, { status: "loading" }>;
}

function ImportTabs({ client, projectId, projectKey, projectName, onExit, onOpenSettings, onOpenTicket, entry }: ImportTabsProps) {
  const { t } = useTranslation("import");
  const [tab, setTab] = useState<Tab>(entry.status === "on" ? entry.initialTab : "list");
  const tabsId = useId();
  const onLinear = entry.status === "on" && tab === "linear";
  return (
    <>
      <header className="import-header">
        <nav className="import-path" aria-label={t("header.path")}>
          <code>{projectKey}</code>
          <span>{projectName}</span>
        </nav>
        <h1>{onLinear ? t("linear.title") : t("header.title")}</h1>
        <p>{onLinear ? t("linear.intro") : t("header.intro")}</p>
        {entry.status === "on" && (
          <div className="import-tabs" role="tablist" aria-label={t("linear.tabs.label")}>
            {(["list", "linear"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${tabsId}-${id}`}
                aria-selected={tab === id}
                aria-controls={`${tabsId}-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const next = id === "list" ? "linear" : "list";
                  setTab(next);
                  document.getElementById(`${tabsId}-${next}`)?.focus();
                }}
              >
                {t(id === "list" ? "linear.tabs.list" : "linear.tabs.linear")}
              </button>
            ))}
          </div>
        )}
      </header>
      <div id={`${tabsId}-panel-list`} role={entry.status === "on" ? "tabpanel" : undefined} aria-labelledby={entry.status === "on" ? `${tabsId}-list` : undefined} hidden={onLinear}>
        <ListImport client={client} projectId={projectId} onExit={onExit} />
      </div>
      {entry.status === "on" && (
        <div id={`${tabsId}-panel-linear`} role="tabpanel" aria-labelledby={`${tabsId}-linear`} hidden={!onLinear}>
          {onLinear && <LinearImportPanel client={client} projectId={projectId} connection={entry.connection} onExit={onExit} onOpenSettings={onOpenSettings ?? onExit} onOpenTicket={onOpenTicket ?? onExit} />}
        </div>
      )}
    </>
  );
}

function ListImport({ client, projectId, onExit }: { client: ApiClient; projectId: string; onExit: () => void }) {
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
