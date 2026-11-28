import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ActivityComment, ActivityEntry, ActivityTicketRef, ApiClient, ApiError, LinearAssigneeSide, LinearChange, TicketSummary } from "../api/client.js";
import { formatActivityTime, formatDateTime, formatDueDate, formatList } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { loadErrorText } from "../LoadError.js";
import { useStatusText } from "../map/nodeContent.js";
import { safe } from "../panel/safe.js";
import type { MentionContext } from "./description/decorations.js";
import { Avatar, CommentComposer, CommentItem, ViaMcp } from "./Comments.js";
import { FromLinearBadge } from "./fields.js";

/** Quantas entradas cada página pede (a API aceita até 100; o padrão dela também é 30). */
export const ACTIVITY_PAGE_SIZE = 30;
/** A hora relativa envelhece: a lista se redesenha a cada minuto. */
const CLOCK_TICK_MS = 60_000;

type Load =
  | { status: "loading" }
  | { status: "error"; error: ApiError }
  | { status: "ready"; entries: ActivityEntry[]; before: string | null; canComment: boolean };

export interface TicketActivityProps {
  client: ApiClient;
  ticketId: string;
  /** Projeto e tickets dele: as chaves nos comentários viram a etiqueta clicável da descrição. */
  projectId: string;
  tickets: readonly TicketSummary[];
  /** Muda a cada alteração feita na página: a atividade é buscada de novo (ADR 0040). */
  version: number;
  /** Muda quando um comentário é criado, editado ou removido na conversa de uma área: a lista é buscada de novo (ADR 0041). */
  areaChanges: number;
  onOpenTicket: (id: string) => void;
  /** A etiqueta de área de um comentário leva ao bloco da área e abre a conversa dela. */
  onOpenArea: (contributionId: string) => void;
  /** Comentário criado, editado ou removido aqui: a página atualiza a contagem e a conversa das áreas. */
  onCommentsChanged: () => void;
}

/**
 * Seção "Atividade" (ADR 0040): as mudanças e os comentários do ticket, do mais antigo para o mais novo. A API entrega da mais
 * recente para a mais antiga em páginas; "Mostrar anteriores" busca a seguinte e a põe acima da lista, mantendo na tela
 * o que a pessoa estava lendo. Erro aqui nunca derruba o resto da página.
 */
export function TicketActivity({ client, ticketId, projectId, tickets, version, areaChanges, onOpenTicket, onOpenArea, onCommentsChanged }: TicketActivityProps) {
  const { t, i18n } = useTranslation("ticket");
  const language = i18n.language as Language;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [older, setOlder] = useState<"idle" | "loading" | { error: ApiError }>("idle");
  const [retries, setRetries] = useState(0);
  const [, setClock] = useState(0);
  const generation = useRef(0);
  const section = useRef<HTMLElement>(null);
  const anchor = useRef<{ body: HTMLElement; item: HTMLElement; offset: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    setOlder("idle");
    void safe(() => client.ticketActivity(ticketId, { limit: ACTIVITY_PAGE_SIZE }, { signal: controller.signal })).then((result) => {
      if (generation.current !== mine) return;
      // Uma recarga que falha mantém o que já está na tela; só a primeira carga mostra o erro.
      if (result.ok) setLoad({ status: "ready", entries: result.data.entries, before: result.data.before, canComment: result.data.canComment });
      else setLoad((current) => (current.status === "ready" ? current : { status: "error", error: result.error }));
    });
    return () => controller.abort();
  }, [client, ticketId, version, areaChanges, retries]);

  useEffect(() => {
    const timer = setInterval(() => setClock((tick) => tick + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Entradas novas entram acima: devolve a rolagem para que o texto lido continue no mesmo lugar da tela. A conferência
  // se repete no quadro seguinte, porque o navegador ainda pode medir a altura das linhas novas depois da primeira passada.
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    const restore = () => {
      saved.body.scrollTop += offsetOf(saved.body, saved.item) - saved.offset;
    };
    restore();
    anchor.current = null;
    const frame = requestAnimationFrame(() => requestAnimationFrame(restore));
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const showOlder = async () => {
    if (load.status !== "ready" || load.before === null || older === "loading") return;
    const before = load.before;
    const mine = generation.current;
    const body = section.current?.closest<HTMLElement>(".ticket-body") ?? null;
    setOlder("loading");
    const result = await safe(() => client.ticketActivity(ticketId, { before, limit: ACTIVITY_PAGE_SIZE }, {}));
    if (generation.current !== mine) return;
    if (!result.ok) {
      setOlder({ error: result.error });
      return;
    }
    const item = section.current?.querySelector<HTMLElement>(".ticket-activity-item") ?? null;
    if (body && item) anchor.current = { body, item, offset: offsetOf(body, item) };
    setOlder("idle");
    setLoad((current) => {
      if (current.status !== "ready") return current;
      const known = new Set(current.entries.map((entry) => entry.id));
      return { ...current, entries: [...current.entries, ...result.data.entries.filter((entry) => !known.has(entry.id))], before: result.data.before };
    });
  };

  const now = new Date();
  const mentions: MentionContext = { projectId, tickets, ownId: ticketId, onOpen: onOpenTicket };
  // Comentário novo, editado ou removido: a lista local muda na hora, sem refazer a busca (que perderia as páginas já abertas).
  const replace = (entry: ActivityComment) => {
    setLoad((current) => (current.status === "ready" ? { ...current, entries: current.entries.map((item) => (item.id === entry.id ? entry : item)) } : current));
    onCommentsChanged();
  };
  const append = (entry: ActivityComment) => {
    setLoad((current) => (current.status === "ready" ? { ...current, entries: [entry, ...current.entries] } : current));
    onCommentsChanged();
  };
  return (
    <section ref={section} className="ticket-section ticket-activity" aria-labelledby="ticket-activity-heading">
      <div className="ticket-section-head">
        <h2 id="ticket-activity-heading">{t("activity.heading")}</h2>
      </div>
      {load.status === "loading" && <p role="status" className="ticket-muted">{t("activity.loading")}</p>}
      {load.status === "error" && <ActivityError error={load.error} onRetry={() => { setLoad({ status: "loading" }); setRetries((n) => n + 1); }} />}
      {load.status === "ready" && load.entries.length === 0 && <p className="ticket-muted">{t("activity.empty")}</p>}
      {load.status === "ready" && load.entries.length > 0 && (
        <>
          {load.before !== null && (
            <div className="ticket-activity-older">
              <button type="button" className="text" disabled={older === "loading"} onClick={() => void showOlder()}>
                {older === "loading" ? t("activity.olderLoading") : t("activity.older")}
              </button>
              {typeof older === "object" && <ActivityError error={older.error} onRetry={() => void showOlder()} />}
            </div>
          )}
          <ol className="ticket-activity-list" aria-label={t("activity.list")}>
            {[...load.entries].reverse().map((entry) =>
              entry.type === "comment" ? (
                <CommentItem key={entry.id} client={client} entry={entry} mentions={mentions} language={language} now={now} onChange={replace} onOpenArea={onOpenArea} />
              ) : (
                <li key={entry.id} className="ticket-activity-item">
                  <Avatar person={entry.actor} />
                  <span className="ticket-activity-text">
                    {entry.type === "linear_history" || entry.type === "linear_created" ? <LinearSentence entry={entry} onOpenTicket={onOpenTicket} /> : <Sentence entry={entry} onOpenTicket={onOpenTicket} />}
                    <ViaMcp via={entry.via} />
                    {(entry.type === "linear_history" || entry.type === "linear_created") && <FromLinearBadge />}
                  </span>
                  <time className="ticket-activity-time" dateTime={entry.occurredAt} title={formatDateTime(language, entry.occurredAt)}>
                    {formatActivityTime(language, entry.occurredAt, now)}
                  </time>
                </li>
              ),
            )}
          </ol>
        </>
      )}
      {load.status === "ready" && load.canComment && <CommentComposer client={client} ticketId={ticketId} mentions={mentions} onAdded={append} />}
    </section>
  );
}

/** Erro só desta seção: o resto da página continua como está. */
function ActivityError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useTranslation();
  const { t: tTicket } = useTranslation("ticket");
  return (
    <div className="load-error" role="alert">
      <p>{loadErrorText(error, t)}</p>
      <button type="button" onClick={onRetry}>{tTicket("activity.retry")}</button>
    </div>
  );
}

/** Onde a linha está dentro da área rolável, em pixels a partir do topo dela. */
const offsetOf = (body: HTMLElement, item: HTMLElement): number => item.getBoundingClientRect().top - body.getBoundingClientRect().top;

/** Ticket citado: clicável quando existe, texto simples quando foi removido. */
function TicketRef({ target, onOpen, children }: { target: ActivityTicketRef; onOpen: (id: string) => void; children?: ReactNode }): ReactElement {
  const id = target.id;
  if (id === null) return <span className="ticket-activity-gone">{children}</span>;
  return <button type="button" className="ticket-activity-ref" onClick={() => onOpen(id)}>{children}</button>;
}

function Sentence({ entry, onOpenTicket }: { entry: ActivityEntry; onOpenTicket: (id: string) => void }) {
  const { t, i18n } = useTranslation("ticket");
  const language = i18n.language as Language;
  const { t: tMap } = useTranslation("map");
  const statusText = useStatusText();
  const ticketText = (target: ActivityTicketRef): string => {
    if (target.id !== null) return `${target.key ?? ""} ${target.title ?? ""}`.trim();
    return target.key === null ? t("activity.removedTicket") : t("activity.removedTicketKey", { key: target.key });
  };
  const ref = (target: ActivityTicketRef) => <TicketRef target={target} onOpen={onOpenTicket} />;
  const who = <strong />;
  // Entrada automática (reimportação do Linear) usa as frases "automaticamente", como a situação já faz.
  const automatic = entry.type !== "status_changed" && entry.automatic === true ? "automatic" : undefined;
  const noActor = entry.actor === null ? "noActor" : undefined;
  const values: Record<string, string> = { actor: entry.actor?.displayName ?? "" };
  const render = (key: string, extra: { context?: string | undefined; values?: Record<string, string>; components?: Record<string, ReactElement>; count?: number } = {}) => (
    <Trans
      t={t}
      i18nKey={`activity.${key}` as never}
      count={extra.count}
      context={extra.context ?? automatic ?? noActor}
      values={{ ...values, ...extra.values }}
      components={{ who, name: <strong />, ...extra.components }}
    />
  );

  switch (entry.type) {
    case "created":
      return render("created");
    case "title_changed":
      return render("titleChanged", { values: { from: entry.from, to: entry.to } });
    case "description_changed":
      return render("descriptionChanged");
    case "status_changed": {
      const status = { from: statusText(entry.from), to: statusText(entry.to) };
      if (!entry.automatic) return render("statusChanged", { values: status });
      const cause = entry.causedBy;
      const reopened = entry.from === "done" && entry.to === "todo";
      const key = reopened ? "reopened" : "statusAutomatic";
      return render(key, {
        context: cause === null ? "noCause" : undefined,
        values: { ...status, ticket: cause === null ? "" : ticketText(cause) },
        components: cause === null ? {} : { ticket: ref(cause) },
      });
    }
    case "priority_changed":
      return render("priorityChanged", { values: { from: String(entry.from), to: String(entry.to) } });
    case "due_date_changed": {
      const { from, to } = entry;
      const key = from === null ? "dueDateSet" : to === null ? "dueDateRemoved" : "dueDateChanged";
      return render(key, { values: { from: from === null ? "" : formatDueDate(language, from), to: to === null ? "" : formatDueDate(language, to) } });
    }
    case "labels_changed": {
      // Plural de cada lado: o lado único usa `count`; com os dois, a chave diz o número do primeiro e `count` o do segundo.
      const added = formatList(language, entry.added.map((label) => label.name));
      const removed = formatList(language, entry.removed.map((label) => label.name));
      const names = { added, removed };
      if (entry.removed.length === 0) return render("labelsAdded", { values: names, count: entry.added.length });
      if (entry.added.length === 0) return render("labelsRemoved", { values: names, count: entry.removed.length });
      return render(entry.added.length === 1 ? "labelsChangedOne" : "labelsChangedMany", { values: names, count: entry.removed.length });
    }
    case "parent_changed": {
      const { from, to } = entry;
      const key = from !== null && to !== null ? "parentChanged" : to !== null ? "parentMoved" : "parentRemoved";
      return render(key, {
        values: { from: from === null ? "" : ticketText(from), to: to === null ? "" : ticketText(to) },
        components: { ...(from === null ? {} : { from: ref(from) }), ...(to === null ? {} : { to: ref(to) }) },
      });
    }
    case "comments_imported":
      return <>{t("activity.commentsImported", { count: entry.count })}</>;
    case "relations_imported":
      return <>{t("activity.relationsImported", { count: entry.count })}</>;
    case "history_imported":
      return <>{t("activity.historyImported", { count: entry.count })}</>;
    case "agent_work_started":
      return render("agentWorkStarted");
    case "agent_work_ended":
      return render("agentWorkEnded", { context: entry.reason === "person" && entry.actor === null ? "personNoActor" : entry.reason });
    case "idea_registered":
      return render("ideaRegistered");
    case "idea_stage_changed":
      return render("ideaStageChanged", { values: { from: tMap(`idea.stage.${entry.from}`), to: tMap(`idea.stage.${entry.to}`) } });
    case "idea_accepted":
      return render("ideaAccepted");
    case "idea_discarded":
      return render("ideaDiscarded");
    case "idea_reopened":
      return render("ideaReopened");
    case "assignee_added":
    case "assignee_removed":
      return render(entry.type === "assignee_added" ? "assigneeAdded" : "assigneeRemoved", { values: { person: entry.person?.displayName ?? t("people.removed") } });
    case "dependency_added":
      // Com o tipo (ADR 0068) quando o evento o traz; os antigos ficam com a frase de sempre.
      return render(entry.need === "deliver" ? "dependencyAddedDeliver" : entry.need === "start" ? "dependencyAddedStart" : "dependencyAdded", { values: { ticket: ticketText(entry.ticket) }, components: { ticket: ref(entry.ticket) } });
    case "dependency_removed":
      return render("dependencyRemoved", { values: { ticket: ticketText(entry.ticket) }, components: { ticket: ref(entry.ticket) } });
    case "dependency_need_changed":
      return render("dependencyNeedChanged", { values: { ticket: ticketText(entry.ticket), from: t(`dependsOn.need.${entry.from}`), to: t(`dependsOn.need.${entry.to}`) }, components: { ticket: ref(entry.ticket) } });
    case "impediment_marked":
      return render("impedimentMarked");
    case "impediment_cleared":
      return render("impedimentCleared");
    case "related_removed":
      return render("relatedRemoved", { values: { ticket: ticketText(entry.ticket) }, components: { ticket: ref(entry.ticket) } });
    case "summary_updated":
      return render(entry.source === "person" ? "summaryByPerson" : "summaryByAssistant", { values: { section: t("summary.heading") } });
    case "contribution_added":
    case "contribution_removed":
    case "contribution_text_changed":
    case "contribution_status_changed":
    case "contribution_person_added":
    case "contribution_person_removed": {
      const area = entry.area?.name ?? t("contributions.removedArea");
      const key = { contribution_added: "contributionAdded", contribution_removed: "contributionRemoved", contribution_text_changed: "contributionTextChanged", contribution_status_changed: "contributionStatusChanged", contribution_person_added: "contributionPersonAdded", contribution_person_removed: "contributionPersonRemoved" }[entry.type];
      const contribution = (status: "todo" | "in_progress" | "done") => t(`contributions.status.${status}`);
      const extra: Record<string, string> = { area };
      if (entry.type === "contribution_status_changed") Object.assign(extra, { from: contribution(entry.from), to: contribution(entry.to) });
      if (entry.type === "contribution_person_added" || entry.type === "contribution_person_removed") extra["person"] = entry.person?.displayName ?? t("people.removed");
      return render(key, { values: extra });
    }
    case "comment":
    case "linear_history":
    case "linear_created":
      return null;
  }
}

type LinearEntry = Extract<ActivityEntry, { type: "linear_history" | "linear_created" }>;
/** Pai ou projeto que o Linear citou mas que não está aqui (ou é desconhecido): `id` e `key` nulos. */
const knownRef = (target: ActivityTicketRef | null): ActivityTicketRef | null => (target === null || (target.id === null && target.key === null) ? null : target);

/**
 * Uma entrada do histórico do Linear (ADR 0061, fatia 4): o autor e, numa linha só, as frases de cada mudança juntas pelo
 * separador do catálogo. O autor é a pessoa daqui quando casou; senão o nome no Linear (robô: o nome do robô).
 */
function LinearSentence({ entry, onOpenTicket }: { entry: LinearEntry; onOpenTicket: (id: string) => void }) {
  const { t } = useTranslation("ticket");
  const linearName = (name: string | null): string => (name === null ? t("activity.comment.linearAuthorUnknown") : t("activity.comment.linearAuthor", { name }));
  const author = entry.actor?.displayName ?? (entry.externalActor ? linearName(entry.externalActor.name) : t("people.removed"));
  const side = (value: LinearAssigneeSide): string => (value.kind === "linear" ? linearName(value.name) : value.person?.displayName ?? t("people.removed"));
  const ticketText = (target: ActivityTicketRef): string => {
    if (target.id !== null) return `${target.key ?? ""} ${target.title ?? ""}`.trim();
    return target.key === null ? t("activity.removedTicket") : t("activity.removedTicketKey", { key: target.key });
  };
  const ref = (target: ActivityTicketRef) => <TicketRef target={target} onOpen={onOpenTicket} />;
  const phrase = (key: string, values: Record<string, string> = {}, components: Record<string, ReactElement> = {}) => (
    <Trans t={t} i18nKey={`activity.linear.${key}` as never} values={values} components={{ name: <strong />, ...components }} />
  );
  const moved = (prefix: "parent" | "project", change: { from: ActivityTicketRef | null; to: ActivityTicketRef | null }) => {
    const from = knownRef(change.from);
    const to = knownRef(change.to);
    if (from === null && to === null) return phrase(`${prefix}Unknown`);
    const key = from !== null && to !== null ? "Changed" : to !== null ? "Moved" : "Removed";
    return phrase(
      `${prefix}${key}`,
      { from: from === null ? "" : ticketText(from), to: to === null ? "" : ticketText(to) },
      { ...(from === null ? {} : { from: ref(from) }), ...(to === null ? {} : { to: ref(to) }) },
    );
  };
  const describe = (change: LinearChange): ReactElement => {
    switch (change.field) {
      case "status": {
        const { from, to } = change;
        if (from !== null && to !== null) return phrase("status", { from: from.name, to: to.name });
        if (to !== null) return phrase("statusTo", { to: to.name });
        if (from !== null) return phrase("statusFrom", { from: from.name });
        return phrase("statusNone");
      }
      case "assignee": {
        const { from, to } = change;
        if (from !== null && to !== null) return phrase("assigneeChanged", { from: side(from), to: side(to) });
        if (to !== null) return phrase("assigneeAdded", { to: side(to) });
        if (from !== null) return phrase("assigneeRemoved", { from: side(from) });
        return phrase("assigneeNone");
      }
      case "priority":
        return phrase("priority", { from: String(change.from), to: String(change.to) });
      case "title":
        return phrase("title", { from: change.from, to: change.to });
      case "parent":
      case "project":
        return moved(change.field, change);
      case "description":
        return phrase("description");
    }
  };
  const phrases = entry.type === "linear_created" ? [phrase("created")] : entry.changes.map(describe);
  const separator = t("activity.linear.separator");
  return (
    <>
      <strong>{author}</strong>{" "}
      {phrases.map((item, index) => (
        <span key={index} className="ticket-activity-change">{index > 0 && separator}{item}</span>
      ))}
    </>
  );
}
