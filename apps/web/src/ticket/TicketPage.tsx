import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useChats } from "../chat/ChatsContext.js";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person, Project, Team, TicketDetail, TicketStatus, TicketSummary } from "../api/client.js";
import { assistantEnabled, githubEnabled } from "../api/client.js";
import { useAgentWorkActive } from "../map/agentWork.js";
import { formatClock, formatDate, formatDateTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { TicketCode } from "../github/TicketCode.js";
import { safeLinearUrl } from "./linearLink.js";
import { useApiResource } from "../api/useApiResource.js";
import { canCreateTickets, canRemoveTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { TicketMark, progressText, statusText, ticketStateText } from "../map/nodeContent.js";
import { isBlocked, isInDiscardedIdea } from "../map/ticketState.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { Contributions } from "./Contributions.js";
import { CreateTicket } from "./CreateTicket.js";
import { ItemsSummary } from "./ItemsSummary.js";
import { CommentPeopleProvider } from "./commentPeople.js";
import { TicketActivity } from "./TicketActivity.js";
import { peopleWhoSee } from "../chat/directory.js";
import { DependsOnField, DerivedStatus, DescriptionField, FromLinearBadge, ImpedimentField, RelatedField, IdeaField, InsideIdeaValue, ParentField, DueDateField, PeopleField, PriorityField, StatusField, StatusValue, TitleField } from "./fields.js";
import { ActionsMenu } from "./menu.js";
import { LabelsField } from "./LabelsField.js";
import { ancestorsOf } from "./tree.js";
import { isStatusDerived } from "@treepm/domain";
import { ticketHref } from "../nav/navigation.js";
import "./ticket.css";
import { useDescribeApiError } from "../api/errorText.js";

export interface CreateRequest {
  projectId: string;
  parentId: string | null;
  /** O ticket pai, quando já se sabe: a criação avisa se ele é concluído e vai ser reaberto (ADR 0034). */
  parent?: { key: string; status: TicketStatus };
  /** Cria uma ideia no estágio "Nova" em vez de um ticket comum (ADR 0042). */
  idea?: boolean;
  /** Valores iniciais, por exemplo o rascunho da conversa com a IA (ADR 0029). */
  draft?: { title: string; description: string };
}

export interface TicketPageProps {
  client: ApiClient;
  me: Me;
  projects: readonly Project[];
  /** Ticket exibido (`?ticket=` da URL). */
  ticketId: string | null;
  /** Modo de criação: tem prioridade sobre `ticketId`. Não vai para a URL. */
  creating: CreateRequest | null;
  onOpenTicket: (id: string) => void;
  onClose: () => void;
  /** Depois de qualquer mudança no servidor, para o mapa recarregar. */
  onChanged: () => void;
  onRemoved: () => void;
  /** Refaz o foco da câmera no ticket (o mesmo enquadramento de quando ele abre). Sem ela, não há "Ver no mapa". */
  onShowOnMap?: (ticketId: string) => void;
  onStartCreate: (request: CreateRequest) => void;
  onCancelCreate: () => void;
  onCreated: (ticketId: string) => void;
  /**
   * O marcador de trabalho pela IA do ticket aberto, como a lista do mapa o traz (ADR 0043). Quando difere do que a página
   * tem, o detalhe é buscado de novo, desde que nenhum campo esteja em edição. Sem a prop, a página não acompanha a lista.
   */
  listedAgentWork?: TicketSummary["agentWork"];
}

const Icon = ({ children, fill = false }: { children: ReactNode; fill?: boolean }) => (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.4" strokeLinecap="round">
    {children}
  </svg>
);

/** O atalho "Ver no Linear" do ticket, ou nada quando ele não veio do Linear ou o endereço não é do Linear. */
function linearAction(detail: TicketDetail): HeaderActions["linear"] {
  const source = detail.externalSource;
  if (!source) return undefined;
  // Sem endereço (o servidor não soube montá-lo) ou com um que não é do Linear: a origem aparece, mas sem link.
  return { key: source.key, url: source.url === null ? null : safeLinearUrl(source.url), missingSince: source.missingSince ?? null };
}

interface HeaderActions {
  ticketId: string;
  onShowOnMap?: (ticketId: string) => void;
  /** Só para quem pode excluir. */
  remove?: { busy: boolean; onConfirm: () => void };
  /** De onde o ticket veio no Linear (ADR 0060): `url` já é segura (só `https://linear.app/…`); `key` é nula num projeto do Linear. */
  linear?: { key: string | null; url: string | null; missingSince: string | null };
  /** Só para quem edita um ticket comum (ADR 0042); `error` é a recusa da API, mostrada junto do menu. */
  makeIdea?: { busy: boolean; error: string | null; onClick: () => void };
  /** Só para quem edita um ticket comum aberto sem impedimento (ADR 0068): abre a linha "Impedimento" pedindo o motivo. */
  markImpediment?: { onClick: () => void };
}

type CopyState = "idle" | "copied" | "failed";

function Header({ projectKey, keyText, path, onClose, actions }: { projectKey: string; keyText: string; path: string; onClose: () => void; actions?: HeaderActions }) {
  const { t, i18n } = useTranslation("ticket");
  const chats = useChats();
  const [copy, setCopy] = useState<CopyState>("idle");
  useEffect(() => {
    if (copy === "idle") return;
    const timer = setTimeout(() => setCopy("idle"), 3000);
    return () => clearTimeout(timer);
  }, [copy]);

  const copyLink = async (ticketId: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${ticketHref(ticketId)}`);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <header className="ticket-header">
      <div className="ticket-crumbs">
        {projectKey !== "" && <span className="ticket-project-key">{projectKey}</span>}
        {projectKey !== "" && keyText !== "" && <span aria-hidden="true">›</span>}
        {keyText !== "" && <span className="ticket-key">{keyText}</span>}
        {path !== "" && <span aria-hidden="true">·</span>}
        {path !== "" && <span className="ticket-path">{path}</span>}
      </div>
      <div className="ticket-header-actions">
        {copy === "copied" && <span role="status" className="ticket-toast">{t("header.linkCopied")}</span>}
        {copy === "failed" && <span role="alert" className="ticket-toast is-error">{t("header.copyFailed")}</span>}
        {actions?.makeIdea?.error && <span role="alert" className="ticket-toast is-error">{actions.makeIdea.error}</span>}
        {actions && (
          <>
            {actions.linear && actions.linear.url === null && (
              <span className="ticket-linear-plain">{actions.linear.key === null ? t("linear.plain") : t("linear.plainKey", { key: actions.linear.key })}</span>
            )}
            {actions.linear && actions.linear.url !== null && (
              <a
                className="ticket-chat-button ticket-linear-link"
                href={actions.linear.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={actions.linear.key === null ? t("linear.viewLabel") : t("linear.viewKeyLabel", { key: actions.linear.key })}
              >
                {actions.linear.key === null ? t("linear.view") : t("linear.viewKey", { key: actions.linear.key })}
              </a>
            )}
            {actions.linear?.missingSince != null && (
              <span className="ticket-linear-missing">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 1.8 14.6 13.4H1.4Z" />
                  <path d="M8 6.4v3.2M8 11.6v.1" />
                </svg>
                <span>{t("linear.missingSince", { date: formatDate(i18n.language as Language, actions.linear.missingSince) })}</span>
              </span>
            )}
            {chats && (
              <button type="button" className="ticket-chat-button" onClick={() => chats.openTicket(actions.ticketId)}>
                {t("header.openChat")}
              </button>
            )}
            {actions.onShowOnMap && (
              <button type="button" className="ticket-icon-button" aria-label={t("header.viewOnMap")} onClick={() => actions.onShowOnMap?.(actions.ticketId)}>
                <Icon><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" /></Icon>
              </button>
            )}
            <button type="button" className="ticket-icon-button" aria-label={t("header.copyLink")} onClick={() => void copyLink(actions.ticketId)}>
              <Icon><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" /></Icon>
            </button>
            {(actions.remove || actions.makeIdea || actions.markImpediment) && (
              <ActionsMenu label={t("header.more")} trigger={<Icon fill><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></Icon>}>
                {(close) => (
                  <>
                    {actions.makeIdea && (
                      <button
                        type="button"
                        disabled={actions.makeIdea.busy}
                        onClick={() => {
                          close();
                          actions.makeIdea!.onClick();
                        }}
                      >
                        {t("idea.make")}
                      </button>
                    )}
                    {actions.markImpediment && (
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          actions.markImpediment!.onClick();
                        }}
                      >
                        {t("impediment.mark")}
                      </button>
                    )}
                    {actions.remove && (
                      <ConfirmAction
                        label={t("remove.label")}
                        disabled={actions.remove.busy}
                        onConfirm={() => {
                          close();
                          actions.remove!.onConfirm();
                        }}
                      />
                    )}
                  </>
                )}
              </ActionsMenu>
            )}
          </>
        )}
        <button type="button" className="ticket-icon-button" aria-label={t("page.close")} onClick={onClose}>
          <Icon><path d="m4 4 8 8M12 4l-8 8" /></Icon>
        </button>
      </div>
    </header>
  );
}

/** Página do ticket (ADR 0026): região complementar à direita do mapa, de leitura e edição. */
export function TicketPage(props: TicketPageProps) {
  const { t } = useTranslation("ticket");
  const { ticketId, creating, onClose, onCancelCreate } = props;
  const ref = useRef<HTMLElement>(null);

  // Foco entra na página ao abrir; o título o toma assim que o ticket carrega.
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    // Nada do que acontece aqui dentro chega aos atalhos do mapa.
    event.stopPropagation();
    if (event.key !== "Escape") return;
    if (creating) onCancelCreate();
    else onClose();
  };

  const createProject = creating ? props.projects.find((project) => project.id === creating.projectId) ?? null : null;
  return (
    <aside ref={ref} className="ticket-page" aria-label={t("page.label")} tabIndex={-1} onKeyDown={onKeyDown}>
      {creating ? (
        <>
          <Header projectKey={createProject?.key ?? ""} keyText="" path={createProject?.name ?? ""} onClose={onClose} />
          <CreateTicket client={props.client} project={createProject} request={creating} onChanged={props.onChanged} onCreated={props.onCreated} onCancel={onCancelCreate} />
        </>
      ) : ticketId ? (
        <ViewTicket key={ticketId} {...props} ticketId={ticketId} />
      ) : null}
    </aside>
  );
}

function ViewTicket(props: TicketPageProps & { ticketId: string }) {
  const { t } = useTranslation("ticket");
  const describeError = useDescribeApiError();
  const { client, ticketId, onClose } = props;
  const detail = useApiResource(() => safe(() => client.getTicket(ticketId)));

  if (detail.state.status !== "ready") {
    return (
      <>
        <Header projectKey="" keyText="" path="" onClose={onClose} />
        <div className="ticket-body">
          <div className="ticket-scroll">
            {detail.state.status === "loading" && <p role="status">{t("page.loading")}</p>}
            {detail.state.status === "error" &&
              (detail.state.error.kind === "not_found" ? (
                <p role="alert">{describeError(detail.state.error)}</p>
              ) : (
                <LoadError error={detail.state.error} onRetry={detail.retry} />
              ))}
          </div>
        </div>
      </>
    );
  }
  return <LoadedTicket {...props} detail={detail.state.data} reloadDetail={detail.reload} />;
}

interface LoadedProps extends TicketPageProps {
  ticketId: string;
  detail: TicketDetail;
  reloadDetail: () => void;
}

function LoadedTicket(props: LoadedProps) {
  const { t } = useTranslation("ticket");
  const { client, detail, projects, onClose } = props;
  const tickets = useApiResource(() => safe(() => client.listTickets(detail.projectId)));
  const people = useApiResource(() => safe(() => client.listPeople()));
  // As equipes só decidem quem enxerga um projeto privado; sem elas (ou se falharem) a lista do `@` ainda traz o resto.
  const teams = useApiResource(() => safe(() => client.listTeams()));

  if (tickets.state.status === "error") return <PageError onClose={onClose} error={tickets.state.error} onRetry={tickets.retry} />;
  if (people.state.status === "error") return <PageError onClose={onClose} error={people.state.error} onRetry={people.retry} />;
  if (tickets.state.status !== "ready" || people.state.status !== "ready") {
    return (
      <>
        <Header projectKey={projects.find((entry) => entry.id === detail.projectId)?.key ?? ""} keyText={detail.key} path="" onClose={onClose} />
        <div className="ticket-body">
          <div className="ticket-scroll"><p role="status">{t("page.loading")}</p></div>
        </div>
      </>
    );
  }
  return <ReadyTicket {...props} list={tickets.state.data} people={people.state.data} teams={teams.state.status === "ready" ? teams.state.data : []} reloadList={tickets.reload} />;
}

interface ReadyProps extends LoadedProps {
  list: readonly TicketSummary[];
  people: readonly Person[];
  teams: readonly Team[];
  reloadList: () => void;
}

/** Só o que o marcador diz de si, para comparar o da lista com o do detalhe (o detalhe ainda traz `by`). */
const agentWorkKey = (agentWork: TicketSummary["agentWork"]): string => (agentWork ? `${agentWork.since}|${agentWork.until}|${agentWork.note ?? ""}` : "none");

/** Há um campo da página em edição (o foco está num campo de texto dentro dela)? */
function useEditingField(): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const editable = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.closest(".ticket-page") !== null && (target.matches("input:not([type=checkbox]):not([type=radio]), textarea, select") || target.isContentEditable);
    const onIn = (event: FocusEvent) => setEditing(editable(event.target));
    const onOut = (event: FocusEvent) => setEditing(editable(event.relatedTarget));
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return editing;
}

function AgentWorkRow({ detail, onEnd, busy }: { detail: TicketDetail; onEnd: (() => void) | null; busy: boolean }) {
  const { t, i18n } = useTranslation("ticket");
  const language = i18n.language as Language;
  const agentWork = detail.agentWork;
  const active = useAgentWorkActive(agentWork);
  if (!agentWork || !active) return null;
  return (
    <div className="ticket-row ticket-agent-work">
      <dt>{t("agentWork.label")}</dt>
      <dd>
        <span className="ticket-value">
          {agentWork.by && <span className="ticket-agent-work-by">{agentWork.by.displayName}</span>}
          <span title={formatDateTime(language, agentWork.until)}>{t("agentWork.until", { time: formatClock(language, agentWork.until) })}</span>
          {agentWork.note && <span className="ticket-agent-work-note">{agentWork.note}</span>}
          {onEnd && <ConfirmAction label={t("agentWork.end")} tone="neutral" disabled={busy} onConfirm={onEnd} />}
        </span>
      </dd>
    </div>
  );
}

/**
 * De quando e de quem veio o ticket no Linear (ADR 0061): criação (com o autor, pela pessoa do TreePM ou pelo nome no Linear) e
 * as datas de início, conclusão e cancelamento que existirem. Texto secundário; ticket sem origem, ou de uma API antiga sem os
 * campos, não escreve nada. Pessoa que não está na lista some (a data fica sem autor), nunca um nome inventado.
 */
function LinearOrigin({ detail, people }: { detail: TicketDetail; people: readonly Person[] }) {
  const { t, i18n } = useTranslation("ticket");
  const source = detail.externalSource;
  if (!source) return null;
  const language = i18n.language as Language;
  const date = (iso: string) => formatDate(language, iso);
  const creator = source.creator ?? null;
  const author = creator === null ? null : "personId" in creator ? (people.find((person) => person.id === creator.personId)?.displayName ?? null) : t("linear.origin.externalName", { name: creator.name });
  const lines: string[] = [];
  if (source.createdAt) lines.push(author === null ? t("linear.origin.created", { date: date(source.createdAt) }) : t("linear.origin.createdBy", { date: date(source.createdAt), name: author }));
  if (source.startedAt) lines.push(t("linear.origin.started", { date: date(source.startedAt) }));
  if (source.completedAt) lines.push(t("linear.origin.completed", { date: date(source.completedAt) }));
  if (source.canceledAt) lines.push(t("linear.origin.canceled", { date: date(source.canceledAt) }));
  if (lines.length === 0) return null;
  return (
    <ul className="ticket-linear-origin">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

function ReadyTicket({ client, me, projects, detail, list, people, teams, reloadDetail, reloadList, onOpenTicket, onClose, onChanged, onRemoved, onShowOnMap, onStartCreate, listedAgentWork }: ReadyProps) {
  const { t } = useTranslation("ticket");
  const { t: tMap } = useTranslation("map");
  const describeError = useDescribeApiError();
  const title = useRef<HTMLHeadingElement>(null);
  const removal = useAction();
  const ideaMaking = useAction();
  // O ticket em que a pessoa está marcando um impedimento (ADR 0068); trocar de ticket fecha a marcação.
  const [markingFor, setMarkingFor] = useState<string | null>(null);
  const agentEnding = useAction();
  // Cada alteração feita nesta página pede a atividade de novo (ADR 0040).
  const [activityVersion, setActivityVersion] = useState(0);
  // Comentários (ADR 0041, fatia 2): o que muda numa conversa de área e o que muda na seção "Atividade" avisa o outro lado,
  // e o ticket é lido de novo para a contagem de cada área. `openArea` pede para abrir a conversa de uma área.
  const [areaChanges, setAreaChanges] = useState(0);
  const [activityChanges, setActivityChanges] = useState(0);
  const [openArea, setOpenArea] = useState<{ id: string; n: number } | null>(null);

  useEffect(() => {
    // No modo play o foco fica na barra do play (ADR 0048): a página não o toma de quem avança pelo teclado.
    if (document.activeElement?.closest("[data-keeps-focus]")) return;
    title.current?.focus();
  }, []);

  const project = projects.find((entry) => entry.id === detail.projectId) ?? null;
  const canEdit = project !== null && canCreateTickets(me, project);
  const canRemove = project !== null && canRemoveTickets(me, project);
  const archived = project !== null && project.archivedAt !== null;

  const refresh = () => {
    setActivityVersion((version) => version + 1);
    reloadDetail();
    reloadList();
    onChanged();
  };

  // O mapa se atualiza sozinho e a lista dele pode trazer um marcador diferente do que esta página tem: busca o detalhe de novo,
  // mas nunca com um campo em edição (volta a tentar quando o foco sai dele).
  const editing = useEditingField();
  const listedKey = listedAgentWork === undefined ? null : agentWorkKey(listedAgentWork);
  const ownKey = agentWorkKey(detail.agentWork);
  useEffect(() => {
    if (listedKey === null || listedKey === ownKey || editing) return;
    reloadDetail();
    setActivityVersion((version) => version + 1);
  }, [listedKey, ownKey, editing]);
  const endAgentWork = async () => {
    const result = await agentEnding.run(() => client.endAgentWork(detail.id));
    if (result.ok) refresh();
  };

  const commentsChangedInArea = () => {
    setAreaChanges((n) => n + 1);
    reloadDetail();
  };
  const commentsChangedInActivity = () => {
    setActivityChanges((n) => n + 1);
    reloadDetail();
  };

  const children = list.filter((entry) => entry.parentId === detail.id);
  const parent = detail.parentId === null ? null : list.find((entry) => entry.id === detail.parentId) ?? null;
  const path = [project?.name ?? "", ...ancestorsOf(list, detail).map((entry) => entry.title)].filter((part) => part !== "").join(" › ");

  const idea = detail.idea ?? null;
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const makeIdea = async () => {
    const result = await ideaMaking.run(() => client.makeIdea(detail.id));
    if (result.ok) refresh();
  };
  const makeIdeaError = ideaMaking.error === null ? null : ideaMaking.error.kind === "conflict" ? t("idea.makeRefused") : describeError(ideaMaking.error);

  // Impedimento (ADR 0068): marcar fica no menu "Mais ações" (a página sem impedimento não muda); a linha aparece marcando ou com impedimento.
  const impediment = detail.impediment ?? null;
  const markingImpediment = markingFor === detail.id && impediment === null;
  const canMarkImpediment = canEdit && idea === null && impediment === null && detail.status !== "done" && detail.status !== "cancelled";

  const remove = async () => {
    const result = await removal.run(() => client.removeTicket(detail.id));
    if (!result.ok) return;
    onChanged();
    onRemoved();
  };

  const readOnlyStatus = isStatusDerived(detail.progress) ? (
    <DerivedStatus detail={detail} />
  ) : (
    <span className="ticket-value">
      <StatusValue status={detail.status} blocked={isBlocked(detail)} />
    </span>
  );

  const commentPeople = useMemo(() => {
    const options = peopleWhoSee(project ?? undefined, people, teams, me.person.id).map((person) => ({ person, blocked: false }));
    return { options, names: new Map(people.map((person) => [person.id, person.displayName] as const)) };
  }, [project, people, teams, me.person.id]);

  return (
    <CommentPeopleProvider value={commentPeople}>
    <>
      <Header
        projectKey={project?.key ?? ""}
        keyText={detail.key}
        path={path}
        onClose={onClose}
        actions={{
          ticketId: detail.id,
          onShowOnMap,
          remove: canRemove ? { busy: removal.busy, onConfirm: () => void remove() } : undefined,
          linear: linearAction(detail),
          makeIdea: canEdit && idea === null ? { busy: ideaMaking.busy, error: makeIdeaError, onClick: () => void makeIdea() } : undefined,
          markImpediment: canMarkImpediment ? { onClick: () => setMarkingFor(detail.id) } : undefined,
        }}
      />
      <div className="ticket-body">
        <div className="ticket-scroll">
          {!canEdit && (
            <p className="ticket-notice">
              {t(archived ? "readOnly.archived" : "readOnly.reader")}
            </p>
          )}
          {agentEnding.error && <p role="alert" className="ticket-error">{describeError(agentEnding.error)}</p>}
          {removal.error && <p role="alert" className="ticket-error">{describeError(removal.error, "remove")}</p>}
          <TitleField ref={title} client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
          <LinearOrigin detail={detail} people={people} />
          <dl className="ticket-fields">
            <div className="ticket-row">
              <dt>{t(idea?.root === true ? "fields.idea" : "fields.status")}</dt>
              <dd>
                {idea?.root === true ? (
                  <IdeaField client={client} detail={detail} stage={idea.stage} canEdit={canEdit} canTriage={detail.canTriageIdea === true} onSaved={refresh} />
                ) : idea !== null ? (
                  <InsideIdeaValue rootId={idea.rootId} rootKey={idea.rootKey} discarded={isInDiscardedIdea({ ...detail, idea }, byId)} onOpen={onOpenTicket} />
                ) : canEdit ? (
                  <StatusField client={client} detail={detail} onSaved={refresh} />
                ) : (
                  readOnlyStatus
                )}
              </dd>
            </div>
            <AgentWorkRow detail={detail} onEnd={detail.canEndAgentWork === true ? () => void endAgentWork() : null} busy={agentEnding.busy} />
            {/* Impedimento (ADR 0068): aparece com impedimento marcado, ou enquanto a pessoa escreve o motivo. */}
            {(impediment !== null || markingImpediment) && (
              <div className="ticket-row">
                <dt>{t("fields.impediment")}</dt>
                <dd>
                  <ImpedimentField key={detail.id} client={client} detail={detail} canEdit={canEdit} onDone={() => setMarkingFor(null)} onSaved={refresh} />
                </dd>
              </div>
            )}
            {detail.progress && (
              <div className="ticket-row">
                <dt>{t("fields.progress")}</dt>
                <dd>
                  <span className="ticket-value">
                    {detail.progress.total === 0 && detail.progress.excluded === 0 ? (
                      // Só ideias abaixo (ADR 0042): não há trabalho para medir, só a contagem à parte.
                      tMap("idea.count", { count: detail.progress.ideas ?? 0 })
                    ) : (
                    <>
                    <span
                      className="ticket-progress"
                      role="progressbar"
                      aria-label={t("fields.progress")}
                      aria-valuemin={0}
                      aria-valuemax={detail.progress.total}
                      aria-valuenow={detail.progress.done}
                    >
                      <span style={{ width: `${detail.progress.total === 0 ? 0 : Math.round((detail.progress.done / detail.progress.total) * 100)}%` }} />
                    </span>
                    {progressText(tMap, detail.progress)}
                    </>
                    )}
                  </span>
                </dd>
              </div>
            )}
            <div className="ticket-row">
              <dt>{t("fields.people")}</dt>
              <dd>
                <PeopleField client={client} detail={detail} people={people} canEdit={canEdit} onSaved={refresh} />
              </dd>
            </div>
            <div className="ticket-row">
              <dt>{t("fields.priority")}</dt>
              <dd>
                <PriorityField client={client} detail={detail} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
              </dd>
            </div>
            <div className="ticket-row">
              <dt>{t("fields.dueDate")}</dt>
              <dd>
                <DueDateField client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
              </dd>
            </div>
            <div className="ticket-row">
              <dt>{t("fields.labels")}</dt>
              <dd>
                <LabelsField key={detail.id} client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
              </dd>
            </div>
            <div className="ticket-row">
              <dt>{t("fields.parent")}</dt>
              <dd>
                <ParentField client={client} detail={detail} parent={parent} tickets={list} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
              </dd>
            </div>
            {(canEdit || detail.dependsOn.length > 0) && (
              <div className="ticket-row">
                <dt>{t("fields.dependsOn")}</dt>
                <dd>
                  <DependsOnField client={client} detail={detail} tickets={list} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
                </dd>
              </div>
            )}
            {detail.related.length > 0 && (
              <div className="ticket-row">
                <dt>{t("fields.related")}</dt>
                <dd>
                  <RelatedField client={client} detail={detail} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
                </dd>
              </div>
            )}
          </dl>
          <DescriptionField client={client} detail={detail} canEdit={canEdit} assistant={assistantEnabled(me)} tickets={list} onOpenTicket={onOpenTicket} onSaved={refresh} />

          <Contributions client={client} detail={detail} people={people} tickets={list} isAdmin={me.roles.clerk === "admin"} onOpenTicket={onOpenTicket} onSaved={refresh} activityChanges={activityChanges} openRequest={openArea} onCommentsChanged={commentsChangedInArea} />

          <LinkedTickets id="ticket-mentioned-by" heading={t("mentionedBy.heading")} links={detail.mentionedBy} onOpen={onOpenTicket} />
          <LinkedTickets id="ticket-blocking" heading={t("blocking.heading")} links={detail.blocks} onOpen={onOpenTicket} />

          {children.length > 0 && assistantEnabled(me) && <ItemsSummary client={client} ticketId={detail.id} canEdit={canEdit} />}

          <section className="ticket-section" aria-labelledby="ticket-children-heading">
            <div className="ticket-section-head">
              <h2 id="ticket-children-heading">{t("items.heading")}</h2>
              {canEdit && (
                <span className="ticket-section-actions">
                  <button type="button" className="text" onClick={() => onStartCreate({ projectId: detail.projectId, parentId: detail.id, ...(idea === null ? { parent: { key: detail.key, status: detail.status } } : {}) })}>
                    {t("items.newHere")}
                  </button>
                  {idea === null && (
                    <button type="button" className="text" onClick={() => onStartCreate({ projectId: detail.projectId, parentId: detail.id, idea: true })}>
                      {t("items.newIdeaHere")}
                    </button>
                  )}
                </span>
              )}
            </div>
            {children.length === 0 ? (
              <p className="ticket-muted">{t("items.empty")}</p>
            ) : (
              <ul className="ticket-children" aria-labelledby="ticket-children-heading">
                {children.map((child) => (
                  <li key={child.id}>
                    <button type="button" className="ticket-child" onClick={() => onOpenTicket(child.id)}>
                      <span className="ticket-child-main">
                        <TicketMark ticket={child} discarded={isInDiscardedIdea(child, byId)} />
                        <span className="ticket-key">{child.key}</span>
                        <span className="ticket-child-title">{child.title}</span>
                      </span>
                      <span className="ticket-child-state">
                        {(child.priority ?? 0) !== 0 && <span className="ticket-child-priority" role="img" aria-label={t("items.priority", { value: child.priority })}>{child.priority}</span>}
                        {ticketStateText(tMap, child)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {githubEnabled(me) && <TicketCode client={client} detail={detail} project={project} />}

          <TicketActivity client={client} ticketId={detail.id} projectId={detail.projectId} tickets={list} version={activityVersion} areaChanges={areaChanges} onOpenTicket={onOpenTicket} onOpenArea={(id) => setOpenArea((current) => ({ id, n: (current?.n ?? 0) + 1 }))} onCommentsChanged={commentsChangedInActivity} />
        </div>
      </div>
    </>
    </CommentPeopleProvider>
  );
}

/** Lista de tickets ligados a este (“Mencionado em”, “Bloqueia”): some quando vazia. */
function LinkedTickets({ id, heading, links, onOpen }: { id: string; heading: string; links: (TicketDetail["mentionedBy"][number] & { fromLinear?: boolean | undefined })[]; onOpen: (id: string) => void }) {
  const { t: tMap } = useTranslation("map");
  if (links.length === 0) return null;
  return (
    <section className="ticket-section" aria-labelledby={`${id}-heading`}>
      <div className="ticket-section-head">
        <h2 id={`${id}-heading`}>{heading}</h2>
      </div>
      <ul className="ticket-children" aria-labelledby={`${id}-heading`}>
        {links.map((from) => (
          <li key={from.id}>
            <button type="button" className="ticket-child" onClick={() => onOpen(from.id)}>
              <span className="ticket-child-main">
                <TicketMark ticket={{ status: from.status, progress: null }} />
                <span className="ticket-key">{from.key}</span>
                <span className="ticket-child-title">{from.title}</span>
                {from.fromLinear === true && <FromLinearBadge />}
              </span>
              <span className="ticket-child-state">{statusText(tMap, from.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageError({ error, onRetry, onClose }: { error: Parameters<typeof LoadError>[0]["error"]; onRetry: () => void; onClose: () => void }) {
  return (
    <>
      <Header projectKey="" keyText="" path="" onClose={onClose} />
      <div className="ticket-body">
        <div className="ticket-scroll"><LoadError error={error} onRetry={onRetry} /></div>
      </div>
    </>
  );
}
