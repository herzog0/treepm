import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, ChatMessage, ChatThread, Person } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { safe } from "../panel/safe.js";
import { Composer } from "./Composer.js";
import type { Draft } from "./Composer.js";
import { Initials, PersonText } from "./MessageText.js";
import { isAtEnd } from "./scroll.js";

interface ThreadViewProps {
  client: ApiClient;
  threadId: string;
  ticketArchived: boolean;
  candidates: readonly Person[];
  peopleStatus: "loading" | "ready" | "error";
  names: ReadonlyMap<string, string>;
  selfId: string | undefined;
  onBack: () => void;
  /** A thread mudou (resposta nova, leitura): a conversa atualiza o cartão dela. */
  onThread: (thread: ChatThread) => void;
  /** Leu até este `cursor`. */
  onRead: (upTo: string) => void;
}

function Message({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const { t } = useTranslation("chat");
  const name = message.author?.displayName ?? "";
  return (
    <li className={`chat-message ${mine ? "is-mine" : ""}`}>
      <Initials name={name} />
      <div>
        <span className="chat-author">{mine ? t("message.you") : name}</span>
        <PersonText text={message.body} />
      </div>
    </li>
  );
}

/** Uma thread aberta: a mensagem-raiz, as respostas (as mais novas embaixo, as anteriores por cursor) e o campo para responder. */
export function ThreadView({ client, threadId, ticketArchived, candidates, peopleStatus, names, selfId, onBack, onThread, onRead }: ThreadViewProps) {
  const { t } = useTranslation("chat");
  const describe = useDescribeApiError();
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>({ text: "", mentions: [] });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const scroller = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const marked = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await safe(() => client.getChatThread(threadId, { limit: 30 }));
    if (!alive.current) return;
    if (!result.ok) return setFailed(true);
    setThread(result.data.thread);
    setReplies([...result.data.replies.items].reverse());
    setOlder(result.data.replies.nextBefore);
  }, [client, threadId]);
  useEffect(() => void load(), [load]);

  const loadOlder = async () => {
    if (older === null) return;
    const result = await safe(() => client.getChatThread(threadId, { limit: 30, before: older }));
    if (!alive.current || !result.ok) return;
    setReplies((current) => [...[...result.data.replies.items].reverse(), ...current]);
    setOlder(result.data.replies.nextBefore);
  };

  // O fim da lista à vista: lido até a resposta mais nova (ou a raiz, sem respostas).
  const newest = replies.at(-1) ?? thread?.root ?? null;
  const markIfSeen = useCallback(() => {
    const element = scroller.current;
    if (!newest || !element || !isAtEnd(element) || marked.current === newest.cursor) return;
    marked.current = newest.cursor;
    onRead(newest.cursor);
  }, [newest, onRead]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    markIfSeen();
  }, [replies.length, thread, markIfSeen]);
  useEffect(() => field.current?.focus(), [thread !== null]);

  const send = async ({ text, mentions }: Draft) => {
    setSending(true);
    setError(null);
    setRefused([]);
    const result = await safe(() => client.replyChatThread(threadId, mentions.length > 0 ? { body: text, mentions } : { body: text }));
    if (!alive.current) return;
    setSending(false);
    if (!result.ok) {
      setError(describe(result.error));
      const ids = result.error.details?.personIds;
      if (Array.isArray(ids)) setRefused(ids.filter((id): id is string => typeof id === "string"));
      return;
    }
    setReplies((current) => [...current, result.data.message]);
    setThread(result.data.thread);
    onThread(result.data.thread);
    setDraft({ text: "", mentions: [] });
  };

  return (
    <section className="chat-thread" aria-label={t("thread.label")}>
      <div className="chat-thread-bar">
        <button type="button" className="chat-text-button" onClick={onBack}>{t("thread.back")}</button>
      </div>
      {failed && (
        <div className="chat-hint">
          <p role="alert">{t("thread.loadFailed")}</p>
          <button type="button" onClick={() => void load()}>{t("list.retry")}</button>
        </div>
      )}
      <ul ref={scroller} className="chat-log" role="log" aria-label={t("thread.messages")} aria-live="polite" aria-relevant="additions" onScroll={markIfSeen}>
        {older !== null && <li><button type="button" className="chat-text-button" onClick={() => void loadOlder()}>{t("log.older")}</button></li>}
        {thread && <Message message={thread.root} mine={thread.root.author?.id === selfId} />}
        {replies.map((message) => <Message key={message.id} message={message} mine={message.author?.id === selfId} />)}
      </ul>
      {error && <p role="alert" className="chat-composer-alert">{error}</p>}
      <Composer
        label={t("thread.reply")}
        placeholder={t("thread.replyPlaceholder")}
        draft={draft}
        onDraft={setDraft}
        candidates={candidates}
        peopleStatus={peopleStatus}
        names={names}
        canAssistant={false}
        thread
        assistantBusy={false}
        threadBusy={sending}
        readOnly={ticketArchived}
        refused={refused}
        fieldRef={field}
        onSend={(next) => void send(next)}
      />
    </section>
  );
}
