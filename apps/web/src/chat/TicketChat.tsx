import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, ChatThread, TicketChat as TicketChatData } from "../api/client.js";
import { assistantEnabled, assistantNeedsConsent } from "../api/client.js";
import { ConsentRequiredNotice, isConsentRequired } from "../api/ConsentRequired.js";
import { useDescribeApiError } from "../api/errorText.js";
import { Reveal } from "../assistant/Reveal.js";
import { Skeleton } from "../assistant/Skeleton.js";
import { PersonText, AssistantText } from "./MessageText.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { ActionsMenu } from "../ticket/menu.js";
import { useChats } from "./ChatsContext.js";
import { Composer } from "./Composer.js";
import type { Draft } from "./Composer.js";
import { peopleWhoSee } from "./directory.js";
import { isAtEnd } from "./scroll.js";
import { ThreadView } from "./ThreadView.js";

const PAGE = 30;
/** Códigos em que a mensagem não foi guardada e a pessoa precisa dela de volta no campo (não é uma "não respondida" para repetir). */
const KEEP_TEXT = new Set(["chat_busy", "chat_changed", "chat_rate_limited", "chat_thread_rate_limited", "project_archived", "validation_error", "invalid_cursor", "not_found"]);
type Tab = "conversation" | "mentions";

interface Pending {
  id: number;
  body: string;
  status: "sending" | "failed";
  error: string | null;
}

/** Uma entrada do fluxo da Conversa: mensagem ou raiz de thread, na ordem do tempo. */
type Entry = { kind: "message"; message: ChatMessage } | { kind: "thread"; thread: ChatThread };
const timeOf = (entry: Entry) => (entry.kind === "message" ? entry.message.createdAt : entry.thread.root.createdAt);

const BackIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2 4 7l5 5" /></svg>
);
const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
);
const DotsIcon = () => (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
);

function ThreadCard({ thread, selfId, onOpen }: { thread: ChatThread; selfId: string | undefined; onOpen: () => void }) {
  const { t, i18n } = useTranslation("chat");
  const others = thread.participants.filter((person) => person.id !== (thread.startedByMe ? thread.root.author?.id : selfId));
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(others.map((person) => person.displayName));
  return (
    <li className="chat-thread-root">
      <p className="chat-thread-origin">{thread.startedByMe ? t("thread.fromMe", { names }) : t("thread.fromOther", { name: thread.root.author?.displayName ?? "" })}</p>
      <PersonText text={thread.root.body} />
      <p className="chat-thread-footer">
        <span>{t("thread.replies", { count: thread.replyCount })}</span>
        {thread.unread > 0 && <span className="chat-badge">{t("thread.unread", { count: thread.unread })}</span>}
        <button type="button" className="chat-text-button" onClick={onOpen}>{t("thread.open")}</button>
      </p>
    </li>
  );
}

interface TicketChatProps {
  ticketId: string;
  /** O painel está à vista; escondido, o chat não pede nada à API nem marca nada como lido. */
  active: boolean;
}

/** O chat de um ticket (ADR 0049): conversa com o assistente e threads de menção, em duas abas. */
export function TicketChat({ ticketId, active }: TicketChatProps) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const { client, directory, version } = chats;
  const describe = useDescribeApiError();
  const [loaded, setLoaded] = useState<TicketChatData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ text: "", mentions: [] });
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
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => chats.loadDirectory(), [chats.loadDirectory]);

  /** Traz a página mais nova. `replace` troca tudo (a conversa mudou em outro aparelho); sem ele, junta ao que já está (a atualização automática). */
  const load = useCallback(async (mode: "first" | "merge" | "replace") => {
    const result = await safe(() => client.getTicketChat(ticketId, { limit: PAGE }));
    if (!alive.current) return;
    if (!result.ok) {
      if (mode === "first") setLoadFailed(true);
      return;
    }
    const page = [...result.data.messages.items].reverse();
    setLoadFailed(false);
    setLoaded(result.data);
    setMessages((current) => {
      if (mode !== "merge" || current.length === 0) return page;
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of page) byId.set(message.id, message);
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
    setOlder((current) => (mode === "merge" && current !== null ? current : result.data.messages.nextBefore));
    setTab((current) => current ?? (!result.data.assignedToMe && result.data.messages.items.length === 0 && result.data.threads.some((thread) => !thread.startedByMe) ? "mentions" : "conversation"));
  }, [client, ticketId]);

  useEffect(() => void load("first"), [load]);
  // O painel volta a ficar à vista, ou a lista de chats se atualizou: o chat aberto acompanha.
  const seen = useRef(version);
  useEffect(() => {
    if (!active || loaded === null || seen.current === version) return;
    seen.current = version;
    void load("merge");
  }, [active, version, loaded, load]);
  useEffect(() => {
    if (active && loaded !== null) void load("merge");
  }, [active]);

  const me = directory.status === "ready" ? directory.me : null;
  const selfId = me?.person.id;
  const project = directory.status === "ready" ? directory.projects.find((entry) => entry.id === loaded?.ticket.projectId) : undefined;
  const candidates = useMemo(
    () => (directory.status === "ready" ? peopleWhoSee(project, directory.people, directory.teams, selfId) : []),
    [directory, project, selfId],
  );
  const names = useMemo(() => new Map(directory.status === "ready" ? directory.people.map((person) => [person.id, person.displayName]) : []), [directory]);
  const peopleStatus = directory.status === "ready" ? "ready" : directory.status === "error" ? "error" : "loading";
  const assistantOff = off ?? (me === null ? null : assistantNeedsConsent(me) ? "consent" : !assistantEnabled(me) ? "provider" : null);
  const archived = loaded?.ticket.archived === true;

  // O foco entra no campo quando o chat aparece pela primeira vez com o painel à vista.
  useEffect(() => {
    if (active && loaded !== null && tab !== null && !focused.current) {
      focused.current = true;
      field.current?.focus();
    }
  }, [active, loaded, tab]);

  const showsRoot = (thread: ChatThread) => loaded?.assignedToMe === true || thread.startedByMe;
  const mentionThreads = useMemo(() => (loaded?.threads ?? []).filter((thread) => !thread.startedByMe), [loaded]);
  const entries = useMemo<Entry[]>(() => {
    const flow: Entry[] = messages.map((message) => ({ kind: "message", message }));
    // As raízes só entram na janela já carregada: com mensagens anteriores por buscar, as mais velhas esperam por elas.
    const start = older !== null ? messages[0]?.createdAt : undefined;
    for (const thread of loaded?.threads ?? []) {
      if (showsRoot(thread) && (start === undefined || thread.root.createdAt >= start)) flow.push({ kind: "thread", thread });
    }
    return flow.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  }, [messages, loaded, older]);

  const markRead = useCallback(async (upTo: string) => {
    const result = await safe(() => client.markChatRead(ticketId, { upTo }));
    if (!alive.current) return;
    if (!result.ok) {
      marked.current = null;
      return;
    }
    chats.setChatUnread(ticketId, result.data.unread);
    setLoaded((current) => (current === null ? current : { ...current, unread: result.data.unread, lastRead: result.data.lastRead }));
  }, [client, ticketId, chats.setChatUnread]);

  // "Lido até onde a pessoa viu": só com o fim da lista à vista, e até a mensagem mais nova mostrada.
  const newest = entries.at(-1);
  const hasUnseen = loaded !== null && (loaded.unread > 0 || entries.some((entry) => (entry.kind === "message" ? entry.message.unread : entry.thread.root.unread)));
  const markIfSeen = useCallback(() => {
    const element = scroller.current;
    if (!active || tab !== "conversation" || threadId !== null || !newest || !hasUnseen || !element || !isAtEnd(element)) return;
    const cursor = newest.kind === "message" ? newest.message.cursor : newest.thread.root.cursor;
    if (marked.current === cursor) return;
    marked.current = cursor;
    void markRead(cursor);
  }, [active, tab, threadId, newest, hasUnseen, markRead]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && keepScroll.current !== null) {
      element.scrollTop = element.scrollHeight - keepScroll.current;
      keepScroll.current = null;
    } else if (element) {
      element.scrollTop = element.scrollHeight;
    }
    markIfSeen();
  }, [entries.length, pending, tab, threadId, markIfSeen]);

  const loadOlder = async () => {
    if (older === null) return;
    const element = scroller.current;
    const result = await safe(() => client.getTicketChat(ticketId, { limit: PAGE, before: older }));
    if (!alive.current || !result.ok) return;
    if (element) keepScroll.current = element.scrollHeight - element.scrollTop;
    setMessages((current) => [...[...result.data.messages.items].reverse(), ...current]);
    setOlder(result.data.messages.nextBefore);
  };
  const onScroll = () => {
    const element = scroller.current;
    if (element && element.scrollTop < 40 && older !== null && tab === "conversation") void loadOlder();
    markIfSeen();
  };

  const resetDraft = () => setDraft({ text: "", mentions: [] });

  const sendToAssistant = async (body: string) => {
    const id = nextId.current++;
    setError(null);
    setPending({ id, body, status: "sending", error: null });
    const result = await safe(() => client.sendChatMessage(ticketId, { body }, { signal: new AbortController().signal }));
    if (!alive.current) return;
    if (result.ok && result.data.kind === "assistant") {
      const { message, reply } = result.data;
      setPending(null);
      setMessages((current) => [...current, message, reply]);
      setLoaded((current) => (current === null ? current : { ...current, chatId: current.chatId ?? "chat" }));
      setRevealingId(reply.id);
      setAnnouncement(reply.body);
      return;
    }
    if (result.ok) return setPending(null);
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

  const openThreadFromChat = async ({ text, mentions }: Draft) => {
    setThreadSending(true);
    setError(null);
    setRefused([]);
    const result = await safe(() => client.sendChatMessage(ticketId, { body: text, mentions }, { signal: new AbortController().signal }));
    if (!alive.current) return;
    setThreadSending(false);
    if (!result.ok || result.data.kind !== "thread") {
      if (!result.ok) {
        setError(describe(result.error));
        const ids = result.error.details?.personIds;
        if (Array.isArray(ids)) setRefused(ids.filter((id): id is string => typeof id === "string"));
      }
      return;
    }
    const { thread } = result.data;
    setLoaded((current) => (current === null ? current : { ...current, chatId: current.chatId ?? "chat", threads: [thread, ...current.threads.filter((entry) => entry.id !== thread.id)] }));
    setAnnouncement(t("thread.opened"));
    resetDraft();
  };

  const send = (next: Draft) => {
    if (next.mentions.length > 0) return void openThreadFromChat(next);
    if (pending?.status === "sending") return;
    resetDraft();
    void sendToAssistant(next.text.trim());
  };

  const retry = () => {
    if (pending === null || pending.status !== "failed") return;
    void sendToAssistant(pending.body);
  };

  const clear = async () => {
    const result = await safe(() => client.clearChat(ticketId));
    if (!alive.current) return;
    if (!result.ok) return setError(describe(result.error));
    setMessages([]);
    setOlder(null);
    setPending(null);
    setAnnouncement(t("chat.cleared"));
  };

  const onThread = (thread: ChatThread) => {
    setLoaded((current) => (current === null ? current : { ...current, threads: current.threads.map((entry) => (entry.id === thread.id ? thread : entry)) }));
  };
  const threadRead = useCallback((upTo: string) => {
    void markRead(upTo);
    setLoaded((current) => (current === null || threadId === null ? current : { ...current, threads: current.threads.map((entry) => (entry.id === threadId ? { ...entry, unread: 0 } : entry)) }));
  }, [markRead, threadId]);

  const onTabKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: Tab = tab === "conversation" ? "mentions" : "conversation";
    setTab(next);
    queueMicrotask(() => document.getElementById(`chat-tab-${next}`)?.focus());
  };

  const ticket = loaded?.ticket;
  const mentionUnread = mentionThreads.reduce((sum, thread) => sum + thread.unread, 0);

  return (
    <div className="chat-ticket">
      <header className="chat-header">
        <button type="button" className="chat-icon-button" aria-label={t("panel.back")} onClick={chats.openList}>
          <BackIcon />
        </button>
        {ticket ? (
          <button type="button" className="chat-ticket-title" aria-label={t("chat.openTicket", { key: ticket.key, title: ticket.title })} onClick={() => chats.showTicket(ticket.id)}>
            <code>{ticket.key}</code>
            <span>{ticket.title}</span>
          </button>
        ) : (
          <span className="chat-ticket-title" />
        )}
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
        <button type="button" className="chat-icon-button" aria-label={t("panel.close")} onClick={chats.close}>
          <CloseIcon />
        </button>
      </header>
      {loadFailed && (
        <div className="chat-hint">
          <p role="alert">{t("chat.loadFailed")}</p>
          <button type="button" onClick={() => { setLoadFailed(false); void load("first"); }}>{t("list.retry")}</button>
        </div>
      )}
      {loaded === null && !loadFailed && <p role="status" className="chat-hint">{t("chat.loading")}</p>}
      {loaded !== null && tab !== null && threadId !== null && (
        <ThreadView
          client={client}
          threadId={threadId}
          ticketArchived={archived}
          candidates={candidates}
          peopleStatus={peopleStatus}
          names={names}
          selfId={selfId}
          version={version}
          active={active}
          onBack={() => setThreadId(null)}
          onThread={onThread}
          onRead={threadRead}
        />
      )}
      {loaded !== null && tab !== null && threadId === null && (
        <>
          <div role="tablist" aria-label={t("tabs.label")} className="chat-tabs" onKeyDown={onTabKeyDown}>
            <button type="button" role="tab" id="chat-tab-conversation" aria-selected={tab === "conversation"} aria-controls="chat-tabpanel" tabIndex={tab === "conversation" ? 0 : -1} onClick={() => setTab("conversation")}>
              {t("tabs.conversation")}
            </button>
            <button type="button" role="tab" id="chat-tab-mentions" aria-selected={tab === "mentions"} aria-controls="chat-tabpanel" tabIndex={tab === "mentions" ? 0 : -1} onClick={() => setTab("mentions")}>
              {t("tabs.mentions")}
              {mentionUnread > 0 && <span className="chat-badge">{mentionUnread}</span>}
            </button>
          </div>
          <div id="chat-tabpanel" role="tabpanel" aria-labelledby={`chat-tab-${tab}`} className="chat-tabpanel">
            {tab === "conversation" && (
              <>
                <p className="chat-notice">{t("notice.assistant")}</p>
                {assistantOff === "consent" && <ConsentRequiredNotice className="chat-alert" text={t("notice.noConsent")} />}
                {assistantOff === "provider" && <p role="alert" className="chat-alert">{t("notice.noProvider")}</p>}
                {archived && <p role="status" className="chat-alert">{describe({ kind: "conflict", code: "project_archived" })}</p>}
              </>
            )}
            <ul ref={scroller} className="chat-log" role="log" aria-label={t("log.label")} aria-live="polite" aria-relevant="additions" aria-busy={older !== null && keepScroll.current !== null ? true : undefined} onScroll={onScroll}>
              {tab === "conversation" && older !== null && (
                <li><button type="button" className="chat-text-button" onClick={() => void loadOlder()}>{t("log.older")}</button></li>
              )}
              {tab === "conversation" && entries.length === 0 && pending === null && <li className="chat-hint">{t("log.empty")}</li>}
              {tab === "conversation" && entries.map((entry) =>
                entry.kind === "thread" ? (
                  <ThreadCard key={`t-${entry.thread.id}`} thread={entry.thread} selfId={selfId} onOpen={() => setThreadId(entry.thread.id)} />
                ) : entry.message.authorKind === "person" ? (
                  <li key={entry.message.id} className="chat-message is-mine">
                    <div><PersonText text={entry.message.body} /></div>
                  </li>
                ) : (
                  <li key={entry.message.id} className="chat-message is-assistant">
                    <Reveal text={entry.message.body} active={entry.message.id === revealingId} onDone={() => setRevealingId((current) => (current === entry.message.id ? null : current))} onStep={() => { const element = scroller.current; if (element) element.scrollTop = element.scrollHeight; }}>
                      {(shown, revealing) => (
                        <div className="chat-assistant" aria-hidden={revealing ? true : undefined}>
                          <AssistantText text={shown} />
                        </div>
                      )}
                    </Reveal>
                  </li>
                ),
              )}
              {tab === "mentions" && mentionThreads.length === 0 && <li className="chat-hint">{t("log.mentionsEmpty")}</li>}
              {tab === "mentions" && mentionThreads.map((thread) => <ThreadCard key={thread.id} thread={thread} selfId={selfId} onOpen={() => setThreadId(thread.id)} />)}
              {tab === "conversation" && pending !== null && (
                <li className={`chat-message is-mine ${pending.status === "failed" ? "is-unanswered" : ""}`}>
                  <div>
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
              {tab === "conversation" && pending?.status === "sending" && (
                <li className="chat-waiting">
                  <p role="status">{t("assistant.waiting")}</p>
                  <Skeleton />
                </li>
              )}
            </ul>
            <div className="chat-visually-hidden" role="status" aria-live="polite" aria-label={t("assistant.reply")}>{announcement}</div>
            {error && <p role="alert" className="chat-composer-alert">{error}</p>}
            <Composer
              label={t("composer.label")}
              placeholder={assistantOff === null ? t("composer.placeholder") : t("composer.placeholderThreads")}
              draft={draft}
              onDraft={setDraft}
              candidates={candidates}
              peopleStatus={peopleStatus}
              names={names}
              canAssistant={assistantOff === null}
              thread={false}
              assistantBusy={pending?.status === "sending"}
              threadBusy={threadSending}
              readOnly={archived}
              refused={refused}
              fieldRef={field}
              onSend={send}
            />
          </div>
        </>
      )}
    </div>
  );
}
