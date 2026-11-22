import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityComment, ApiClient, ApiError, TicketSummary } from "../api/client.js";
import type { Language } from "../i18n/languages.js";
import { loadErrorText } from "../LoadError.js";
import { safe } from "../panel/safe.js";
import { CommentComposer, CommentItem } from "./Comments.js";
import type { MentionContext } from "./description/decorations.js";
import { ACTIVITY_PAGE_SIZE } from "./TicketActivity.js";

type Load =
  | { status: "loading" }
  | { status: "error"; error: ApiError }
  | { status: "ready"; entries: ActivityComment[]; before: string | null; canComment: boolean };

export interface ConversationProps {
  client: ApiClient;
  ticketId: string;
  projectId: string;
  tickets: readonly TicketSummary[];
  contribution: { id: string; name: string };
  /** Muda quando um comentário muda na seção "Atividade": a conversa é buscada de novo. */
  activityChanges: number;
  onOpenTicket: (id: string) => void;
  /** Comentário criado, editado ou removido aqui: a página atualiza a contagem e a seção "Atividade". */
  onCommentsChanged: () => void;
}

/**
 * Conversa de uma área (ADR 0041, fatia 2): os comentários daquela contribuição, do mais antigo para o mais novo, e o campo
 * de escrever. Só os comentários são buscados (`contribution=<id>`), e só quando a conversa é aberta. Erro aqui não derruba a página.
 */
export function ContributionConversation({ client, ticketId, projectId, tickets, contribution, activityChanges, onOpenTicket, onCommentsChanged }: ConversationProps) {
  const { t, i18n } = useTranslation("ticket");
  const { t: tRoot } = useTranslation();
  const language = i18n.language as Language;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [older, setOlder] = useState<"idle" | "loading" | { error: ApiError }>("idle");
  const [retries, setRetries] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    setOlder("idle");
    void safe(() => client.ticketActivity(ticketId, { contribution: contribution.id, limit: ACTIVITY_PAGE_SIZE }, { signal: controller.signal })).then((result) => {
      if (generation.current !== mine) return;
      if (result.ok) setLoad({ status: "ready", entries: result.data.entries.filter(isComment), before: result.data.before, canComment: result.data.canComment });
      else setLoad((current) => (current.status === "ready" ? current : { status: "error", error: result.error }));
    });
    return () => controller.abort();
  }, [client, ticketId, contribution.id, activityChanges, retries]);

  const showOlder = async () => {
    if (load.status !== "ready" || load.before === null || older === "loading") return;
    const before = load.before;
    const mine = generation.current;
    setOlder("loading");
    const result = await safe(() => client.ticketActivity(ticketId, { contribution: contribution.id, limit: ACTIVITY_PAGE_SIZE, before }, {}));
    if (generation.current !== mine) return;
    if (!result.ok) return setOlder({ error: result.error });
    setOlder("idle");
    setLoad((current) => {
      if (current.status !== "ready") return current;
      const known = new Set(current.entries.map((entry) => entry.id));
      return { ...current, entries: [...current.entries, ...result.data.entries.filter(isComment).filter((entry) => !known.has(entry.id))], before: result.data.before };
    });
  };

  const now = new Date();
  const mentions: MentionContext = { projectId, tickets, ownId: ticketId, onOpen: onOpenTicket };
  const replace = (entry: ActivityComment) => {
    setLoad((current) => (current.status === "ready" ? { ...current, entries: current.entries.map((item) => (item.id === entry.id ? entry : item)) } : current));
    onCommentsChanged();
  };
  const append = (entry: ActivityComment) => {
    setLoad((current) => (current.status === "ready" ? { ...current, entries: [entry, ...current.entries] } : current));
    onCommentsChanged();
  };

  return (
    <div role="region" aria-label={t("contributions.conversation.region", { area: contribution.name })} className="ticket-conversation">
      {load.status === "loading" && <p role="status" className="ticket-muted">{t("contributions.conversation.loading")}</p>}
      {load.status === "error" && (
        <div className="load-error" role="alert">
          <p>{loadErrorText(load.error, tRoot)}</p>
          <button type="button" onClick={() => { setLoad({ status: "loading" }); setRetries((n) => n + 1); }}>{t("activity.retry")}</button>
        </div>
      )}
      {load.status === "ready" && load.entries.length === 0 && !load.canComment && <p className="ticket-muted">{t("contributions.conversation.empty")}</p>}
      {load.status === "ready" && load.before !== null && (
        <div className="ticket-activity-older">
          <button type="button" className="text" disabled={older === "loading"} onClick={() => void showOlder()}>
            {older === "loading" ? t("activity.olderLoading") : t("activity.older")}
          </button>
        </div>
      )}
      {load.status === "ready" && load.entries.length > 0 && (
        <ol className="ticket-activity-list" aria-label={t("contributions.conversation.list", { area: contribution.name })}>
          {[...load.entries].reverse().map((entry) => (
            <CommentItem key={entry.id} client={client} entry={entry} mentions={mentions} language={language} now={now} onChange={replace} />
          ))}
        </ol>
      )}
      {load.status === "ready" && load.canComment && <CommentComposer client={client} ticketId={ticketId} contribution={contribution} mentions={mentions} onAdded={append} />}
    </div>
  );
}

const isComment = (entry: { type: string }): entry is ActivityComment => entry.type === "comment";
