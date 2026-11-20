import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { ApiClient, Me, Person, Project, TicketDetail, TicketKind, TicketSummary } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { canCreateTickets, canRemoveTickets } from "../import/permissions.js";
import { LoadError } from "../LoadError.js";
import { TicketMark, describeTicketState } from "../map/nodeContent.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { CreateTicket } from "./CreateTicket.js";
import { DescriptionField, ParentField, PeopleField, StatusField, TitleField } from "./fields.js";
import { ancestorsOf } from "./tree.js";
import "./ticket.css";

export interface CreateRequest {
  projectId: string;
  parentId: string | null;
  /** Tipo do nó novo (ADR 0031); sem ele, ticket. */
  kind?: TicketKind;
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

function Header({ keyText, path, onClose, kind }: { keyText: string; path: string; onClose: () => void; kind?: TicketKind }) {
  return (
    <header className="ticket-header">
      <div className="ticket-crumbs">
        <span className="ticket-key">{keyText}</span>
        {kind === "group" && <span className="ticket-kind">Agrupador</span>}
        {path !== "" && <span aria-hidden="true">·</span>}
        {path !== "" && <span className="ticket-path">{path}</span>}
      </div>
      <button type="button" className="ticket-close" aria-label="Fechar e voltar ao mapa" onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  );
}

/** Página do ticket (ADR 0026): região complementar à direita do mapa, de leitura e edição. */
export function TicketPage(props: TicketPageProps) {
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
    <aside ref={ref} className="ticket-page" aria-label="Página do ticket" tabIndex={-1} onKeyDown={onKeyDown}>
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
  const { client, ticketId, onClose } = props;
  const detail = useApiResource(() => safe(() => client.getTicket(ticketId)));

  if (detail.state.status !== "ready") {
    return (
      <>
        <Header keyText="" path="" onClose={onClose} />
        <div className="ticket-body">
          <div className="ticket-scroll">
            {detail.state.status === "loading" && <p role="status">Carregando ticket…</p>}
            {detail.state.status === "error" &&
              (detail.state.error.kind === "not_found" ? (
                <p role="alert">{describeApiError(detail.state.error)}</p>
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
          <div className="ticket-scroll"><p role="status">Carregando ticket…</p></div>
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

  const isGroup = detail.kind === "group";
  const children = list.filter((entry) => entry.parentId === detail.id);
  const kindChange = useAction();
  const parent = detail.parentId === null ? null : list.find((entry) => entry.id === detail.parentId) ?? null;
  const path = [project?.name ?? "", ...ancestorsOf(list, detail).map((entry) => entry.title)].filter((part) => part !== "").join(" › ");

  const changeKind = async (kind: TicketKind) => {
    const result = await kindChange.run(() => client.updateTicket(detail.id, { kind }));
    if (result.ok) refresh();
  };

  const remove = async () => {
    const result = await removal.run(() => client.removeTicket(detail.id));
    if (!result.ok) return;
    onChanged();
    onRemoved();
  };

  return (
    <>
      <Header keyText={detail.key} path={path} onClose={onClose} kind={detail.kind} />
      <div className="ticket-body">
        <div className="ticket-scroll">
          {!canEdit && (
            <p className="ticket-notice">
              {archived ? "O projeto está arquivado: esta página é só de leitura." : "Você tem acesso só de leitura a este projeto."}
            </p>
          )}
          <TitleField ref={title} client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />
          <dl className="ticket-fields">
            <dt>{isGroup ? "Progresso" : "Situação"}</dt>
            <dd>
              {isGroup || !canEdit ? (
                <span className="ticket-chip">
                  <TicketMark ticket={detail} />
                  {describeTicketState(detail, children.length)}
                </span>
              ) : (
                <StatusField client={client} detail={detail} onSaved={refresh} />
              )}
            </dd>
            <dt>Pessoas</dt>
            <dd>
              <PeopleField client={client} detail={detail} people={people} canEdit={canEdit} onSaved={refresh} />
            </dd>
            <dt>Agrupador pai</dt>
            <dd>
              <ParentField client={client} detail={detail} parent={parent} tickets={list} canEdit={canEdit} onOpen={onOpenTicket} onSaved={refresh} />
            </dd>
          </dl>
          <DescriptionField client={client} detail={detail} canEdit={canEdit} onSaved={refresh} />

          {isGroup && (
            <section className="ticket-section" aria-labelledby="ticket-children-heading">
              <div className="ticket-section-head">
                <h2 id="ticket-children-heading">Itens</h2>
                {canEdit && (
                  <span className="ticket-section-actions">
                    <button type="button" className="text" onClick={() => onStartCreate({ projectId: detail.projectId, parentId: detail.id, kind: "ticket" })}>
                      Novo ticket
                    </button>
                    <button type="button" className="text" onClick={() => onStartCreate({ projectId: detail.projectId, parentId: detail.id, kind: "group" })}>
                      Novo agrupador
                    </button>
                  </span>
                )}
              </div>
              {children.length === 0 ? (
                <p className="ticket-muted">Nenhum item ainda.</p>
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
                        <span className="ticket-child-state">{describeTicketState(child, list.filter((entry) => entry.parentId === child.id).length)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {canEdit && (isGroup ? children.length === 0 : true) && (
            <div className="ticket-kind-change">
              <button type="button" disabled={kindChange.busy} onClick={() => void changeKind(isGroup ? "ticket" : "group")}>
                {isGroup ? "Transformar em ticket" : "Transformar em agrupador"}
              </button>
              {kindChange.error && <p role="alert" className="ticket-error">{describeApiError(kindChange.error)}</p>}
            </div>
          )}

          {canRemove && (
            <div className="ticket-danger">
              <ConfirmAction label={isGroup ? "Remover agrupador" : "Remover ticket"} disabled={removal.busy} onConfirm={() => void remove()} />
              {removal.error && <p role="alert">{describeApiError(removal.error, "remove")}</p>}
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
