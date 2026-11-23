import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PlacementOutcome } from "../api/client.js";

/**
 * Aviso de pedido que já existe (ADR 0052, item 3): aparece antes do botão de criar. O foco vai para o bloco ao aparecer e só o
 * parágrafo é anunciado (`role="alert"`); `announceKey` muda a cada procura, então uma procura que devolve o mesmo duplicado
 * anuncia de novo. Criar fica bloqueado até a pessoa escolher entre abrir o ticket que já existe e criar mesmo assim.
 */
export function DuplicateNotice({ duplicate, announceKey, onOpen, onCreateAnyway }: { duplicate: NonNullable<PlacementOutcome["duplicate"]>; announceKey: number; onOpen: () => void; onCreateAnyway: () => void }) {
  const { t } = useTranslation("assistant");
  const { t: tMap } = useTranslation("map");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), [duplicate.id, announceKey]);
  return (
    <div ref={root} className="assistant-card assistant-duplicate" tabIndex={-1}>
      <p key={announceKey} role="alert">
        {t("related.duplicate.warning", { key: duplicate.key, title: duplicate.title })} ({tMap(`status.${duplicate.status}`, { defaultValue: duplicate.status })})
      </p>
      <div className="assistant-actions">
        <button type="button" className="primary" onClick={onOpen}>{t("related.duplicate.open")}</button>
        <button type="button" onClick={onCreateAnyway}>{t("related.duplicate.anyway")}</button>
      </div>
    </div>
  );
}

/** Lista discreta dos tickets relacionados: chave e título, cada um abrindo o ticket sem fechar o assistente. */
export function RelatedList({ related, onOpen }: { related: PlacementOutcome["related"] | undefined; onOpen: (ticketId: string) => void }) {
  const { t } = useTranslation("assistant");
  if (!related || related.length === 0) return null;
  return (
    <section className="assistant-card assistant-related" aria-label={t("related.heading")}>
      <h3>{t("related.heading")}</h3>
      <p className="assistant-sub">{t("related.hint")}</p>
      <ul>
        {related.map((item) => (
          <li key={item.id}>
            <button type="button" className="text" aria-label={t("related.open", { key: item.key, title: item.title })} onClick={() => onOpen(item.id)}>
              <span className="assistant-related-key">{item.key}</span> {item.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
