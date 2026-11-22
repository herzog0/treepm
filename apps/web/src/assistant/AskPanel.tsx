import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Project, TicketSummary } from "../api/client.js";
import { AiIcon } from "../command/icons.js";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { safe } from "../panel/safe.js";
import { RichDescription } from "../ticket/description/RichDescription.js";
import "./assistant.css";

/** Limites da API (`ask.schema.ts`): a pergunta, e as mensagens anteriores que vão em `history`. */
export const ASK_QUESTION_MAX = 2000;
export const ASK_HISTORY_MAX = 20;
const WARN_AT = 1800;

/** Uma pergunta que veio de fora da folha (a barra de pedidos): `id` muda a cada uma, para a mesma frase poder se repetir. */
export interface IncomingQuestion {
  id: number;
  text: string;
}

export interface AskPanelProps {
  client: ApiClient;
  /** Projetos visíveis (não arquivados): qualquer pessoa com acesso pergunta, também quem só lê. */
  projects: readonly Project[];
  /** O projeto escolhido ao abrir; `null` faz a folha perguntar "Em qual projeto?" antes de enviar. */
  initialProjectId: string | null;
  /** A pergunta da barra: vai assim que há projeto, e outra vinda depois é uma continuação na mesma folha. */
  incoming: IncomingQuestion | null;
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** A folha está à vista; recolhida, as mensagens continuam montadas (a barra mostra "Pergunta em andamento"). */
  expanded: boolean;
  onCollapse: () => void;
  /** "Nova pergunta": o mapa encerra a folha e leva o foco ao campo da barra. */
  onNew: () => void;
  /** Diz se a folha tem mensagens: recolher uma folha vazia a encerra. */
  onProgress: (active: boolean) => void;
  /** Clique em uma menção da resposta. */
  onOpenTicket: (ticketId: string) => void;
}

interface Message {
  id: number;
  author: "person" | "assistant";
  body: string;
}

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m3 3 8 8M11 3l-8 8" />
  </svg>
);
const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

/** Folha da pergunta sobre o projeto (ADR 0037, ADR 0036): mora dentro da barra de pedidos, no mesmo lugar e com o mesmo desenho da conversa de novo ticket. */
export function AskPanel(props: AskPanelProps) {
  const { projects, initialProjectId, expanded, onCollapse, onNew, onProgress } = props;
  const { t } = useTranslation("command");
  const body = useRef<HTMLElement>(null);
  const [projectId, setProjectId] = useState(initialProjectId);
  // O que a folha sabe cancelar: o `Esc` dela, antes do `Esc` da barra. Diz se havia algo a cancelar.
  const cancelRef = useRef<() => boolean>(() => false);
  const project = projects.find((entry) => entry.id === projectId) ?? null;

  useEffect(() => {
    if (project === null) onProgress(false);
  }, [project, onProgress]);

  // O foco entra na folha quando ela abre ou reabre (o campo de pergunta toma o foco quando existe).
  useEffect(() => {
    if (!expanded) return;
    const field = body.current?.querySelector<HTMLElement>("#ask-message");
    (field ?? body.current)?.focus();
  }, [expanded, project]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (!cancelRef.current()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="assistant-sheet ask-sheet" hidden={!expanded} onKeyDown={onKeyDown}>
      <div className="assistant-top">
        <span className="command-icon"><AiIcon /></span>
        {project && <span className="command-chip ask-chip" title={project.name}>{project.key}</span>}
        <div className="assistant-title">
          <h2>{t("ask.title")}</h2>
          {project && <p>{project.name}</p>}
        </div>
        <div className="assistant-header-actions">
          <button type="button" className="text" onClick={onNew}>{t("ask.new")}</button>
        </div>
        <button type="button" className="assistant-close" aria-label={t("ask.collapse")} onClick={onCollapse}>
          <CloseIcon />
        </button>
      </div>
      <section ref={body} className="assistant-body" aria-label={t("ask.label")} tabIndex={-1}>
        {project === null ? (
          <div className="assistant-scroll">
            <h3>{t("ask.project.question")}</h3>
            <ul className="assistant-projects">
              {projects.map((entry) => (
                <li key={entry.id}>
                  <button type="button" onClick={() => setProjectId(entry.id)}>{t("ask.project.option", { key: entry.key, name: entry.name })}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Thread key={project.id} {...props} project={project} cancelRef={cancelRef} />
        )}
      </section>
    </div>
  );
}

interface ThreadProps extends AskPanelProps {
  project: Project;
  cancelRef: { current: () => boolean };
}

function Thread({ client, project, tickets, incoming, expanded, onProgress, onOpenTicket, cancelRef }: ThreadProps) {
  const { t, i18n } = useTranslation("command");
  const language = i18n.language as Language;
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // A pergunta que falhou, com as mensagens que a precediam: "Tentar de novo" a repete do mesmo ponto.
  const [failure, setFailure] = useState<{ question: string; history: Message[] } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sendingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastIncoming = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, sending, failure]);
  // Recolhida, a folha some do layout e a rolagem se perde: ao reabrir, ela volta onde estava.
  useLayoutEffect(() => {
    if (expanded && scroller.current) scroller.current.scrollTop = scrolled.current;
  }, [expanded]);

  useEffect(() => {
    onProgress(messages.length > 0);
  }, [messages.length, onProgress]);
  // Desmontar (outra folha, a folha encerrada) cancela a pergunta a caminho.
  useEffect(() => () => controller.current?.abort(), []);

  /** Manda `question` com `history` (as mensagens anteriores da folha; só as 20 mais recentes vão, as outras ficam na tela). */
  const request = async (question: string, history: Message[]) => {
    const abort = new AbortController();
    controller.current = abort;
    sendingRef.current = true;
    setSending(true);
    setFailure(null);
    const result = await safe(() => client.askProject(project.id, { question, history: history.slice(-ASK_HISTORY_MAX).map(({ author, body }) => ({ author, body })) }, { signal: abort.signal }));
    // Cancelada com `Esc`: a pergunta já voltou ao campo, e a resposta que ainda chegar não vale.
    if (abort.signal.aborted) return;
    sendingRef.current = false;
    setSending(false);
    if (result.ok) {
      setMessages((current) => [...current, { id: nextId.current++, author: "assistant", body: result.data.text }]);
      setAnnouncement(result.data.text);
      return;
    }
    setAnnouncement("");
    setFailure({ question, history });
  };

  const submit = (override?: string) => {
    const question = (override ?? text).trim();
    if (question === "") return;
    // Uma pergunta que chega com outra a caminho não se perde: espera no campo.
    if (sendingRef.current) {
      setText(question);
      return;
    }
    if (question.length > ASK_QUESTION_MAX) {
      setText(question);
      return;
    }
    const history = messagesRef.current;
    setMessages([...history, { id: nextId.current++, author: "person", body: question }]);
    setText("");
    void request(question, history);
  };

  // A pergunta da barra: enviada uma vez (a mesma folha segue com as seguintes).
  useEffect(() => {
    if (incoming === null || lastIncoming.current === incoming.id) return;
    lastIncoming.current = incoming.id;
    submit(incoming.text);
  }, [incoming?.id]);

  cancelRef.current = () => {
    if (!sendingRef.current || controller.current === null) return false;
    controller.current.abort();
    sendingRef.current = false;
    setSending(false);
    // A pergunta volta ao campo e sai da lista, como se não tivesse sido enviada.
    const current = messagesRef.current;
    const last = current.at(-1);
    if (last?.author === "person") {
      setMessages(current.slice(0, -1));
      setText(last.body);
    }
    setFailure(null);
    queueMicrotask(() => input.current?.focus());
    return true;
  };

  const retry = () => {
    if (failure === null || sendingRef.current) return;
    void request(failure.question, failure.history);
  };

  const overLimit = text.length > ASK_QUESTION_MAX;
  const canSend = !sending && text.trim() !== "" && !overLimit;

  return (
    <>
      <div ref={scroller} className="assistant-scroll" onScroll={(event) => { if (expanded) scrolled.current = event.currentTarget.scrollTop; }}>
        {messages.map((message) =>
          message.author === "person" ? (
            <div key={message.id} className="assistant-person">{message.body}</div>
          ) : (
            <div key={message.id} className="assistant-reply ask-answer">
              <RichDescription
                className="is-answer"
                value={message.body}
                editing={false}
                canEdit={false}
                label={t("ask.reply")}
                placeholder=""
                mentions={{ projectId: project.id, tickets: tickets[project.id] ?? [] }}
                onOpenMention={onOpenTicket}
              />
            </div>
          ),
        )}
        {sending && <p role="status" className="assistant-waiting">{t("ask.waiting")}</p>}
        {failure && !sending && (
          <div className="assistant-error">
            <p role="alert">{t("ask.error")}</p>
            <div>
              <button type="button" onClick={retry}>{t("ask.retry")}</button>
            </div>
          </div>
        )}
      </div>
      <div className="assistant-visually-hidden" role="status" aria-live="polite" aria-label={t("ask.reply")}>{announcement}</div>
      <form className="assistant-form ask-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="assistant-form-field">
          <label className="assistant-visually-hidden" htmlFor="ask-message">{t("ask.message.label")}</label>
          <input
            ref={input}
            id="ask-message"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder={t("ask.message.placeholder")}
            value={text}
            aria-invalid={overLimit ? true : undefined}
            onChange={(event) => setText(event.target.value)}
          />
          {text.length >= WARN_AT && (
            <p className={`assistant-count ${overLimit ? "is-over" : ""}`}>
              {overLimit ? t("ask.message.over", { max: formatNumber(language, ASK_QUESTION_MAX), length: text.length }) : t("ask.message.within", { max: formatNumber(language, ASK_QUESTION_MAX), length: text.length })}
            </p>
          )}
        </div>
        <button type="submit" className="assistant-send" aria-label={t("ask.message.send")} disabled={!canSend}>
          <SendIcon />
        </button>
      </form>
    </>
  );
}
