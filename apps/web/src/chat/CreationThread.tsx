import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationDetail, ConversationInfo, PlacementDecision, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { Chat } from "../assistant/CreationChat.js";
import { CreatedNotice } from "../assistant/Elaboration.js";
import { outcomeFromDecision } from "../assistant/restoredOutcome.js";
import { RecentPlacesProvider } from "../assistant/RecentPlacesContext.js";
import { createRecentPlaces } from "../assistant/recentPlaces.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useDescribeApiError } from "../api/errorText.js";
import { LoadError } from "../LoadError.js";
import { useChats } from "./ChatsContext.js";

const NO_TICKETS: Readonly<Record<string, readonly TicketSummary[]>> = {};
const noop = () => undefined;

/** O selo do estado da thread de criação (barra lateral e cabeçalho): a mesma frase em todo lugar. */
export function CreationStateBadge({ state }: { state: "draft" | "waiting" | "created" | "discarded" }) {
  const { t } = useTranslation("chat");
  return <span className={`creation-badge is-${state}`}>{t(`creation.state.${state}`)}</span>;
}

/**
 * A thread de criação de ticket aberta na coluna da conversa (ADR 0056, item 5): no lugar das mensagens comuns, a conversa de novo ticket
 * que já existia (o `Chat` do assistente), pelas mesmas rotas. Só a dona a lê; o que vem do servidor decide o estado.
 */
export function CreationThread({ info, hasTicket }: { info: ConversationInfo; hasTicket: boolean }) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const { client, directory, mapHost } = chats;
  const creation = info.creation;
  const [choosing, setChoosing] = useState(false);
  const [pickNotice, setPickNotice] = useState("");
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [chipSlot, setChipSlot] = useState<HTMLElement | null>(null);
  // O ticket aberto no mapa quando a thread abriu: a procura do lugar começa dentro dele (ADR 0031, ADR 0034). Vive só nesta tela.
  const [scopeId, setScopeId] = useState<string | null>(() => mapHost?.scopeTicketId() ?? null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const describe = useDescribeApiError();
  // Com a coluna fechada (ela fica montada, escondida) o mapa não pode seguir à espera de um clique para esta thread.
  const columnOpen = chats.open;
  useEffect(() => {
    if (!columnOpen) setChoosing(false);
  }, [columnOpen]);
  const parent = info.trail.at(-1) ?? null;
  const goUp = () => {
    void chats.refresh();
    if (parent !== null) chats.select({ kind: "conversation", id: parent.id });
    else chats.close();
  };

  const projects: readonly Project[] = directory.status === "ready" ? directory.projects : [];
  const project = creation?.projectId == null ? null : (projects.find((entry) => entry.id === creation.projectId) ?? mapHost?.creatable.find((entry) => entry.id === creation.projectId) ?? null);
  const tickets = chats.tickets.status === "ready" ? chats.tickets.byProject : NO_TICKETS;
  const { loadTickets } = chats;
  useEffect(() => {
    if (projects.length > 0) void loadTickets(projects, "stale");
  }, [projects.length, loadTickets]);
  const recents = useMemo(() => (directory.status === "ready" ? createRecentPlaces(directory.me.organization.orgId, directory.me.person.id) : undefined), [directory]);

  const scopeTicket = project === null || scopeId === null ? undefined : (tickets[project.id] ?? []).find((entry) => entry.id === scopeId);
  const scope = scopeTicket ? { id: scopeTicket.id, key: scopeTicket.key, title: scopeTicket.title } : null;
  const conversationId = creation?.ticketConversationId ?? null;
  const memory = chats.creationMemory.read(info.id);
  /**
   * O ticket foi criado: com esta thread ainda na frente, a coluna vai à conversa dele e a página abre; se a pessoa foi para outra conversa
   * durante a espera, nada a puxa de volta: a barra só marca o ticket como "novo" (e já foi atualizada).
   */
  const openCreated = (ticketId: string) => {
    const now = chats.selectionNow();
    if (now?.kind === "conversation" && now.id === info.id) {
      chats.select({ kind: "ticket", ticketId });
      chats.showTicket(ticketId);
    } else {
      chats.markNewTicket(ticketId);
    }
  };
  const open = creation !== null && (creation.state === "draft" || creation.state === "waiting");
  const live = open && conversationId !== null;

  // Trocar de projeto = descartar e abrir de novo em outro, com o pedido da pessoa (a abertura da thread é o texto dela).
  const otherProjects = (mapHost?.creatable ?? []).filter((entry) => entry.id !== creation?.projectId);
  const canChangeProject = live && !hasTicket && otherProjects.length > 0 && info.opening !== null;
  const changeProject = async (projectId: string) => {
    if (conversationId === null || parent === null || info.opening === null) return;
    setChangeError(null);
    const removed = await safe(() => client.removeConversation(conversationId));
    if (!removed.ok) return setChangeError(describe(removed.error));
    const sent = await safe(() => client.sendChatMessage(parent.id, { body: info.opening!.body, creation: true, projectId }));
    void chats.refresh();
    if (!sent.ok) {
      // O rascunho já foi descartado e esta tela sobe para a conversa de cima: o pedido volta ao campo dela, em modo "novo ticket", com o erro.
      chats.stashHandoff({ kind: "conversation", id: parent.id }, { text: info.opening.body, mentions: [], error: describe(sent.error), creation: true, ...(sent.error.code ? { code: sent.error.code } : {}) });
      chats.setCreationMode(true);
      return goUp();
    }
    if (sent.data.kind === "creation") chats.select({ kind: "conversation", id: sent.data.thread.id });
    else goUp();
  };

  if (creation === null) return null;
  return (
    <div className="creation-thread">
      <div className="creation-head">
        <p className="creation-meta">
          <CreationStateBadge state={creation.state} />
          {creation.projectKey !== null && <code>{t("creation.project", { key: creation.projectKey })}</code>}
        </p>
        <p className="chat-notice">{t("creation.private")}</p>
        {creation.openedBy === "assistant" && <p className="chat-notice">{t("creation.openedByAssistant")}</p>}
        <span ref={setChipSlot} className="assistant-chip-slot" />
        <div ref={setActionsSlot} className="assistant-header-actions creation-actions" hidden={!live} />
        {canChangeProject && (
          <div className="creation-change">
            <span>{t("creation.changeProject")}</span>
            {otherProjects.map((entry) => (
              <ConfirmAction key={entry.id} label={t("creation.changeProjectTo", { key: entry.key })} message={t("creation.changeProjectConfirm")} tone="neutral" onConfirm={() => void changeProject(entry.id)} />
            ))}
          </div>
        )}
        {changeError !== null && <p role="alert" className="chat-alert">{changeError}</p>}
      </div>
      {creation.state === "created" && (
        <div className="creation-done">
          <p>{creation.ticket === null ? t("creation.state.created") : t("creation.createdBody", { key: creation.ticket.key, title: creation.ticket.title })}</p>
          {creation.ticket !== null && <button type="button" onClick={() => chats.openTicket(creation.ticket!.id)}>{t("creation.openTicketChat")}</button>}
        </div>
      )}
      {creation.state === "created" && memory?.notice !== undefined && <CreatedNotice notice={memory.notice} onOpen={() => openCreated(memory.notice!.ticketId)} />}
      {creation.state === "discarded" && <p className="creation-done">{t("creation.discardedBody")}</p>}
      {/* Sem o elo para a conversa de novo ticket, o servidor está dizendo que a pessoa já não enxerga o projeto. */}
      {open && (conversationId === null || (project === null && directory.status === "ready")) && <p role="status" className="chat-alert">{t("creation.noAccess")}</p>}
      {live && project !== null && (
        <>
          {choosing && <PickBar notice={pickNotice} onCancel={() => setChoosing(false)} />}
          <section className="assistant-body creation-body" aria-label={t("creation.cardTitle")} hidden={choosing}>
            <WithDetail key={conversationId} id={conversationId!} ready={tickets[project.id] !== undefined || chats.tickets.status === "error"}>
              {(detail, decision) => (
              <RecentPlacesProvider value={recents ?? createRecentPlaces("", "")}>
                <Chat
                  initial={detail}
                  client={client}
                  projects={mapHost?.creatable ?? [project]}
                  project={project}
                  tickets={tickets}
                  onCreated={(ticketId) => {
                    mapHost?.onChanged();
                    openCreated(ticketId);
                  }}
                  memory={memory?.screen}
                  onRemember={(screen) => chats.creationMemory.write(info.id, { screen })}
                  onNotice={(notice) => chats.creationMemory.write(info.id, { notice })}
                  initialOutcome={outcomeFromDecision(decision, tickets[project.id] ?? [], project)}
                  onOpenExisting={chats.showTicket}
                  onManualCreate={mapHost?.onManualCreate ?? noop}
                  canManualCreate={mapHost !== null}
                  onDraftChange={mapHost?.onDraftChange ?? noop}
                  onChanged={() => {
                    mapHost?.onChanged();
                    void chats.refresh();
                  }}
                  registerPicker={mapHost?.registerPicker ?? noop}
                  canPickOnMap={mapHost !== null}
                  choosing={choosing}
                  setChoosing={setChoosing}
                  pickNotice={pickNotice}
                  setPickNotice={setPickNotice}
                  scope={scope}
                  onRemoveScope={() => setScopeId(null)}
                  chipSlot={chipSlot}
                  actionsSlot={actionsSlot}
                  onRemoved={goUp}
                  onActivity={() => void chats.refresh()}
                />
              </RecentPlacesProvider>
              )}
            </WithDetail>
          </section>
        </>
      )}
    </div>
  );
}

/** Lê a conversa de novo ticket da thread; o texto de carregando e de falha são os da thread. */
function WithDetail({ id, ready, children }: { id: string; ready: boolean; children: (detail: ConversationDetail, decision: PlacementDecision | null) => ReactNode }) {
  const { t } = useTranslation("chat");
  const { client } = useChats()!;
  // A decisão guardada da última procura remonta a pergunta aberta; sem ela (falha, nunca houve procura) a tela abre limpa.
  const loaded = useApiResource(async () => {
    const [detail, decision] = await Promise.all([safe(() => client.getConversation(id)), safe(() => client.getPlacementDecision(id))]);
    return detail.ok ? { ok: true as const, data: { detail: detail.data, decision: decision.ok ? decision.data.decision : null } } : detail;
  });
  if (loaded.state.status === "loading" || !ready) return <p role="status" className="chat-hint">{t("creation.loading")}</p>;
  if (loaded.state.status === "error") return <LoadError error={loaded.state.error} onRetry={loaded.retry} />;
  return <>{children(loaded.state.data.detail, loaded.state.data.decision)}</>;
}

/** A faixa de "escolher no mapa": a instrução, a recusa quando o clique não vale e o botão de cancelar. */
export function PickBar({ notice, onCancel }: { notice: string; onCancel: () => void }) {
  const { t } = useTranslation("assistant");
  return (
    <div className="assistant-top assistant-pick" data-creation-pick="">
      <div className="assistant-pick-text">
        <p role="status">{t("pick.instruction")}</p>
        {notice !== "" && <p role="alert">{notice}</p>}
      </div>
      <button type="button" className="text" onClick={onCancel}>{t("pick.cancel")}</button>
    </div>
  );
}

/** O cartão da thread de criação na conversa de cima (a mensagem que a abriu): estado, e o ticket quando já foi criado. */
export function CreationCard({ title, creation, onOpen }: { title: string | null; creation: NonNullable<ConversationInfo["creation"]>; onOpen: () => void }) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const { state, ticket } = creation;
  const name = ticket !== null ? t("creation.cardCreated", { key: ticket.key, title: ticket.title }) : title?.trim() || t("creation.cardTitle");
  const inner = (
    <>
      <span className="creation-mark" aria-hidden="true">+</span>
      <span className="creation-title">{name}</span>
      <CreationStateBadge state={state} />
    </>
  );
  if (state === "discarded") return <div className="creation-card is-discarded">{inner}</div>;
  if (state === "created" && ticket !== null) {
    return (
      <button type="button" className="creation-card is-created" aria-label={t("creation.cardOpenTicket", { key: ticket.key })} onClick={() => chats.openTicket(ticket.id)}>
        {inner}
      </button>
    );
  }
  return <button type="button" className="creation-card" onClick={onOpen}>{inner}</button>;
}
