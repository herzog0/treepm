import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { withoutPersonLinksDeep } from "@treepm/domain";
import type { CSSProperties, KeyboardEvent, MutableRefObject } from "react";
import type { ConversationNode } from "../api/client.js";
import { formatActivityTime } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { nodeIsRef, refOfNode, topicLabel, useChats } from "./ChatsContext.js";
import { CreationStateBadge } from "./CreationThread.js";
import { situationColor } from "./situation.js";
import { threadColor, threadTitle } from "./thread.js";

/** A indentação cresce 12 px por nível até o quinto; dali para baixo a linha fica onde está (a árvore pode ter mais de dez níveis). */
export const MAX_INDENT_LEVEL = 5;

const GeneralIcon = () => (
  <svg className="conv-general-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 4h12v8H8l-3 3v-3H3z" /></svg>
);

/** As mesmas pessoas (sem olhar a ordem): a thread que repete as pessoas da linha de cima se diz pelo assunto, não pelos nomes. */
const sameParticipants = (a: ConversationNode, b: ConversationNode): boolean => a.participants.length > 0 && a.participantCount === b.participantCount && a.participants.length === b.participants.length && a.participants.every((person) => b.participants.some((other) => other.id === person.id));

const CloseMark = () => (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
);

/** O que a linha diz, em texto puro: é o nome acessível do × e do "Reabrir" ("Fechar conversa: ALFA-1 Corrigir…"). */
function nodeText(t: TFunction<"chat">, node: ConversationNode, parent: ConversationNode | undefined, selfId: string | undefined): string {
  if (node.kind === "thread" && node.purpose === "creation") return node.title?.trim() || t("creation.fallbackTitle");
  if (node.kind === "thread" && node.purpose === "topic") return topicLabel(node.title, node.label ? withoutPersonLinksDeep(node.label) : node.label, t("row.topic"));
  if (node.kind === "general") return t("row.general");
  if (node.kind === "ticket" && node.ticket) return `${node.ticket.key} ${node.ticket.title}`;
  if (node.label && parent !== undefined && sameParticipants(node, parent)) return withoutPersonLinksDeep(node.label);
  return threadTitle(t, node.participants, node.participantCount, selfId);
}

/** O que a linha diz: o ticket, o assunto, o rascunho, o chat geral ou a thread (a mesma frase na lista e nas "Fechadas"). */
function useNodeTitle(node: ConversationNode, parent?: ConversationNode) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const thread = node.kind === "thread";
  const topic = thread && node.purpose === "topic";
  const creation = thread && node.purpose === "creation" ? node.creation : null;
  const text = nodeText(t, node, parent, chats.selfId);
  const title =
    node.kind === "ticket" && node.ticket ? (
      <>
        <code className="conv-key">{node.ticket.key}</code>
        {/* O espaço entre a chave e o título é parte do nome acessível da linha. */}
        {" "}
        {node.ticket.title}
        {chats.newTickets.has(node.ticket.id) && <span className="conv-new">{t("creation.newBadge")}</span>}
      </>
    ) : (
      text
    );
  return { title, text, thread, topic, creation };
}

/** Onde o foco cai quando o aviso do fechamento some: a linha vizinha de quem fechou (ou o cabeçalho da seção). */
const FocusAfterClose = createContext<MutableRefObject<{ neighbor: HTMLElement | null; undo: boolean }> | null>(null);

function ConversationRow({ node, depth, parent }: { node: ConversationNode; depth: number; parent?: ConversationNode }) {
  const { t, i18n } = useTranslation("chat");
  const chats = useChats()!;
  const [closeError, setCloseError] = useState<string | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const after = useContext(FocusAfterClose);
  const current = chats.open && chats.selection !== null && nodeIsRef(node, chats.selection);
  const level = Math.min(depth, MAX_INDENT_LEVEL);
  const { title, text, thread, topic, creation } = useNodeTitle(node, parent);
  const sub = (node.preview ? withoutPersonLinksDeep(node.preview) : node.preview) ?? (node.kind === "general" ? t("row.generalHint") : null);
  return (
    <li className="conv-item">
      <div className="conv-line" ref={lineRef}>
      <button
        type="button"
        className={`conv-row is-${node.kind} ${creation !== null ? "is-creation" : ""} ${node.unread > 0 ? "is-unread" : ""}`}
        style={{ "--conv-level": level } as CSSProperties}
        aria-current={current ? "true" : undefined}
        onClick={() => chats.select(refOfNode(node))}
      >
        {creation !== null ? (
          <span className="conv-creation-mark" aria-hidden="true">+</span>
        ) : topic ? (
          <span className="conv-topic-mark" aria-hidden="true">✦</span>
        ) : thread && node.id !== null ? (
          <span className="conv-thread-mark" aria-hidden="true" style={{ background: threadColor(node.id) }} />
        ) : node.kind === "general" ? (
          <GeneralIcon />
        ) : (
          <span className="conv-dot" aria-hidden="true" style={{ background: situationColor(node.ticket) }} />
        )}
        <span className="conv-text">
          <span className="conv-title">{title}</span>
          {creation !== null ? <span className="conv-preview"><CreationStateBadge state={creation.state} /></span> : sub !== null && <span className="conv-preview">{sub}</span>}
        </span>
        {node.lastActivityAt !== null && <time className="conv-time" dateTime={node.lastActivityAt}>{formatActivityTime(i18n.language as Language, node.lastActivityAt, new Date())}</time>}
        {(node.assignedToMe || node.unread > 0) && (
          <span className="conv-aside">
            {node.assignedToMe && (
              <span className="conv-assigned" role="img" aria-label={t("list.assignedHint")} title={t("list.assignedHint")}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></svg>
              </span>
            )}
            {node.unread > 0 && (
              <span className="conv-badge">
                <span aria-hidden="true">{node.unread}</span>
                <span className="chat-visually-hidden">{t("list.unread", { count: node.unread })}</span>
              </span>
            )}
          </span>
        )}
      </button>
      {node.id !== null && node.kind !== "general" && (
        <button
          type="button"
          className="conv-close"
          aria-label={t("list.close", { name: text })}
          onClick={(event) => {
            const line = lineRef.current;
            // Só quem fechou pelo teclado (clique sem ponteiro: `detail` 0) leva o foco ao aviso; com o mouse o foco ficaria preso nele e o aviso, que pausa com foco, nunca sumiria.
            const focused = event.detail === 0 && line !== null && line.contains(document.activeElement);
            if (after !== null) after.current = { neighbor: focused ? neighborRow(line) : null, undo: focused };
            setCloseError(null);
            void chats.closeConversation(node).then((error) => {
              // O erro vem traduzido do servidor; sem frase própria, a de sempre. Sucesso limpa.
              setCloseError(error === null ? null : error || t("list.closeFailed"));
              // Foco dentro da linha (teclado): vai para "Desfazer", nunca para o `body`.
              if (error !== null && after !== null) after.current.undo = false;
            });
          }}
        >
          <CloseMark />
        </button>
      )}
      </div>
      {closeError !== null && <p role="alert" className="conv-hint">{closeError}</p>}
      {node.kind === "general" && chats.topicRun !== null && (
        <ul className="conv-children">
          <li className="conv-item">
            <button type="button" className={`conv-row is-thread ${chats.topicRun.status === "failed" ? "is-unread" : ""}`} style={{ "--conv-level": Math.min(depth + 1, MAX_INDENT_LEVEL) } as CSSProperties} onClick={() => chats.openTopicRun()}>
              <span className="conv-topic-mark" aria-hidden="true">✦</span>
              <span className="conv-text">
                <span className="conv-title">{chats.topicRun.status === "failed" ? t("topic.failed") : t("topic.pending")}</span>
                <span className="conv-preview">{chats.topicRun.text}</span>
              </span>
            </button>
          </li>
        </ul>
      )}
      {node.children.length > 0 && (
        <ul className="conv-children">
          {node.children.map((child, index) => <ConversationRow key={child.id ?? `${child.kind}-${child.ticket?.id ?? index}`} node={child} depth={depth + 1} parent={node} />)}
        </ul>
      )}
    </li>
  );
}

function ClosedRow({ node }: { node: ConversationNode }) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const { title, text } = useNodeTitle(node);
  const [error, setError] = useState<string | null>(null);
  // O mesmo rótulo da barra, com o contexto de cima: a chave do ticket e o começo da conversa, para duas threads com a mesma pessoa não se confundirem.
  const context = node.kind !== "ticket" && node.ticket ? node.ticket.key : null;
  const hint = node.kind === "thread" && node.purpose !== "creation" && node.label ? withoutPersonLinksDeep(node.label) : null;
  return (
    <li className="conv-closed-row">
      <button type="button" className="conv-closed-open" onClick={() => chats.select(refOfNode(node))}>
        <span className="conv-closed-title">
          {title}
          {context !== null && <span className="conv-closed-context"> · {context}</span>}
        </span>
        {hint !== null && <span className="conv-closed-hint">{hint}</span>}
      </button>
      <button
        type="button"
        className="chat-text-button"
        aria-label={t("list.reopenNamed", { name: text })}
        onClick={() => {
          setError(null);
          void chats.reopenConversation(node.id as string).then((message) => setError(message));
        }}
      >
        {t("list.reopen")}
      </button>
      {error !== null && <p role="alert" className="conv-hint">{error}</p>}
    </li>
  );
}

/** "Fechadas (N)" no fim da lista: recolhida; aberta, é uma lista plana com "Reabrir" em cada uma (ADR 0059). */
function ClosedSection() {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const items = chats.closedList.filter((node) => node.id !== null);
  if (items.length === 0) return null;
  return (
    <div className="conv-closed">
      <button type="button" className="conv-closed-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        {t("list.closedSection", { count: items.length })}
      </button>
      {open && (
        <ul id={listId} className="conv-closed-list" aria-label={t("list.closedLabel")}>
          {items.map((node) => <ClosedRow key={node.id} node={node} />)}
        </ul>
      )}
    </div>
  );
}

/** A seção "Conversas" da barra lateral (ADR 0055): a árvore do chat geral, dos tickets e das threads, sempre à vista. Sem provedor de chats, não existe. */
export function ConversationList() {
  return useChats() ? <ListBody /> : null;
}

/** A linha vizinha de uma linha da lista (a de baixo, ou a de cima se não houver), fora da própria linha e do que há dentro dela. */
function neighborRow(line: HTMLElement | null): HTMLElement | null {
  const item = line?.closest("li.conv-item");
  const rows = item ? [...(item.closest(".conv-list")?.querySelectorAll<HTMLElement>("button.conv-row") ?? [])].filter((row) => !item.contains(row)) : [];
  const after = rows.find((row) => item!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
  return after ?? rows[rows.length - 1] ?? null;
}

function ClosedNotice({ focused, wantFocus }: { focused: MutableRefObject<boolean>; wantFocus: MutableRefObject<{ neighbor: HTMLElement | null; undo: boolean }> }) {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const pointer = useRef(false);
  const notice = chats.closedNotice;
  const undoButton = useRef<HTMLButtonElement>(null);
  // Quem fechou com o foco dentro da linha (teclado) segue para "Desfazer", nunca para o `body`.
  useLayoutEffect(() => {
    if (notice !== null && wantFocus.current.undo) {
      wantFocus.current.undo = false;
      undoButton.current?.focus();
    }
  }, [notice, wantFocus]);
  // O aviso que some leva o ponteiro junto (sem `pointerleave`): o próximo aviso começa sem ele.
  useEffect(() => {
    if (notice === null) pointer.current = false;
  }, [notice]);
  // O tempo só corre quando nem o ponteiro nem o foco estão no aviso.
  const hold = () => chats.holdClosedNotice(pointer.current || focused.current);
  if (notice === null) return null;
  return (
    <div
      className="conv-toast"
      onPointerEnter={() => { pointer.current = true; hold(); }}
      onPointerLeave={() => { pointer.current = false; hold(); }}
      onFocus={() => { focused.current = true; hold(); }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focused.current = false;
        hold();
      }}
    >
      <span>{notice.error ?? (notice.ids.length > 1 ? t("list.closedNoticeMany", { count: notice.ids.length }) : t("list.closedNotice"))}</span>
      <button type="button" className="conv-undo" ref={undoButton} onClick={() => void chats.undoClose()}>{t("list.undo")}</button>
    </div>
  );
}

function ListBody() {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const after = useRef<{ neighbor: HTMLElement | null; undo: boolean }>({ neighbor: null, undo: false });
  const noticeFocused = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const hadNotice = useRef(false);
  // Quando o aviso some com o foco dentro dele, o foco vai para a linha vizinha de quem fechou (ou para o cabeçalho): nunca para o `body`.
  useLayoutEffect(() => {
    const has = chats.closedNotice !== null;
    if (hadNotice.current && !has && noticeFocused.current) {
      const target = after.current.neighbor;
      (target !== null && target.isConnected ? target : heading.current)?.focus();
      noticeFocused.current = false;
    }
    hadNotice.current = has;
  }, [chats.closedNotice]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.conv-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <FocusAfterClose.Provider value={after}>
    <section className="conv-section" aria-labelledby="conv-section-title">
      <div className="conv-section-head">
        <h2 id="conv-section-title" ref={heading} tabIndex={-1}>{t("list.title")}</h2>
        {chats.unreadChats > 0 && <span className="conv-section-total">{t("list.unread", { count: chats.unreadChats })}</span>}
      </div>
      {chats.tree === null && !chats.listFailed && <p role="status" className="conv-hint">{t("list.loading")}</p>}
      {chats.listFailed && (
        <div className="conv-hint">
          <p role="alert">{t("list.loadFailed")}</p>
          <button type="button" className="chat-text-button" onClick={() => void chats.refresh()}>{t("list.retry")}</button>
        </div>
      )}
      {chats.tree !== null && chats.tree.length > 0 && (
        <ul className="conv-list" onKeyDown={onKeyDown}>
          {chats.tree.map((node, index) => <ConversationRow key={node.id ?? `${node.kind}-${node.ticket?.id ?? index}`} node={node} depth={0} />)}
        </ul>
      )}
      {chats.closedList.length > 0 && <ClosedSection />}
      <div className="conv-toast-region" role="status">
        <ClosedNotice focused={noticeFocused} wantFocus={after} />
      </div>
    </section>
    </FocusAfterClose.Provider>
  );
}
