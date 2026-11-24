import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "../assistant/Skeleton.js";
import { useChats } from "./ChatsContext.js";
import { Initials, PersonText } from "./MessageText.js";

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
);

/**
 * A coluna enquanto o assunto novo espera a primeira resposta (ADR 0056): a thread só existe quando o assistente responde, então até lá
 * a coluna mostra a mensagem da pessoa e o "respondendo…". Não envia nada: quem envia é `startTopic`, que o clique da barra chama uma vez só.
 */
export function TopicPending() {
  const { t } = useTranslation("chat");
  const chats = useChats()!;
  const run = chats.topicRun;
  const { loadDirectory, directory } = chats;
  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);
  const name = directory.status === "ready" ? directory.me.person.displayName : "";
  return (
    <div className="chat-ticket">
      <header className="chat-header">
        <span className="chat-ticket-title"><span>{t("row.general")}</span></span>
        <button type="button" className="chat-icon-button" aria-label={t("panel.close")} onClick={chats.close}>
          <CloseIcon />
        </button>
      </header>
      <div className="chat-context">
        <nav aria-label={t("trail.label")} className="chat-trail">
          <ol>
            <li>{t("row.general")}</li>
            <li aria-current="page">{t("row.topicNew")}</li>
          </ol>
        </nav>
        <div className="chat-people"><p className="chat-notice">{t("notice.topic")}</p></div>
      </div>
      <ul className="chat-log" role="log" aria-label={t("log.label")} aria-live="polite" aria-relevant="additions">
        {run !== null && (
          <li className="chat-message is-mine">
            <Initials name={name} />
            <div className="chat-message-main">
              <span className="chat-author">{t("message.you")}</span>
              <PersonText text={run.text.trim()} />
            </div>
          </li>
        )}
        <li className="chat-waiting">
          <p role="status">{t("assistant.waiting")}</p>
          <Skeleton />
          <button type="button" className="chat-text-button" onClick={chats.cancelTopic}>{t("topic.cancel")}</button>
        </li>
      </ul>
    </div>
  );
}
