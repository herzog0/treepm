import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import type { PlayTemplateId } from "@treepm/domain";

export interface PlayBarProps {
  template: PlayTemplateId;
  scopeText: string;
  /** 1 a `total`. */
  current: number;
  total: number;
  /** Stand-up: a pessoa da vez e a posição dentro do turno dela. */
  person: { name: string; position: number; total: number } | null;
  /** O ticket do passo (chave e título), para a região viva; `null` quando ele não está mais disponível. */
  ticket: { key: string; title: string } | null;
  onPrevious: () => void;
  onNext: () => void;
  onRestart: () => void;
  onExit: () => void;
}

const Arrow = ({ back = false }: { back?: boolean }) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={back ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} />
  </svg>
);

/**
 * A barra do play (ADR 0048): toma o lugar da barra de pedidos enquanto o modo dura. Nome do modelo e alcance à esquerda, a
 * posição, voltar, avançar, (recomeçar no último passo) e sair. Uma região viva educada anuncia a posição a cada passo.
 */
export const PlayBar = forwardRef<HTMLButtonElement, PlayBarProps>(function PlayBar({ template, scopeText, current, total, person, ticket, onPrevious, onNext, onRestart, onExit }, nextRef) {
  const { t } = useTranslation("play");
  const atEnd = current >= total;
  const position = t("bar.position", { current, total });
  return (
    <div className="play-bar" role="region" aria-label={t("bar.label")} data-keeps-focus="">
      <div className="play-info">
        <strong className="play-name">{t(`template.${template}.name`)}</strong>
        <span className="play-sub">
          {person && <span className="play-person">{t("bar.person", { name: person.name, current: person.position, total: person.total })}</span>}
          <span className={ticket === null ? "play-missing" : "play-scope"}>{ticket === null ? t("bar.missing") : scopeText}</span>
        </span>
      </div>
      <span className="play-position">{position}</span>
      <div className="play-controls">
        <button type="button" className="play-button" aria-label={t("bar.previous")} disabled={current <= 1} onClick={onPrevious}><Arrow back /></button>
        <button ref={nextRef} type="button" className="play-button" aria-label={t("bar.next")} disabled={atEnd} onClick={onNext}><Arrow /></button>
        {atEnd && (
          <button type="button" className="play-button play-restart" onClick={onRestart}>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8a5 5 0 1 1-1.8-3.8M13 2.5v3h-3" /></svg>
            <span className="play-restart-label">{t("bar.restart")}</span>
          </button>
        )}
        <button type="button" className="play-button" aria-label={t("bar.exit")} onClick={onExit}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m3 3 8 8M11 3l-8 8" /></svg>
        </button>
      </div>
      <p className="play-sr" role="status" aria-live="polite">
        {ticket === null ? `${position}: ${t("bar.missing")}` : t("bar.live", { current, total, ticket: `${ticket.key} ${ticket.title}` })}
      </p>
    </div>
  );
});
