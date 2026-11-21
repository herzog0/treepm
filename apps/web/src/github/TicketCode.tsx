import { useEffect, useRef, useState } from "react";
import type { ApiClient, CodeLink, CodeRefresh, Project, TicketDetail, TicketStatus } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { StatusMark } from "../map/StatusMark.js";
import { safe } from "../panel/safe.js";
import { relativeTime } from "./time.js";
import "./github.css";

/** Depois deste tempo sem sincronizar, abrir a página dispara uma atualização em segundo plano. */
const STALE_AFTER_MS = 5 * 60_000;

const MARK: Record<CodeLink["state"], TicketStatus> = { active: "in_progress", open: "in_review", merged: "done", closed: "cancelled" };
const STATE_TEXT: Record<CodeLink["state"], string> = { active: "", open: "aberto", merged: "mesclado", closed: "fechado" };

function warningsOf(repositories: CodeRefresh["repositories"]): string[] {
  return repositories.flatMap((entry) =>
    entry.status === "unavailable"
      ? [`Não foi possível ler ${entry.fullName} agora.`]
      : entry.status === "truncated"
        ? [`${entry.fullName} tem mais branches ou pull requests do que o TreePM lê; os mais antigos ficam de fora.`]
        : [],
  );
}

/**
 * Seção "Código" da página do ticket e do agrupador (ADR 0032): branches e pull requests que citam a chave.
 * O pai só a monta com `github.enabled`; sem repositório ligado ao projeto ela não aparece.
 */
export function TicketCode({ client, detail, project }: { client: ApiClient; detail: TicketDetail; project: Project | null }) {
  const code = useApiResource(() => safe(() => client.getTicketCode(detail.id)));
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const autoStarted = useRef(false);
  const archived = project !== null && project.archivedAt !== null;
  const data = code.state.status === "ready" ? code.state.data : null;

  const refresh = async () => {
    setRefreshing(true);
    setFailed(false);
    let result: Awaited<ReturnType<ApiClient["refreshProjectCode"]>>;
    try {
      result = await client.refreshProjectCode(detail.projectId);
    } catch {
      result = { ok: false, error: { kind: "unavailable" } };
    }
    setRefreshing(false);
    if (result.ok) {
      setWarnings(warningsOf(result.data.repositories));
      code.reload();
    } else {
      setFailed(true);
    }
  };

  // Uma vez por abertura (o efeito roda duas vezes em desenvolvimento); a lista guardada aparece enquanto isso.
  useEffect(() => {
    if (data === null || autoStarted.current) return;
    autoStarted.current = true;
    if (archived || data.repositories === 0) return;
    const stale = data.syncedAt === null || Date.now() - new Date(data.syncedAt).getTime() > STALE_AFTER_MS;
    if (stale) void refresh();
  }, [data]);

  if (data === null || data.repositories === 0) return null;
  const isGroup = detail.kind === "group";

  return (
    <section className="ticket-section" aria-labelledby="ticket-code-heading">
      <div className="ticket-code-head">
        <h2 id="ticket-code-heading">Código</h2>
        <span className="ticket-code-sync">
          <span>{data.syncedAt === null ? "Ainda não sincronizado" : `Atualizado ${relativeTime(data.syncedAt)}`}</span>
          {!archived && (
            <button type="button" className="text" disabled={refreshing} onClick={() => void refresh()}>
              Atualizar
            </button>
          )}
        </span>
      </div>
      {data.links.length === 0 ? (
        <p className="ticket-muted">
          {isGroup
            ? "Nenhum branch ou pull request cita os itens deste agrupador."
            : `Nenhum branch ou pull request cita ${detail.key}. Inclua a chave no nome do branch ou no título do PR.`}
        </p>
      ) : (
        <ul className="ticket-code-list">
          {data.links.map((link) => (
            <li key={link.id} className="ticket-code-item">
              <StatusMark status={MARK[link.state]} />
              {isGroup && <span className="ticket-key">{link.ticket.key}</span>}
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.kind === "pull_request" ? `#${link.number} ${link.title}` : link.ref}
              </a>
              <span className="ticket-code-meta">
                {link.kind === "pull_request" && <span className="ticket-code-state">{STATE_TEXT[link.state]}</span>}
                <span>{link.repository.fullName}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="ticket-code-warning">{warning}</p>
      ))}
      {failed && <p className="ticket-muted">Não foi possível atualizar agora.</p>}
    </section>
  );
}
