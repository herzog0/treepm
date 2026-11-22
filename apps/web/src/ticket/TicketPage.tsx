import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person, Project, TicketDetail, TicketStatus, TicketSummary } from "../api/client.js";
import { assistantEnabled, githubEnabled } from "../api/client.js";
import { TicketCode } from "../github/TicketCode.js";
import { useApiResource } from "../api/useApiResource.js";
import { canCreateTickets, canRemoveTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { TicketMark, progressText, statusText, ticketStateText } from "../map/nodeContent.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { CreateTicket } from "./CreateTicket.js";
import { ItemsSummary } from "./ItemsSummary.js";
import { DescriptionField, ParentField, PeopleField, StatusField, StatusValue, TitleField } from "./fields.js";
import { ActionsMenu } from "./menu.js";
import { ancestorsOf } from "./tree.js";
import { ticketHref } from "../nav/navigation.js";
import "./ticket.css";
import { useDescribeApiError } from "../api/errorText.js";

export interface CreateRequest {
  projectId: string;
  parentId: string | null;
  /** O ticket pai, quando já se sabe: a criação avisa se ele é concluído e vai ser reaberto (ADR 0034). */
  parent?: { key: string; status: TicketStatus };
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
}

const Icon = ({ children, fill = false }: { children: ReactNode; fill?: boolean }) => (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.4" strokeLinecap="round">
    {children}
  </svg>
);

interface HeaderActions {
  ticketId: string;
  onShowOnMap?: (ticketId: string) => void;
  /** Só para quem pode excluir; sem isso não há "Mais ações". */
  remove?: { busy: boolean; onConfirm: () => void };
}

type CopyState = "idle" | "copied" | "failed";

function Header({ projectKey, keyText, path, onClose, actions }: { projectKey: string; keyText: string; path: string; onClose: () => void; actions?: HeaderActions }) {
  const { t } = useTranslation("ticket");
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
        {actions && (
          <>
            {actions.onShowOnMap && (
              <button type="button" className="ticket-icon-button" aria-label={t("header.viewOnMap")} onClick={() => actions.onShowOnMap?.(actions.ticketId)}>
                <Icon><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" /></Icon>
              </button>
            )}
            <button type="button" className="ticket-icon-button" aria-label={t("header.copyLink")} onClick={() => void copyLink(actions.ticketId)}>
              <Icon><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" /></Icon>
            </button>
            {actions.remove && (
              <ActionsMenu label={t("header.more")} trigger={<Icon fill><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></Icon>}>
                {(close) => (
                  <ConfirmAction
                    label={t("remove.label")}
                    disabled={actions.remove!.busy}
                    onConfirm={() => {
                      close();
                      actions.remove!.onConfirm();
                    }}
                  />
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
  return <ReadyTicket {...props} list={tickets.state.data} people={people.state.data} reloadList={tickets.reload} />;
}

interface ReadyProps extends LoadedProps {
  list: readonly TicketSummary[];
  people: readonly Person[];
  reloadList: () => void;
}

function ReadyTicket({ client, me, projects, detail, list, people, reloadDetail, reloadList, onOpenTicket, onClose, onChanged, onRemoved, onShowOnMap, onStartCreate }: ReadyProps) {
  const { t } = useTranslation("ticket");
  const { t: tMap } = useTranslation("map");
  const describeError = useDescribeApiError();
  const title = useRef<HTMLHeadingElement>(null);
  const removal = useAction();

  useEffect(() => {
    title.current?.focus();
  }, []);

  const project = projects.find((entry) => entry.id === detail.projectId) ?? null;
  const canEdit = project !== null && canCreateTickets(me, project);
  const canRemove = project !== null && canRemoveTickets(me, project);
  const archived = project !== null && project.archivedAt !== null;

  const refresh = () => {
    reloadDetail();
    reloadList();
    onChanged();
  };

  const children = list.filter((entry) => entry.parentId === detail.id);
  const openItems = children.filter((entry) => entry.status !== "done" && entry.status !== "cancelled").length;
  const parent = detail.parentId === null ? null : list.find((entry) => entry.id === detail.parentId) ?? null;
  const path = [project?.name ?? "", ...ancestorsOf(list, detail).map((entry) => entry.title)].filter((part) => part !== "").join(" › ");

  const remove = async () => {
    const result = await removal.run(() => client.removeTicket(detail.id));
    if (!result.ok) return;
    onChanged();
    onRemoved();
  };

  const readOnlyStatus = (
    <span className="ticket-value">
      <StatusValue status={detail.status} />
    </span>
  );

  return (
    <>
      <Header
        projectKey={project?.key ?? ""}
        keyText={detail.key}
        path={path}
        onClose={onClose}
        actions={{ ticketId: detail.id, onShowOnMap, remove: canRemove ? { busy: removal.busy, onConfirm: () => void remove() } : undefined }}
      />
      <div className="ticket-body">
        <div className="ticket-scroll">
          {!canEdit && (
            <p className="ticket-notice">
              {t(archived ? "readOnly.archived" : "readOnly.reader")}
            </p>
          )}
          {removal.error && <p role="alert" className="ticket-error">{describeError(removal.error, "remove")}</p>}
          <TitleField ref={title} client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
          <dl className="ticket-fields">
            <div className="ticket-row">
              <dt>{t("fields.status")}</dt>
              <dd>
                {canEdit ? <StatusField client={client} detail={detail} openItems={openItems} onSaved={refresh} /> : readOnlyStatus}
              </dd>
            </div>
            {detail.progress && (
              <div className="ticket-row">
                <dt>{t("fields.progress")}</dt>
                <dd>
                  <span className="ticket-value">
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
              <dt>{t("fields.parent")}</dt>
              <dd>
                <ParentField client={client} detail={detail} parent={parent} tickets={list} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
              </dd>
            </div>
          </dl>
          <DescriptionField client={client} detail={detail} canEdit={canEdit} assistant={assistantEnabled(me)} tickets={list} onOpenTicket={onOpenTicket} onSaved={refresh} />

          {detail.mentionedBy.length > 0 && (
            <section className="ticket-section" aria-labelledby="ticket-mentioned-by-heading">
              <div className="ticket-section-head">
                <h2 id="ticket-mentioned-by-heading">{t("mentionedBy.heading")}</h2>
              </div>
              <ul className="ticket-children" aria-labelledby="ticket-mentioned-by-heading">
                {detail.mentionedBy.map((from) => (
                  <li key={from.id}>
                    <button type="button" className="ticket-child" onClick={() => onOpenTicket(from.id)}>
                      <span className="ticket-child-main">
                        <TicketMark ticket={{ status: from.status, progress: null }} />
                        <span className="ticket-key">{from.key}</span>
                        <span className="ticket-child-title">{from.title}</span>
                      </span>
                      <span className="ticket-child-state">{statusText(tMap, from.status)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {children.length > 0 && assistantEnabled(me) && <ItemsSummary client={client} ticketId={detail.id} canEdit={canEdit} />}

          <section className="ticket-section" aria-labelledby="ticket-children-heading">
            <div className="ticket-section-head">
              <h2 id="ticket-children-heading">{t("items.heading")}</h2>
              {canEdit && (
                <span className="ticket-section-actions">
                  <button type="button" className="text" onClick={() => onStartCreate({ projectId: detail.projectId, parentId: detail.id, parent: { key: detail.key, status: detail.status } })}>
                    {t("items.newHere")}
                  </button>
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
                        <TicketMark ticket={child} />
                        <span className="ticket-key">{child.key}</span>
                        <span className="ticket-child-title">{child.title}</span>
                      </span>
                      <span className="ticket-child-state">{ticketStateText(tMap, child)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {githubEnabled(me) && <TicketCode client={client} detail={detail} project={project} />}
        </div>
      </div>
    </>
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
