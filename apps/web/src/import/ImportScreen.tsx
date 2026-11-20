import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { ApiClient, ImportItem, Me } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { plural } from "../plural.js";
import { StatusMark } from "../map/StatusMark.js";
import { STATUS_TEXT } from "../map/nodeContent.js";
import { useAction } from "../panel/useAction.js";
import { describeTicketListIssue, parseTicketList } from "../tickets/parseTicketList.js";
import { canCreateTickets } from "./permissions.js";
import "./import.css";

export interface ImportScreenProps {
  client: ApiClient;
  me: Me;
  projectId: string | null;
  /** Volta ao mapa: pelo "Cancelar", pelo "Voltar ao mapa" ou depois de importar. */
  onExit: () => void;
}

const MARKERS: readonly { marker: string; meaning: string }[] = [
  { marker: "- [ ]", meaning: "a fazer" },
  { marker: "- [/]", meaning: "em andamento" },
  { marker: "- [r]", meaning: "em revisão" },
  { marker: "- [x]", meaning: "concluído" },
  { marker: "- [-]", meaning: "cancelado" },
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
  return (
    <ul className="import-tree" {...(label ? { "aria-label": label } : {})}>
      {items.map((item, position) => {
        const children = item.children ?? [];
        return (
          <li key={position}>
            <div className={`import-tree-row ${children.length > 0 ? "is-parent" : ""}`}>
              {children.length === 0 && <StatusMark status={item.status ?? "todo"} />}
              <span className="import-tree-title">{item.title}</span>
              {children.length > 0 && <span className="import-tree-kind">Agrupador</span>}
              <small>{children.length === 0 ? STATUS_TEXT[item.status ?? "todo"] : plural(children.length, "subitem", "subitens")}</small>
            </div>
            {children.length > 0 && <PreviewTree items={children} />}
          </li>
        );
      })}
    </ul>
  );
}

function Unavailable({ message, onExit }: { message: string; onExit: () => void }) {
  return (
    <div className="import-unavailable">
      <p>{message}</p>
      <button type="button" onClick={onExit}>
        Voltar ao mapa
      </button>
    </div>
  );
}

export function ImportScreen({ client, me, projectId, onExit }: ImportScreenProps) {
  const projects = useApiResource(() => client.listProjects());
  const project = projects.state.status === "ready" ? (projects.state.data.find((entry) => entry.id === projectId) ?? null) : null;

  return (
    <main className="import-screen">
      {projects.state.status === "loading" && <p role="status">Carregando projeto…</p>}
      {projects.state.status === "error" && <LoadError error={projects.state.error} onRetry={projects.retry} />}
      {projects.state.status === "ready" && !project && <Unavailable message="Projeto não encontrado ou sem acesso." onExit={onExit} />}
      {project && project.archivedAt !== null && <Unavailable message="O projeto está arquivado e não aceita importação." onExit={onExit} />}
      {project && project.archivedAt === null && !canCreateTickets(me, project) && (
        <Unavailable message="Você não tem permissão para importar tickets neste projeto." onExit={onExit} />
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
        <nav className="import-path" aria-label="Caminho">
          <code>{projectKey}</code>
          <span>{projectName}</span>
        </nav>
        <h1>Importar lista</h1>
        <p>Cole uma lista em Markdown: cada item vira um ticket, o recuo define quem é filho de quem, e o item com filhos vira um agrupador. Marcadores opcionais definem a situação dos tickets.</p>
      </header>

      <div className="import-columns">
        <section className="import-input" aria-labelledby="import-list-label">
          <div className="import-label-row">
            <label id="import-list-label" htmlFor="import-list">
              Lista
            </label>
            <label className="import-file">
              Escolher arquivo
              <input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={(event) => void loadFile(event)} />
            </label>
          </div>
          <textarea
            id="import-list"
            value={text}
            spellCheck={false}
            wrap="off"
            placeholder={"- Primeira entrega\n  - [x] Passo concluído\n  - [/] Passo em andamento\n- [ ] Outra entrega"}
            onChange={(event) => setText(event.target.value)}
          />
          {fileError && <p className="import-error-text">Não foi possível ler o arquivo.</p>}
          <ul className="import-legend" aria-label="Marcadores">
            {MARKERS.map((entry) => (
              <li key={entry.marker}>
                <code>{entry.marker}</code> <span>{entry.meaning}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="import-preview" aria-labelledby="import-preview-title">
          <h2 id="import-preview-title">Prévia</h2>
          {parsed === null && <p className="import-muted">A árvore aparece aqui enquanto você cola ou digita a lista.</p>}
          {parsed && !parsed.ok && (
            <ul className="import-errors" aria-label="Erros da lista">
              {parsed.errors.map((issue, position) => (
                <li key={position}>{describeTicketListIssue(issue)}</li>
              ))}
            </ul>
          )}
          {parsed?.ok && counts && (
            <>
              <p className="import-summary">
                {plural(counts.total, "ticket", "tickets")} · {plural(parsed.items.length, "raiz", "raízes")} · {plural(counts.leaves, "folha", "folhas")}
              </p>
              {parsed.warnings.length > 0 && (
                <ul className="import-warnings" aria-label="Avisos da lista">
                  {parsed.warnings.map((issue, position) => (
                    <li key={position}>{describeTicketListIssue(issue)}</li>
                  ))}
                </ul>
              )}
              <PreviewTree items={parsed.items} label="Prévia da árvore" />
            </>
          )}
        </section>
      </div>

      <footer className="import-footer">
        {action.error && <p role="alert" className="import-error-text">{describeApiError(action.error)}</p>}
        <button type="button" onClick={onExit}>
          Cancelar
        </button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {action.busy ? "Importando…" : counts ? `Importar ${plural(counts.total, "ticket", "tickets")}` : "Importar"}
        </button>
      </footer>
    </>
  );
}
