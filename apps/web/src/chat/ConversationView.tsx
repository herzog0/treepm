import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { ApiResult, ChatMessage, ConversationNode, ConversationView as ConversationData, Person, ThreadCard, TicketSummary } from "../api/client.js";
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
import { topicLabel, useChats } from "./ChatsContext.js";
import { Composer } from "./Composer.js";
import type { Draft } from "./Composer.js";
import { peopleWhoSee } from "./directory.js";
import { citedTickets, hashedKeys, projectKeyOf, ticketKeyRefs, ticketsByKey, wantsTickets } from "./mentions.js";
import { AssistantText, Initials, PersonText } from "./MessageText.js";
import { isAtEnd } from "./scroll.js";
import { threadColor, threadTitle } from "./thread.js";

const PAGE = 30;
/** Quanto se espera pela lista de tickets e pelo diretório antes de desistir de decidir para onde a mensagem vai. */
const CHECK_MS = 15_000;

/** O resultado da promessa, ou `null` se ela não acabou no prazo. */
const withDeadline = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
/** Códigos em que a mensagem não foi guardada e a pessoa precisa dela de volta no campo (não é uma "não respondida" para repetir). */
const KEEP_TEXT = new Set(["chat_busy", "chat_changed", "chat_rate_limited", "chat_thread_rate_limited", "project_archived", "validation_error", "invalid_cursor", "not_found", "max_depth", "thread_full", "mention_not_allowed", "participant_cannot_view_ticket", "too_many_mentions", "cannot_mention_self"]);
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
    ? { id: node.id, opening: null, participants: node.participants, participantCount: node.participantCount, replyCount: null, lastActivityAt: node.lastActivityAt ?? "", unread: node.unread, startedByMe: node.ownedByMe, purpose: node.purpose ?? "people", title: node.title }
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
  const topic = card.purpose === "topic";
  return (
    <button type="button" className={`chat-thread-footer ${topic ? "is-topic" : ""}`} onClick={onOpen}>
      {topic ? (
        // O assunto é entre a pessoa e o assistente: a marca ✦ no lugar dos avatares, e o título no lugar de "Thread com…".
        <span className="chat-topic-mark" aria-hidden="true">✦</span>
      ) : (
        <span className="chat-avatars" aria-hidden="true">
          {shown.map((person) => <Initials key={person.id} name={person.displayName} />)}
        </span>
      )}
      <span className="chat-thread-name">{topic ? topicLabel(card.title, card.opening?.body.slice(0, 40), t("row.topic")) : threadTitle(t, card.participants, card.participantCount, selfId)}</span>
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
  const { t, i18n } = useTranslation("chat");
  const chats = useChats()!;
  const { client, directory, version, selfId } = chats;
  const describe = useDescribeApiError();
  const [view, setView] = useState<ConversationData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** A conversa não existe mais (404): sem "tentar de novo", e a barra se atualiza. */
  const [gone, setGone] = useState(false);
  // Um envio que foi para a conversa de um ticket e falhou deixa o texto de volta no campo desta conversa, com o erro.
  const handoff = chats.peekHandoff(target);
  const [draft, setDraft] = useState<Draft>(() => (handoff?.send === true ? { text: "", mentions: [] } : { text: handoff?.text ?? "", mentions: handoff?.mentions ?? [] }));
  /** O que o caminho do `#` mandou para esta conversa enviar assim que ela abrir (a bolha pendente, o "tentar de novo" e a revelação são os desta conversa). */
  const outgoing = useRef<{ text: string; mentions: string[] } | null>(handoff?.send === true ? { text: handoff.text, mentions: handoff.mentions } : null);
  const followThread = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(handoff?.error ?? null);
  /** O envio do `#` está abrindo a conversa do ticket e mandando a mensagem para lá. */
  const [routing, setRouting] = useState(false);
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
  useEffect(() => {
    void chats.loadDirectory();
  }, [chats.loadDirectory]);
  // A entrega de um envio que falhou: lida ao montar e também com a conversa já aberta (o texto volta ao campo, com o erro e o aviso que o envio daqui mostraria).
  useEffect(() => {
    const pending = chats.peekHandoff(target);
    if (pending === undefined || pending.send === true) {
      chats.dropHandoff(target);
      return;
    }
    chats.dropHandoff(target);
    setDraft((current) => (current.text === "" ? { text: pending.text, mentions: pending.mentions } : current));
    setError(pending.error);
    if (pending.code === "assistant_not_configured") setOff("provider");
    else if (pending.code === "assistant_consent_required") setOff("consent");
  }, [chats.dropHandoff, chats.peekHandoff, chats.handoffTick, target]);

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
  // O caminho do `#` mandou esta conversa enviar: assim que ela abre (ou, se não abriu, o texto volta ao campo).
  useEffect(() => {
    const out = outgoing.current;
    if (out === null || (view === null && !loadFailed && !gone)) return;
    outgoing.current = null;
    if (view === null) {
      setDraft(out);
      setError(t("chat.loadFailed"));
      return;
    }
    followThread.current = true;
    if (out.mentions.length > 0 || isPeopleThread) {
      setDraft(out);
      void sendBetweenPeople(out);
    } else {
      void sendToAssistant(out.text.trim());
    }
  }, [view, loadFailed, gone]);
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
  /** Thread de assunto (ADR 0056): só da pessoa e do assistente. Fala com o assistente como a conversa principal; marcar alguém abre uma thread com pessoas. */
  const isTopic = isThread && info?.purpose === "topic";
  /** Thread entre pessoas: não tem assistente. */
  const isPeopleThread = isThread && !isTopic;
  const hasTicket = ticket !== null;
  const mentioning = draft.mentions.length > 0;
  const project = directory.status === "ready" && hasTicket ? directory.projects.find((entry) => entry.id === ticket.projectId) : undefined;
  const candidates = useMemo(
    () => (directory.status === "ready" ? peopleWhoSee(project, directory.people, directory.teams, me?.person.id) : []),
    [directory, project, me],
  );
  // Os tickets citados com `#` que a pessoa enxerga: no Meu chat, exatamente um leva a mensagem à conversa dele (ADR 0056).
  const byKey = useMemo(() => ticketsByKey(chats.tickets.status === "ready" ? chats.tickets.byProject : null), [chats.tickets]);
  const cited = useMemo(() => citedTickets(draft.text, byKey), [draft.text, byKey]);
  const routedTo = kind === "general" && cited.length === 1 ? cited[0]! : null;
  // Quem não enxerga o projeto do ticket de que a conversa trata (ou do ticket para onde a mensagem vai) aparece apagado no `@`.
  const peopleOptions = useMemo(() => {
    if (directory.status !== "ready") return [];
    const projectId = hasTicket ? ticket.projectId : routedTo?.projectId;
    const seeing = projectId === undefined ? null : new Set(peopleWhoSee(directory.projects.find((entry) => entry.id === projectId), directory.people, directory.teams, me?.person.id).map((person) => person.id));
    return directory.people.filter((person) => person.active && person.id !== me?.person.id).map((person: Person) => ({ person, blocked: seeing !== null && !seeing.has(person.id) }));
  }, [directory, hasTicket, ticket, routedTo, me]);
  const projectNames = useMemo(() => new Map(directory.status === "ready" ? directory.projects.map((entry) => [entry.id, entry.name]) : []), [directory]);
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

  // Quem lê tickets (o `#` do campo, uma chave no texto ou numa mensagem) pede a lista; só conta chave cujo prefixo é de um projeto que a pessoa enxerga.
  const projectKeys = useMemo(() => new Set(directory.status === "ready" ? directory.projects.filter((entry) => entry.archivedAt === null).map((entry) => entry.key) : []), [directory]);
  const projectList = directory.status === "ready" ? directory.projects : null;
  /** Abrir o `#`: a lista própria com no máximo 30 s (a do mapa, quando ele está aberto, já é a mais nova). */
  const openTickets = useCallback(() => {
    if (projectList !== null) void chats.loadTickets(projectList, "stale");
  }, [projectList, chats.loadTickets]);
  const retryTickets = useCallback(() => {
    if (projectList !== null) void chats.loadTickets(projectList, "fresh");
  }, [projectList, chats.loadTickets]);
  const draftWants = useMemo(() => wantsTickets(draft.text, projectKeys), [draft.text, projectKeys]);
  const messagesWant = useMemo(() => {
    const wants = (message: { body: string; authorKind?: string }) => wantsTickets(message.body, projectKeys, message.authorKind === "assistant");
    return messages.some(wants) || (info?.opening ? wants(info.opening) : false) || (view?.threads.some((card) => wants(card.opening)) ?? false);
  }, [messages, info, view, projectKeys]);
  const keyShown = draftWants || messagesWant;
  useEffect(() => {
    if (keyShown && active && projectList !== null) void chats.loadTickets(projectList, "once");
  }, [keyShown, active, projectList, chats.loadTickets]);

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
    const result = !created.ok ? created : await safe(() => client.sendChatMessage(created.data, { body: text, ...(mentions.length > 0 ? { mentions } : {}) }, { signal: new AbortController().signal }));
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
      // O caminho do `#` com pessoas: a conversa do ticket abriu a thread, e é a thread que a pessoa vê.
      if (followThread.current) chats.select({ kind: "conversation", id: sent.thread.id });
    } else if (sent.kind === "message") {
      setMessages((current) => [...current, sent.message]);
    }
    resetDraft();
    afterWrite();
  };

  /** Fica nesta conversa: com pessoas marcadas, abre a thread aqui; sem elas, fala com o assistente (ou responde, numa thread). */
  const sendHere = (next: Draft) => {
    if (next.mentions.length > 0 || isPeopleThread) return void sendBetweenPeople(next);
    if (pending?.status === "sending") return;
    resetDraft();
    void sendToAssistant(next.text.trim());
  };

  /**
   * No Meu chat, exatamente um `#ticket` visível leva a mensagem à conversa daquele ticket (ADR 0056): abre (ou obtém) a conversa e o painel
   * vai até lá; é a conversa do ticket que envia (com as pessoas marcadas, se houver: a thread nasce dentro dela), então a bolha pendente, o
   * "tentar de novo" e a revelação são os que toda conversa tem, e o texto de um envio que falha volta ao campo dela. Se a pessoa saiu desta
   * conversa no meio do caminho, a entrega acontece aqui mesmo (nada se perde nem duplica) e a barra se atualiza do mesmo jeito.
   */
  const sendToTicket = async (next: Draft, ticket: TicketSummary) => {
    setRouting(true);
    setError(null);
    setRefused([]);
    const opened = await safe(() => client.openTicketConversation(ticket.id));
    void chats.refresh();
    if (!opened.ok) {
      if (alive.current) {
        setRouting(false);
        setError(describe(opened.error));
      }
      return;
    }
    const conversation: ConversationRef = { kind: "conversation", id: opened.data.id };
    if (alive.current) {
      chats.stashHandoff(conversation, { text: next.text, mentions: next.mentions, error: null, send: true });
      setRouting(false);
      resetDraft();
      chats.select(conversation);
      return;
    }
    const people = next.mentions.length > 0;
    const result = await safe(() => client.sendChatMessage(opened.data.id, { body: people ? next.text : next.text.trim(), ...(people ? { mentions: next.mentions } : {}) }, { signal: new AbortController().signal }));
    if (!result.ok) chats.stashHandoff(conversation, { text: next.text, mentions: next.mentions, error: describe(result.error) });
    void chats.refresh();
  };

  /**
   * Os tickets citados com `#CHAVE` que a pessoa enxerga, ou `null` se não foi possível conferir (a lista não carregou, ou a chave é de um projeto
   * cuja lista falhou). Uma chave desconhecida pode ser de um ticket criado depois: a lista é relida antes de se decidir.
   */
  const citedAtSend = async (text: string): Promise<TicketSummary[] | null> => {
    const ready = directory.status === "ready" ? directory : await chats.loadDirectory();
    if (ready.status !== "ready") return null;
    const keys = hashedKeys(text, new Set(ready.projects.filter((entry) => entry.archivedAt === null).map((entry) => entry.key)));
    if (keys.length === 0) return [];
    let pool = await chats.loadTickets(ready.projects, "stale");
    if (pool.status !== "ready") return null;
    let byKeyNow = ticketsByKey(pool.byProject);
    if (keys.some((key) => !byKeyNow.has(key))) {
      pool = await chats.loadTickets(ready.projects, "fresh");
      if (pool.status !== "ready") return null;
      byKeyNow = ticketsByKey(pool.byProject);
      const failedKeys = new Set(ready.projects.filter((entry) => pool.status === "ready" && pool.failed.includes(entry.id)).map((entry) => entry.key));
      if (keys.some((key) => !byKeyNow.has(key) && failedKeys.has(projectKeyOf(key)))) return null;
    }
    return citedTickets(text, byKeyNow);
  };

  /** No Meu chat, com `#CHAVE` no texto: espera (com aviso e prazo) saber quais tickets valem antes de decidir para onde a mensagem vai; se não der, o texto fica no campo, com o erro. */
  const routeByTickets = async (next: Draft) => {
    setRouting(true);
    setError(null);
    const found = await withDeadline(citedAtSend(next.text), CHECK_MS);
    if (!alive.current) return;
    setRouting(false);
    if (found === null) return setError(t("will.checkFailed"));
    if (found.length === 1) return void sendToTicket(next, found[0]!);
    sendHere(next);
  };

  const send = (next: Draft) => {
    if (routing) return;
    // Só `#CHAVE` (a chave com o `#` colado, fora de código e de endereço) decide o destino; sem ela nada espera.
    if (kind !== "general" || isThread || !ticketKeyRefs(next.text).some((ref) => ref.hashed)) return sendHere(next);
    void routeByTickets(next);
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
                  <AssistantText text={shown} byKey={byKey} onOpenTicket={chats.showTicket} />
                </div>
              )}
            </Reveal>
          ) : (
            <PersonText text={message.body} byKey={byKey} onOpenTicket={chats.showTicket} />
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
    isTopic ? topicLabel(info?.title, info?.opening?.body.slice(0, 40), t("row.topic")) : kind === "thread" ? threadTitle(t, info?.participants ?? [], info?.participants.length ?? 0, selfId) : kind === "general" ? t("row.general") : (ticket?.key ?? "");
  const trailLabel = (item: { kind: "ticket" | "general" | "thread"; label: string | null; title: string | null }) =>
    item.kind === "general" ? t("row.general") : item.kind === "ticket" ? (ticket?.key ?? t("row.main")) : (item.title !== null ? topicLabel(item.title, item.label, t("row.topic")) : (item.label ?? t("row.thread")));
  const mentionNames = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(draft.mentions.map((personId) => names.get(personId) ?? personId));
  /** O que vai acontecer ao enviar, dito antes (ADR 0056). */
  const notice = routing
    ? t("will.checking")
    : routedTo
    ? mentioning ? t("will.ticketAndThread", { key: routedTo.key, names: mentionNames }) : t("will.toTicket", { key: routedTo.key })
    : mentioning ? t("composer.opensThread", { names: mentionNames })
    : cited.length > 0 ? (isThread ? t("will.referenceThread") : t("will.reference"))
    : null;
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
              {isTopic ? (
                <div className="chat-people">
                  <p className="chat-notice">{t("notice.topic")}</p>
                </div>
              ) : (
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
              )}
              {isTopic && assistantOff === "consent" && <ConsentRequiredNotice className="chat-alert" text={t("notice.noConsent")} />}
              {isTopic && assistantOff === "provider" && <p role="alert" className="chat-alert">{t("notice.noProvider")}</p>}
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
            label={isPeopleThread ? t("thread.reply") : t("composer.label")}
            placeholder={isPeopleThread ? t("thread.replyPlaceholder") : assistantOff === null ? t("composer.placeholder") : t("composer.placeholderThreads")}
            draft={draft}
            onDraft={setDraft}
            people={peopleOptions}
            peopleStatus={peopleStatus}
            tickets={chats.tickets}
            projectNames={projectNames}
            onNeedTickets={openTickets}
            onRetryTickets={retryTickets}
            names={names}
            canAssistant={!isPeopleThread && assistantOff === null}
            thread={isPeopleThread}
            canOpenThread={canOpenThread}
            notice={notice}
            assistantBusy={pending?.status === "sending" || routing}
            threadBusy={threadSending || routing}
            readOnly={archived || routing}
            refused={refused}
            fieldRef={field}
            onSend={send}
          />
        </>
      )}
    </div>
  );
}
