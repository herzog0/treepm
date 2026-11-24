import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { ApiResult, ChatMessage, ConversationNode, ConversationView as ConversationData, ThreadCard, TicketSummary } from "../api/client.js";
import { assistantEnabled, assistantNeedsConsent } from "../api/client.js";
import { ConsentRequiredNotice, isConsentRequired } from "../api/ConsentRequired.js";
import { useDescribeApiError } from "../api/errorText.js";
import { Reveal } from "../assistant/Reveal.js";
import { Skeleton } from "../assistant/Skeleton.js";
import { formatActivityTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { ActionsMenu } from "../ticket/menu.js";
import { AddPeople } from "./AddPeople.js";
import type { ConversationRef } from "./ChatsContext.js";
import { useChats } from "./ChatsContext.js";
import { Composer } from "./Composer.js";
import type { Draft } from "./Composer.js";
import { peopleWhoSee } from "./directory.js";
import { AssistantText, Initials, PersonText } from "./MessageText.js";
import { isAtEnd } from "./scroll.js";
import { threadColor, threadTitle } from "./thread.js";
import { TicketTopic } from "./TicketTopic.js";
import type { Topic } from "./TicketTopic.js";

const PAGE = 30;
/** Códigos em que a mensagem não foi guardada e a pessoa precisa dela de volta no campo (não é uma "não respondida" para repetir). */
const KEEP_TEXT = new Set(["chat_busy", "chat_changed", "chat_rate_limited", "chat_thread_rate_limited", "project_archived", "validation_error", "invalid_cursor", "not_found", "max_depth", "thread_full", "mention_not_allowed", "participant_cannot_view_ticket", "too_many_mentions", "cannot_mention_self", "ticket_mismatch"]);
/** O que se lê de um chat geral que a pessoa ainda não abriu: nada, e nenhuma requisição. */
const EMPTY: ConversationData = { conversation: null, ticket: null, assignedToMe: false, lastRead: null, unread: 0, messages: { items: [], nextBefore: null }, threads: [] };

interface Pending {
  id: number;
  body: string;
  status: "sending" | "failed";
  error: string | null;
}

/**
 * O cartão de uma thread. Os que vêm da leitura da conversa trazem a abertura e as respostas; o de uma thread debaixo de um chat geral
 * que ainda não existe vem só da árvore da barra (sem abertura nem contagem de respostas).
 */
type Card = Omit<ThreadCard, "opening" | "replyCount"> & { opening: ThreadCard["opening"] | null; replyCount: number | null };
/** Uma entrada do fluxo: uma mensagem (com o cartão da thread que ela abriu, se abriu) ou o cartão de uma thread cuja abertura não está na janela carregada. */
type Entry = { kind: "message"; message: ChatMessage } | { kind: "card"; card: Card };
const timeOf = (entry: Entry) => (entry.kind === "message" ? entry.message.createdAt : (entry.card.opening?.createdAt ?? entry.card.lastActivityAt));
const cardOfNode = (node: ConversationNode): Card | null =>
  node.kind === "thread" && node.id !== null
    ? { id: node.id, opening: null, participants: node.participants, participantCount: node.participantCount, replyCount: null, lastActivityAt: node.lastActivityAt ?? "", unread: node.unread, startedByMe: node.ownedByMe }
    : null;

/** Junta duas listas de mensagens sem repetir nenhuma (por id), na ordem em que foram escritas. */
const mergeById = (current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
);
const DotsIcon = () => (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
);

/** O rodapé da mensagem que abriu uma thread: quem participa, respostas, não lidas e a última atividade. Clicar abre a thread no mesmo painel. */
function ThreadFooter({ card, selfId, onOpen }: { card: Card; selfId: string | undefined; onOpen: () => void }) {
  const { t, i18n } = useTranslation("chat");
  const shown = card.participants.slice(0, 3);
  return (
    <button type="button" className="chat-thread-footer" onClick={onOpen}>
      <span className="chat-avatars" aria-hidden="true">
        {shown.map((person) => <Initials key={person.id} name={person.displayName} />)}
      </span>
      <span className="chat-thread-name">{threadTitle(t, card.participants, card.participantCount, selfId)}</span>
      {card.replyCount !== null && <span>{t("thread.replies", { count: card.replyCount })}</span>}
      {card.unread > 0 && <span className="chat-badge">{t("thread.unread", { count: card.unread })}</span>}
      {card.lastActivityAt !== "" && <time dateTime={card.lastActivityAt}>{formatActivityTime(i18n.language as Language, card.lastActivityAt, new Date())}</time>}
    </button>
  );
}

interface ConversationViewProps {
  target: ConversationRef;
  /** O painel está à vista; escondido, a conversa não pede nada à API nem marca nada como lido. */
  active: boolean;
}

/** A conversa aberta (ADR 0055): a principal de um ticket, o chat geral ou uma thread, sempre no mesmo painel. */
export function ConversationView({ target, active }: ConversationViewProps) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const { client, directory, version, selfId } = chats;
  const describe = useDescribeApiError();
  const [view, setView] = useState<ConversationData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** A conversa não existe mais (404): sem "tentar de novo", e a barra se atualiza. */
  const [gone, setGone] = useState(false);
  const [draft, setDraft] = useState<Draft>({ text: "", mentions: [] });
  const [topic, setTopic] = useState<Topic | null>(null);
  const [topicTickets, setTopicTickets] = useState<Record<string, readonly TicketSummary[]> | null>(null);
  const [topicFailed, setTopicFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [off, setOff] = useState<"consent" | "provider" | null>(null);
  const [threadSending, setThreadSending] = useState(false);
  const scroller = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const marked = useRef<string | null>(null);
  const nextId = useRef(0);
  const alive = useRef(true);
  const keepScroll = useRef<number | null>(null);
  const focused = useRef(false);
  /** Só a resposta da requisição mais nova vale: uma que chega atrasada não sobrescreve a atual. */
  const loadSeq = useRef(0);
  const olderRef = useRef<string | null>(null);
  const olderBusy = useRef(false);
  /** A conversa sumiu (404): é definitivo para esta tela. Sem ele, o 404 atualizaria a lista, a lista pediria nova leitura e o laço não pararia. */
  const goneRef = useRef(false);
  const shownCount = useRef(0);
  const creating = useRef<Promise<ApiResult<string>> | null>(null);
  /** A conversa em que se escreve: a do alvo, a que a leitura devolveu ou a que o primeiro envio criou (criada uma vez só). */
  const conversationId = useRef<string | null>(target.kind === "conversation" ? target.id : null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => chats.loadDirectory(), [chats.loadDirectory]);

  const fetchView = useCallback(
    (query: { limit?: number; before?: string }): Promise<ApiResult<ConversationData>> => {
      if (target.kind === "ticket") return client.getTicketConversationView(target.ticketId, query);
      if (target.kind === "conversation") return client.getConversationView(target.id, query);
      // O chat geral que ainda não existe: a leitura não cria nada e não pede nada.
      return conversationId.current === null ? Promise.resolve({ ok: true, data: EMPTY }) : client.getConversationView(conversationId.current, query);
    },
    [client, target],
  );

  /** Traz a página mais nova. `replace` troca tudo (a conversa mudou em outro aparelho); sem ele, junta ao que já está (a atualização automática). */
  const load = useCallback(async (mode: "first" | "merge" | "replace") => {
    if (goneRef.current) return;
    const seq = ++loadSeq.current;
    const result = await safe(() => fetchView({ limit: PAGE }));
    if (!alive.current || seq !== loadSeq.current) return;
    if (!result.ok) {
      if (result.error.kind === "not_found") {
        goneRef.current = true;
        setGone(true);
        void chats.refresh();
      } else if (mode === "first") {
        setLoadFailed(true);
      }
      return;
    }
    const data = result.data;
    if (data.conversation) conversationId.current = data.conversation.id;
    // A mensagem que abriu a thread fica fixa no alto (`conversation.opening`); ela não entra na lista.
    const page = [...data.messages.items].reverse().filter((message) => message.id !== data.conversation?.openingMessageId);
    setLoadFailed(false);
    setView(data);
    // A atualização junta a página mais nova ao que já está; a posição das páginas anteriores só muda quando ainda não havia nada.
    const adopt = mode !== "merge" || shownCount.current === 0;
    setMessages((current) => {
      if (mode !== "merge" || current.length === 0) return page;
      return mergeById(current, page);
    });
    if (adopt) {
      olderRef.current = data.messages.nextBefore;
      setOlder(data.messages.nextBefore);
    }
  }, [fetchView, chats.refresh]);

  useEffect(() => void load("first"), [load]);
  // O painel volta a ficar à vista, ou a lista se atualizou: a conversa aberta acompanha.
  const seen = useRef(version);
  useEffect(() => {
    if (!active || view === null || seen.current === version) return;
    seen.current = version;
    void load("merge");
  }, [active, version, view, load]);
  useEffect(() => {
    if (active && view !== null) void load("merge");
  }, [active]);

  shownCount.current = messages.length;
  const me = directory.status === "ready" ? directory.me : null;
  const info = view?.conversation ?? null;
  const ticket = view?.ticket ?? null;
  const kind = info?.kind ?? (target.kind === "general" ? "general" : "ticket");
  const isThread = kind === "thread";
  const hasTicket = ticket !== null;
  const mentioning = draft.mentions.length > 0;
  const aboutId = hasTicket ? ticket.projectId : topic?.projectId;
  const project = directory.status === "ready" ? directory.projects.find((entry) => entry.id === aboutId) : undefined;
  const candidates = useMemo(
    () => (directory.status === "ready" ? peopleWhoSee(project, directory.people, directory.teams, me?.person.id) : []),
    [directory, project, me],
  );
  const addCandidates = useMemo(() => {
    const inside = new Set(info?.participants.map((person) => person.id));
    return candidates.filter((person) => !inside.has(person.id));
  }, [candidates, info]);
  const names = useMemo(() => new Map(directory.status === "ready" ? directory.people.map((person) => [person.id, person.displayName]) : []), [directory]);
  const peopleStatus = directory.status === "ready" ? "ready" : directory.status === "error" ? "error" : "loading";
  const assistantOff = off ?? (me === null ? null : assistantNeedsConsent(me) ? "consent" : !assistantEnabled(me) ? "provider" : null);
  const archived = ticket?.archived === true;
  // Sem leitura da conversa de cima, a pessoa que entrou numa thread só vê o que veio em `trail`.
  const canOpenThread = info === null || info.canOpenThread;

  // O ticket de que a thread trata (só no chat geral): a lista de tickets carrega quando a pessoa marca alguém pela primeira vez.
  useEffect(() => {
    if (!mentioning || hasTicket || topicTickets !== null || topicFailed || directory.status !== "ready") return;
    void Promise.all(directory.projects.filter((entry) => entry.archivedAt === null).map(async (entry) => [entry.id, await safe(() => client.listTickets(entry.id))] as const)).then((results) => {
      if (!alive.current) return;
      if (results.some(([, result]) => !result.ok)) return setTopicFailed(true);
      setTopicTickets(Object.fromEntries(results.map(([projectId, result]) => [projectId, result.ok ? result.data : []])));
    });
  }, [mentioning, hasTicket, topicTickets, topicFailed, directory, client]);
  useEffect(() => {
    if (!mentioning) setTopic(null);
  }, [mentioning]);

  // O foco entra no campo quando a conversa aparece pela primeira vez com o painel à vista.
  useEffect(() => {
    if (active && view !== null && !focused.current) {
      focused.current = true;
      field.current?.focus();
    }
  }, [active, view]);

  const entries = useMemo<Entry[]>(() => {
    const flow: Entry[] = messages.map((message) => ({ kind: "message", message }));
    const attached = new Set(messages.flatMap((message) => (message.thread ? [message.thread.id] : [])));
    // Threads cuja abertura não aparece entre as mensagens: as em que a pessoa entrou sem ver a conversa de cima (e, com páginas
    // anteriores por buscar, só as mais novas que a janela carregada: as outras esperam pela mensagem delas).
    const start = older !== null ? messages[0]?.createdAt : undefined;
    for (const card of view?.threads ?? []) {
      if (attached.has(card.id) || card.opening.id === info?.openingMessageId) continue;
      if (start === undefined || card.opening.createdAt >= start) flow.push({ kind: "card", card });
    }
    // O chat geral que ainda não existe não tem leitura: as threads dele vêm da árvore da barra.
    if (target.kind === "general" && info === null) {
      for (const node of chats.tree?.find((entry) => entry.kind === "general")?.children ?? []) {
        const card = cardOfNode(node);
        if (card !== null) flow.push({ kind: "card", card });
      }
    }
    return flow.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  }, [messages, view, older, info, target.kind, chats.tree]);

  const markRead = useCallback(async (upTo: string) => {
    const id = conversationId.current;
    if (id === null) return;
    const result = await safe(() => client.markConversationRead(id, { upTo }));
    if (!alive.current) return;
    if (!result.ok) {
      marked.current = null;
      return;
    }
    chats.setConversationUnread(id, result.data.unread);
    setView((current) => (current === null ? current : { ...current, unread: result.data.unread, lastRead: result.data.lastRead }));
  }, [client, chats.setConversationUnread]);

  // "Lido até onde a pessoa viu": só com o fim da lista à vista, e até a mensagem mais nova mostrada.
  const newest = messages.at(-1) ?? (info?.opening ?? null);
  const hasUnseen = view !== null && (view.unread > 0 || messages.some((message) => message.unread));
  const markIfSeen = useCallback(() => {
    const element = scroller.current;
    if (!active || info === null || !newest || !hasUnseen || !element || !isAtEnd(element)) return;
    if (marked.current === newest.cursor) return;
    marked.current = newest.cursor;
    void markRead(newest.cursor);
  }, [active, info, newest, hasUnseen, markRead]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && keepScroll.current !== null) {
      element.scrollTop = element.scrollHeight - keepScroll.current;
      keepScroll.current = null;
    } else if (element) {
      element.scrollTop = element.scrollHeight;
    }
    markIfSeen();
  }, [entries.length, pending, markIfSeen]);

  const loadOlder = async () => {
    const before = olderRef.current;
    // O `onScroll` dispara várias vezes: uma página anterior por vez.
    if (before === null || olderBusy.current) return;
    olderBusy.current = true;
    const element = scroller.current;
    const result = await safe(() => fetchView({ limit: PAGE, before }));
    olderBusy.current = false;
    if (!alive.current || !result.ok) return;
    if (element) keepScroll.current = element.scrollHeight - element.scrollTop;
    const page = [...result.data.messages.items].reverse().filter((message) => message.id !== info?.openingMessageId);
    setMessages((current) => {
      const known = new Set(current.map((message) => message.id));
      return [...page.filter((message) => !known.has(message.id)), ...current];
    });
    olderRef.current = result.data.messages.nextBefore;
    setOlder(result.data.messages.nextBefore);
  };
  const onScroll = () => {
    const element = scroller.current;
    if (element && element.scrollTop < 40 && older !== null) void loadOlder();
    markIfSeen();
  };

  const resetDraft = () => setDraft({ text: "", mentions: [] });

  /** A conversa em que se escreve; a principal e o chat geral nascem aqui, no primeiro envio, e só uma vez. */
  const ensureConversation = (): Promise<ApiResult<string>> => {
    if (conversationId.current !== null) return Promise.resolve({ ok: true, data: conversationId.current });
    // Dois envios seguidos esperam o mesmo POST: a conversa é criada uma vez só (e, se o POST falhar, o próximo envio tenta de novo).
    creating.current ??= (async (): Promise<ApiResult<string>> => {
      const opened = target.kind === "ticket" ? await client.openTicketConversation(target.ticketId) : await client.openGeneralConversation();
      creating.current = null;
      if (!opened.ok) return opened;
      conversationId.current = opened.data.id;
      return { ok: true, data: opened.data.id };
    })();
    return creating.current;
  };

  /** A conversa nasceu neste envio mas a mensagem não passou: a barra mostra a conversa nova e a tela passa a ler por ela. */
  const afterFailedFirstSend = (wasNew: boolean) => {
    if (wasNew && conversationId.current !== null) afterWrite();
  };

  const afterWrite = () => {
    void chats.refresh();
    // A leitura que ainda não tinha conversa passa a ter: traz o que faltava (`canOpenThread`, participantes).
    if (view?.conversation === null) void load("merge");
  };

  const sendToAssistant = async (body: string) => {
    const id = nextId.current++;
    setError(null);
    setPending({ id, body, status: "sending", error: null });
    const wasNew = conversationId.current === null;
    const created = await safe(ensureConversation);
    const result = !created.ok ? created : await safe(() => client.sendChatMessage(created.data, { body }, { signal: new AbortController().signal }));
    if (!alive.current) return;
    if (result.ok && result.data.kind === "assistant") {
      const { message, reply } = result.data;
      setPending(null);
      setMessages((current) => [...current, message, reply]);
      setRevealingId(reply.id);
      setAnnouncement(reply.body);
      afterWrite();
      return;
    }
    if (result.ok) return setPending(null);
    afterFailedFirstSend(wasNew);
    const code = result.error.code;
    setAnnouncement("");
    if (isConsentRequired(result.error) || code === "assistant_not_configured") {
      setPending(null);
      setOff(code === "assistant_not_configured" ? "provider" : "consent");
      setDraft((current) => (current.text === "" ? { ...current, text: body } : current));
      return;
    }
    if (code !== undefined && KEEP_TEXT.has(code)) {
      setPending(null);
      setDraft((current) => (current.text === "" ? { ...current, text: body } : current));
      setError(describe(result.error));
      if (code === "chat_busy" || code === "chat_changed") await load("replace");
      return;
    }
    // Falha do provedor ou da rede: a API não guardou a mensagem; ela fica "não respondida", com "Tentar de novo".
    const message = describe(result.error);
    setPending({ id, body, status: "failed", error: message });
    setError(message);
  };

  /** Mensagem sem o assistente: marcar alguém abre uma thread aqui dentro; sem marcar, é a resposta numa thread. */
  const sendBetweenPeople = async ({ text, mentions }: Draft) => {
    setThreadSending(true);
    setError(null);
    setRefused([]);
    const wasNew = conversationId.current === null;
    const created = await safe(ensureConversation);
    const aboutTicket = mentions.length > 0 && !hasTicket && topic !== null ? { ticketId: topic.id } : {};
    const result = !created.ok ? created : await safe(() => client.sendChatMessage(created.data, { body: text, ...(mentions.length > 0 ? { mentions } : {}), ...aboutTicket }, { signal: new AbortController().signal }));
    if (!alive.current) return;
    setThreadSending(false);
    if (!result.ok) {
      afterFailedFirstSend(wasNew);
      setError(describe(result.error));
      const ids = result.error.details?.personIds;
      if (Array.isArray(ids)) setRefused(ids.filter((id): id is string => typeof id === "string"));
      if (result.error.code === "chat_changed") await load("replace");
      return;
    }
    const sent = result.data;
    if (sent.kind === "thread") {
      setMessages((current) => [...current, { ...sent.message, thread: sent.thread }]);
      setView((current) => (current === null ? current : { ...current, threads: [sent.thread, ...current.threads.filter((card) => card.id !== sent.thread.id)] }));
      setAnnouncement(t("thread.opened"));
    } else if (sent.kind === "message") {
      setMessages((current) => [...current, sent.message]);
    }
    resetDraft();
    afterWrite();
  };

  const send = (next: Draft) => {
    if (next.mentions.length > 0 || isThread) return void sendBetweenPeople(next);
    if (pending?.status === "sending") return;
    resetDraft();
    void sendToAssistant(next.text.trim());
  };

  const retry = () => {
    if (pending === null || pending.status !== "failed") return;
    void sendToAssistant(pending.body);
  };

  const clear = async () => {
    const id = conversationId.current;
    if (id === null) return;
    const result = await safe(() => client.clearConversationMessages(id));
    if (!alive.current) return;
    if (!result.ok) return setError(describe(result.error));
    await load("replace");
    setPending(null);
    setAnnouncement(t("chat.cleared"));
  };

  const addPeople = async (personIds: string[]): Promise<string | null> => {
    const id = conversationId.current;
    if (id === null) return null;
    const result = await safe(() => client.addConversationParticipants(id, personIds));
    if (!alive.current) return null;
    if (!result.ok) {
      const refusedIds = result.error.details?.personIds;
      const who = Array.isArray(refusedIds) ? refusedIds.map((personId) => names.get(String(personId)) ?? t("add.unknownPerson")).join(", ") : "";
      return who === "" ? describe(result.error) : `${describe(result.error)} (${who})`;
    }
    setView((current) => (current === null || current.conversation === null ? current : { ...current, conversation: { ...current.conversation, participants: result.data.participants } }));
    setAnnouncement(t("add.done"));
    void chats.refresh();
    return null;
  };

  const openCard = (card: Card) => chats.select({ kind: "conversation", id: card.id });

  const renderMessage = (message: Omit<ChatMessage, "thread">, card: Card | null) => {
    const assistant = message.authorKind === "assistant";
    const mine = !assistant && message.author?.id === selfId;
    const name = assistant ? t("assistant.name") : mine ? t("message.you") : (message.author?.displayName ?? "");
    const style = card ? ({ "--thread-color": threadColor(card.id) } as CSSProperties) : undefined;
    return (
      <li key={message.id} className={`chat-message ${mine ? "is-mine" : ""} ${assistant ? "is-assistant" : ""} ${card ? "has-thread" : ""}`} style={style}>
        {assistant ? <span className="chat-initials is-assistant" aria-hidden="true">✦</span> : <Initials name={message.author?.displayName ?? ""} />}
        <div className="chat-message-main">
          <span className="chat-author">{name}</span>
          {assistant ? (
            <Reveal text={message.body} active={message.id === revealingId} onDone={() => setRevealingId((current) => (current === message.id ? null : current))} onStep={() => { const element = scroller.current; if (element) element.scrollTop = element.scrollHeight; }}>
              {(shown, revealing) => (
                <div className="chat-assistant" aria-hidden={revealing ? true : undefined}>
                  <AssistantText text={shown} />
                </div>
              )}
            </Reveal>
          ) : (
            <PersonText text={message.body} />
          )}
          {card && <ThreadFooter card={card} selfId={selfId} onOpen={() => openCard(card)} />}
        </div>
      </li>
    );
  };

  /** O cartão de uma thread debaixo de um chat geral que ainda não existe: só a barra a conhece, então só há o rodapé. */
  const renderCardOnly = (card: Card) => (
    <li key={card.id} className="chat-message has-thread" style={{ "--thread-color": threadColor(card.id) } as CSSProperties}>
      <div className="chat-message-main">
        <ThreadFooter card={card} selfId={selfId} onOpen={() => openCard(card)} />
      </div>
    </li>
  );

  const currentLabel =
    kind === "thread" ? threadTitle(t, info?.participants ?? [], info?.participants.length ?? 0, selfId) : kind === "general" ? t("row.general") : (ticket?.key ?? "");
  const trailLabel = (item: { kind: "ticket" | "general" | "thread"; label: string | null }) =>
    item.kind === "general" ? t("row.general") : item.kind === "ticket" ? (ticket?.key ?? t("row.main")) : (item.label ?? t("row.thread"));
  const canClear = !isThread && info !== null && info.ownedByMe;

  return (
    <div className="chat-ticket">
      <header className="chat-header">
        {ticket ? (
          <button type="button" className="chat-ticket-title" aria-label={t("chat.openTicket", { key: ticket.key, title: ticket.title })} onClick={() => chats.showTicket(ticket.id)}>
            <code>{ticket.key}</code>
            <span>{ticket.title}</span>
          </button>
        ) : (
          <span className="chat-ticket-title"><span>{kind === "general" || isThread ? t("row.general") : ""}</span></span>
        )}
        {canClear && (
          <ActionsMenu label={t("chat.options")} trigger={<DotsIcon />}>
            {(close) => (
              <ConfirmAction
                label={t("chat.clear")}
                message={t("chat.clearMessage")}
                onConfirm={() => {
                  close();
                  void clear();
                }}
              />
            )}
          </ActionsMenu>
        )}
        <button type="button" className="chat-icon-button" aria-label={t("panel.close")} onClick={chats.close}>
          <CloseIcon />
        </button>
      </header>
      {gone && <p role="alert" className="chat-hint">{t("chat.gone")}</p>}
      {loadFailed && !gone && (
        <div className="chat-hint">
          <p role="alert">{t("chat.loadFailed")}</p>
          <button type="button" onClick={() => { setLoadFailed(false); void load("first"); }}>{t("list.retry")}</button>
        </div>
      )}
      {view === null && !loadFailed && !gone && <p role="status" className="chat-hint">{t("chat.loading")}</p>}
      {view !== null && !gone && (
        <>
          {isThread && info && (
            <div className="chat-context">
              <nav aria-label={t("trail.label")} className="chat-trail">
                <ol>
                  {info.trail.map((item) => (
                    <li key={item.id}>
                      <button type="button" className="chat-text-button" onClick={() => chats.select({ kind: "conversation", id: item.id })}>{trailLabel(item)}</button>
                    </li>
                  ))}
                  <li aria-current="page" style={{ "--thread-color": threadColor(info.id) } as CSSProperties}>{currentLabel}</li>
                </ol>
              </nav>
              <div className="chat-people">
                <ul className="chat-avatars" aria-label={t("people.label")}>
                  {info.participants.slice(0, 5).map((person) => (
                    <li key={person.id} title={person.displayName}>
                      <Initials name={person.displayName} />
                      <span className="chat-visually-hidden">{person.displayName}</span>
                    </li>
                  ))}
                  {info.participants.length > 5 && <li className="chat-avatars-more">{t("people.more", { count: info.participants.length - 5 })}</li>}
                </ul>
                {info.canAddParticipants && !archived && <AddPeople candidates={addCandidates} status={peopleStatus} onAdd={addPeople} />}
              </div>
            </div>
          )}
          {isThread && archived && <p role="status" className="chat-alert">{describe({ kind: "conflict", code: "project_archived" })}</p>}
          {!isThread && (
            <div className="chat-context">
              <p className="chat-notice">{kind === "general" ? t("notice.general") : t("notice.assistant")}</p>
              {assistantOff === "consent" && <ConsentRequiredNotice className="chat-alert" text={t("notice.noConsent")} />}
              {assistantOff === "provider" && <p role="alert" className="chat-alert">{t("notice.noProvider")}</p>}
              {archived && <p role="status" className="chat-alert">{describe({ kind: "conflict", code: "project_archived" })}</p>}
            </div>
          )}
          <ul ref={scroller} className="chat-log" role="log" aria-label={t("log.label")} aria-live="polite" aria-relevant="additions" aria-busy={older !== null && keepScroll.current !== null ? true : undefined} onScroll={onScroll}>
            {older !== null && <li><button type="button" className="chat-text-button" onClick={() => void loadOlder()}>{t("log.older")}</button></li>}
            {isThread && info?.opening && renderMessage(info.opening, null)}
            {!isThread && entries.length === 0 && pending === null && <li className="chat-hint">{t("log.empty")}</li>}
            {entries.map((entry) => (entry.kind === "message" ? renderMessage(entry.message, entry.message.thread) : entry.card.opening ? renderMessage(entry.card.opening, entry.card) : renderCardOnly(entry.card)))}
            {pending !== null && (
              <li className={`chat-message is-mine ${pending.status === "failed" ? "is-unanswered" : ""}`}>
                <Initials name={me?.person.displayName ?? ""} />
                <div className="chat-message-main">
                  <span className="chat-author">{t("message.you")}</span>
                  <PersonText text={pending.body} />
                  {pending.status === "failed" && (
                    <p className="chat-unanswered">
                      <span>{t("assistant.unanswered")}</span>
                      <button type="button" className="chat-text-button" onClick={retry}>{t("assistant.retry")}</button>
                    </p>
                  )}
                </div>
              </li>
            )}
            {pending?.status === "sending" && (
              <li className="chat-waiting">
                <p role="status">{t("assistant.waiting")}</p>
                <Skeleton />
              </li>
            )}
          </ul>
          <div className="chat-visually-hidden" role="status" aria-live="polite" aria-label={t("assistant.reply")}>{announcement}</div>
          {error && <p role="alert" className="chat-composer-alert">{error}</p>}
          <Composer
            label={isThread ? t("thread.reply") : t("composer.label")}
            placeholder={isThread ? t("thread.replyPlaceholder") : assistantOff === null ? t("composer.placeholder") : t("composer.placeholderThreads")}
            draft={draft}
            onDraft={setDraft}
            candidates={candidates}
            peopleStatus={peopleStatus}
            names={names}
            canAssistant={!isThread && assistantOff === null}
            thread={isThread}
            canOpenThread={canOpenThread}
            extra={!hasTicket ? <TicketTopic value={topic} onChange={setTopic} tickets={topicTickets} failed={topicFailed} onRetry={() => setTopicFailed(false)} /> : null}
            assistantBusy={pending?.status === "sending"}
            threadBusy={threadSending}
            readOnly={archived}
            refused={refused}
            fieldRef={field}
            onSend={send}
          />
        </>
      )}
    </div>
  );
}
