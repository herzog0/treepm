import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person, Project, TicketDetail, TicketStatus, TicketSummary } from "../api/client.js";
import { assistantEnabled, githubEnabled } from "../api/client.js";
import { TicketCode } from "../github/TicketCode.js";
import { useApiResource } from "../api/useApiResource.js";
import { canCreateTickets, canRemoveTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { TicketMark, progressText, ticketStateText, useStatusText } from "../map/nodeContent.js";
import { StatusMark } from "../map/StatusMark.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { CreateTicket } from "./CreateTicket.js";
import { ItemsSummary } from "./ItemsSummary.js";
import { DescriptionField, ParentField, PeopleField, StatusField, TitleField } from "./fields.js";
import { ancestorsOf } from "./tree.js";
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
  onStartCreate: (request: CreateRequest) => void;
  onCancelCreate: () => void;
  onCreated: (ticketId: string) => void;
}

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m3 3 8 8M11 3l-8 8" />
  </svg>
);

function Header({ keyText, path, onClose }: { keyText: string; path: string; onClose: () => void }) {
  const { t } = useTranslation("ticket");
  return (
    <header className="ticket-header">
      <div className="ticket-crumbs">
        <span className="ticket-key">{keyText}</span>
        {path !== "" && <span aria-hidden="true">·</span>}
        {path !== "" && <span className="ticket-path">{path}</span>}
      </div>
      <button type="button" className="ticket-close" aria-label={t("page.close")} onClick={onClose}>
        <CloseIcon />
      </button>
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
          <Header keyText={createProject?.key ?? ""} path={createProject?.name ?? ""} onClose={onClose} />
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
        <Header keyText="" path="" onClose={onClose} />
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
  const { client, detail, onClose } = props;
  const tickets = useApiResource(() => safe(() => client.listTickets(detail.projectId)));
  const people = useApiResource(() => safe(() => client.listPeople()));

  if (tickets.state.status === "error") return <PageError onClose={onClose} error={tickets.state.error} onRetry={tickets.retry} />;
  if (people.state.status === "error") return <PageError onClose={onClose} error={people.state.error} onRetry={people.retry} />;
  if (tickets.state.status !== "ready" || people.state.status !== "ready") {
    return (
      <>
        <Header keyText={detail.key} path="" onClose={onClose} />
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

function ReadyTicket({ client, me, projects, detail, list, people, reloadDetail, reloadList, onOpenTicket, onClose, onChanged, onRemoved, onStartCreate }: ReadyProps) {
  const { t } = useTranslation("ticket");
  const { t: tMap } = useTranslation("map");
  const statusText = useStatusText();
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

  return (
    <>
      <Header keyText={detail.key} path={path} onClose={onClose} />
      <div className="ticket-body">
        <div className="ticket-scroll">
          {!canEdit && (
            <p className="ticket-notice">
              {t(archived ? "readOnly.archived" : "readOnly.reader")}
            </p>
          )}
          <TitleField ref={title} client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
          <dl className="ticket-fields">
            <dt>{t("fields.status")}</dt>
            <dd>
              {canEdit ? (
                <StatusField client={client} detail={detail} openItems={openItems} onSaved={refresh} />
              ) : (
                <span className="ticket-chip">
                  <StatusMark status={detail.status} />
                  {statusText(detail.status)}
                </span>
              )}
            </dd>
            {detail.progress && (
              <>
                <dt>{t("fields.progress")}</dt>
                <dd>
                  <span className="ticket-chip">
                    <StatusMark progress={detail.progress} />
                    {progressText(tMap, detail.progress)}
                  </span>
                </dd>
              </>
            )}
            <dt>{t("fields.people")}</dt>
            <dd>
              <PeopleField client={client} detail={detail} people={people} canEdit={canEdit} onSaved={refresh} />
            </dd>
            <dt>{t("fields.parent")}</dt>
            <dd>
              <ParentField client={client} detail={detail} parent={parent} tickets={list} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
            </dd>
          </dl>
          <DescriptionField client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />

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

          {canRemove && (
            <div className="ticket-danger">
              <ConfirmAction label={t("remove.label")} disabled={removal.busy} onConfirm={() => void remove()} />
              {removal.error && <p role="alert">{describeError(removal.error, "remove")}</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function PageError({ error, onRetry, onClose }: { error: Parameters<typeof LoadError>[0]["error"]; onRetry: () => void; onClose: () => void }) {
  return (
    <>
      <Header keyText="" path="" onClose={onClose} />
      <div className="ticket-body">
        <div className="ticket-scroll"><LoadError error={error} onRetry={onRetry} /></div>
      </div>
    </>
  );
}
