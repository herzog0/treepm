import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, CodeLink, CodeRefresh, Project, TicketDetail, TicketStatus } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { StatusMark } from "../map/StatusMark.js";
import { safe } from "../panel/safe.js";
import { relativeTimeText } from "./relativeTime.js";
import "./github.css";

/** Depois deste tempo sem sincronizar, abrir a página dispara uma atualização em segundo plano. */
const STALE_AFTER_MS = 5 * 60_000;

const MARK: Record<CodeLink["state"], TicketStatus> = { active: "in_progress", open: "in_review", merged: "done", closed: "cancelled" };

/** Só os vínculos de pull request mostram a situação; o branch (`active`) não tem texto. */
const STATE_KEY = { open: "open", merged: "merged", closed: "closed" } as const;

interface Warning {
  kind: "unreadable" | "truncated";
  fullName: string;
}

function warningsOf(repositories: CodeRefresh["repositories"]): Warning[] {
  return repositories.flatMap((entry): Warning[] =>
    entry.status === "unavailable"
      ? [{ kind: "unreadable", fullName: entry.fullName }]
      : entry.status === "truncated"
        ? [{ kind: "truncated", fullName: entry.fullName }]
        : [],
  );
}

/**
 * Seção "Código" da página do ticket (ADR 0032); o ticket com itens já traz os vínculos dos itens: branches e pull requests que citam a chave.
 * O pai só a monta com `github.enabled`; sem repositório ligado ao projeto ela não aparece.
 */
export function TicketCode({ client, detail, project }: { client: ApiClient; detail: TicketDetail; project: Project | null }) {
  const { t } = useTranslation("github");
  const code = useApiResource(() => safe(() => client.getTicketCode(detail.id)));
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [warnings, setWarnings] = useState<Warning[]>([]);
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
  const hasItems = detail.progress !== null;

  return (
    <section className="ticket-section" aria-labelledby="ticket-code-heading">
      <div className="ticket-code-head">
        <h2 id="ticket-code-heading">{t("code.title")}</h2>
        <span className="ticket-code-sync">
          <span>{data.syncedAt === null ? t("code.notSynced") : t("code.updated", { when: relativeTimeText(t, data.syncedAt) })}</span>
          {!archived && (
            <button type="button" className="text" disabled={refreshing} onClick={() => void refresh()}>
              {t("code.refresh")}
            </button>
          )}
        </span>
      </div>
      {data.links.length === 0 ? (
        <p className="ticket-muted">
          {hasItems ? t("code.noLinksItems") : t("code.noLinks", { key: detail.key })}
        </p>
      ) : (
        <ul className="ticket-code-list">
          {data.links.map((link) => (
            <li key={link.id} className="ticket-code-item">
              <StatusMark status={MARK[link.state]} />
              {link.ticket.id !== detail.id && <span className="ticket-key">{link.ticket.key}</span>}
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.kind === "pull_request" ? `#${link.number} ${link.title}` : link.ref}
              </a>
              <span className="ticket-code-meta">
                {link.kind === "pull_request" && link.state !== "active" && <span className="ticket-code-state">{t(`code.state.${STATE_KEY[link.state]}`)}</span>}
                <span>{link.repository.fullName}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {warnings.map((warning) => (
        <p key={`${warning.kind}-${warning.fullName}`} className="ticket-code-warning">{t(`code.${warning.kind}`, { name: warning.fullName })}</p>
      ))}
      {failed && <p className="ticket-muted">{t("code.refreshFailed")}</p>}
    </section>
  );
}
