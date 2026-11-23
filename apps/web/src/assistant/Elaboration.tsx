import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CreatedFromConversation, ProposedLink, SuggestedTask } from "../api/client.js";
import { Skeleton } from "./Skeleton.js";

/** Compara títulos sem caixa, acento nem pontuação: o que a pessoa tirou não volta se a sugestão for a mesma (ADR 0052, item 4). */
export function normalizeTitle(title: string): string {
  return title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A identidade de uma ligação para lembrar que a pessoa a desmarcou: o título da parte de origem (nunca o índice, que muda quando as partes mudam) e a chave de destino. */
export const linkId = (link: Pick<ProposedLink, "de" | "deTitle" | "dependeDe">) => `${link.de === "pai" ? "pai" : normalizeTitle(link.deTitle ?? "")}>${link.dependeDe}`;

/** Esqueleto discreto enquanto a elaboração carrega; não bloqueia nada. */
export function ElaborationLoading() {
  const { t } = useTranslation("assistant");
  return (
    <div className="assistant-card assistant-elaboration-loading" role="status" aria-label={t("elaboration.loading")}>
      <Skeleton />
      <p className="assistant-hint">{t("elaboration.loading")}</p>
    </div>
  );
}

/** As tarefas que o assistente sugere, já incluídas: a pessoa tira uma a uma ou todas. */
export function SuggestedGroup({ tasks, onRemove, onRemoveAll }: { tasks: readonly SuggestedTask[]; onRemove: (task: SuggestedTask) => void; onRemoveAll: () => void }) {
  const { t } = useTranslation("assistant");
  const heading = useRef<HTMLHeadingElement>(null);
  if (tasks.length === 0) return null;
  return (
    <section className="assistant-card assistant-suggested" aria-label={t("elaboration.suggested.heading")}>
      <h3 ref={heading} tabIndex={-1}>{t("elaboration.suggested.heading")}</h3>
      <p className="assistant-sub">{t("elaboration.suggested.hint")}</p>
      <ul>
        {tasks.map((task) => (
          <li key={normalizeTitle(task.title)}>
            <div className="assistant-elaboration-text">
              <strong>{task.title}</strong>
              <span className="assistant-sub">{task.motivo}</span>
              {task.description.trim() !== "" && (
                <details className="assistant-elaboration-description">
                  <summary>{t("elaboration.suggested.description")}</summary>
                  <p>{task.description}</p>
                </details>
              )}
            </div>
            <button
              type="button"
              className="text"
              aria-label={t("elaboration.suggested.remove", { title: task.title })}
              onClick={() => {
                onRemove(task);
                heading.current?.focus();
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="assistant-actions">
        <button type="button" onClick={onRemoveAll}>{t("elaboration.suggested.removeAll")}</button>
      </div>
    </section>
  );
}

export interface LinkRow {
  link: ProposedLink;
  /** `"pai"` ou o índice atual da parte de origem no rascunho. */
  index: "pai" | number;
  /** O título da parte de origem; `null` quando a origem é o próprio ticket. */
  part: string | null;
  /** O ticket de destino, quando a tela sabe o id dele. */
  ticketId: string | null;
  checked: boolean;
}

/** As ligações "depende de" propostas, marcadas por padrão e desmarcáveis; a chave abre o ticket. */
export function LinksGroup({ rows, onToggle, onOpen }: { rows: readonly LinkRow[]; onToggle: (link: ProposedLink) => void; onOpen: (ticketId: string) => void }) {
  const { t } = useTranslation("assistant");
  if (rows.length === 0) return null;
  return (
    <section className="assistant-card assistant-links" aria-label={t("elaboration.links.heading")}>
      <h3>{t("elaboration.links.heading")}</h3>
      <p className="assistant-sub">{t("elaboration.links.hint")}</p>
      <ul>
        {rows.map(({ link, part, ticketId, checked }) => {
          const prefix = part === null ? t("elaboration.links.parent") : t("elaboration.links.part", { part });
          const id = `assistant-link-${linkId(link)}`;
          return (
            <li key={linkId(link)}>
              <div className="assistant-link-row">
                <input id={id} type="checkbox" checked={checked} aria-label={`${prefix} ${link.dependeDe} ${link.dependeDeTitle}`} onChange={() => onToggle(link)} />
                <label htmlFor={id} aria-hidden="true">{prefix}</label>
                {ticketId ? (
                  <button type="button" className="text" aria-label={t("related.open", { key: link.dependeDe, title: link.dependeDeTitle })} onClick={() => onOpen(ticketId)}>
                    <span className="assistant-related-key">{link.dependeDe}</span> {link.dependeDeTitle}
                  </button>
                ) : (
                  <span><span className="assistant-related-key">{link.dependeDe}</span> {link.dependeDeTitle}</span>
                )}
              </div>
              <span className="assistant-sub">{link.motivo}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Uma frase com as contagens, para o leitor de tela anunciar a chegada dos grupos. */
export function ElaborationAnnouncement({ suggested, links }: { suggested: number; links: number }) {
  const { t } = useTranslation("assistant");
  const parts = [suggested > 0 ? t("elaboration.announce.suggested", { count: suggested }) : null, links > 0 ? t("elaboration.announce.links", { count: links }) : null].filter((part): part is string => part !== null);
  const text = parts.length === 2 ? t("elaboration.announce.both", { first: parts[0], second: parts[1] }) : parts.length === 1 ? t("elaboration.announce.single", { only: parts[0] }) : "";
  return (
    <div className="assistant-visually-hidden" role="status" aria-live="polite" aria-label={t("elaboration.announce.region")}>
      {text}
    </div>
  );
}

/** O que a criação deixou de fora (ADR 0052, item 4): quantos itens e por quê, antes de a pessoa abrir o ticket. */
export function CreatedNotice({ notice, onOpen }: { notice: { ticketId: string; warnings: CreatedFromConversation["warnings"] }; onOpen: () => void }) {
  const { t } = useTranslation("assistant");
  return (
    <section className="assistant-card assistant-created" role="status" aria-label={t("elaboration.created.heading")}>
      <h3>{t("elaboration.created.heading")}</h3>
      <p>{t("elaboration.created.summary", { count: notice.warnings.length })}</p>
      <ul>
        {notice.warnings.map((warning, index) => (
          <li key={index}>
            {warning.code === "link_discarded"
              ? t("elaboration.created.link", { key: warning.dependeDe, reason: t(`elaboration.created.reasons.${warning.reason}`, { defaultValue: warning.reason }) })
              : t("elaboration.created.suggested", { title: warning.title, reason: t(`elaboration.created.reasons.${warning.reason}`, { defaultValue: warning.reason }) })}
          </li>
        ))}
      </ul>
      <div className="assistant-actions">
        <button type="button" className="primary" onClick={onOpen}>{t("elaboration.created.open")}</button>
      </div>
    </section>
  );
}
