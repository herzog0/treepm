import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationDraftChild, TicketSummary } from "../api/client.js";
import { RichDescription } from "../ticket/description/RichDescription.js";

/** Uma parte do rascunho em edição: `uid` mantém a identidade quando a ordem muda (o título pode se repetir). */
export interface PartEdit extends ConversationDraftChild {
  uid: string;
}

/** As partes de um rascunho que acabou de chegar da API, com a identidade pela posição. */
export const toPartEdits = (children: readonly ConversationDraftChild[]): PartEdit[] =>
  children.map((child, index) => ({ uid: `part-${index}`, title: child.title, description: child.description }));

export const samePartList = (a: readonly ConversationDraftChild[], b: readonly ConversationDraftChild[]): boolean =>
  a.length === b.length && a.every((part, index) => part.title === b[index]!.title && part.description === b[index]!.description);

interface Mentions {
  projectId: string;
  tickets: readonly TicketSummary[];
}

/** O pedido original como será gravado no começo do ticket (ADR 0044): citação só para leitura, aberta por padrão e recolhível. */
export function OriginalRequest({ quote, mentions }: { quote: string; mentions: Mentions }) {
  const { t } = useTranslation("assistant");
  const [open, setOpen] = useState(true);
  return (
    <section className="assistant-card assistant-quote" aria-label={t("draft.quote.label")}>
      <details open={open}>
        <summary onClick={(event) => { event.preventDefault(); setOpen(!open); }}>
          <h3>{t("draft.quote.label")}</h3>
        </summary>
        <p className="assistant-sub">{t("draft.quote.hint")}</p>
        <RichDescription className="is-quote" value={quote} editing={false} canEdit={false} label={t("draft.quote.label")} placeholder="" mentions={mentions} />
      </details>
    </section>
  );
}

interface DraftPartsProps {
  parts: readonly PartEdit[];
  mentions: Mentions;
  disabled: boolean;
  onChange: (parts: PartEdit[]) => void;
}

/** Os filhos do rascunho, na ordem: título e descrição editáveis, tirar, subir e descer (ADR 0044). */
export function DraftParts({ parts, mentions, disabled, onChange }: DraftPartsProps) {
  const { t } = useTranslation("assistant");
  const root = useRef<HTMLOListElement>(null);
  // A parte que se mexeu: o botão dela recebe o foco depois de a lista se reordenar (mover um nó do DOM o tira do foco).
  const [moved, setMoved] = useState<{ uid: string; direction: "up" | "down" } | null>(null);
  const [writing, setWriting] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!moved) return;
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>(`[data-part="${moved.uid}"]`);
    const wanted = Array.from(buttons ?? []).find((button) => button.dataset.move === moved.direction);
    const other = Array.from(buttons ?? []).find((button) => button.dataset.move !== moved.direction && button.dataset.move !== "remove");
    (wanted && !wanted.disabled ? wanted : other)?.focus();
    setMoved(null);
  }, [moved]);

  const update = (uid: string, patch: Partial<ConversationDraftChild>) => onChange(parts.map((part) => (part.uid === uid ? { ...part, ...patch } : part)));
  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= parts.length) return;
    const next = [...parts];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setMoved({ uid: parts[index]!.uid, direction });
    onChange(next);
  };

  return (
    <section className="assistant-parts" aria-label={t("draft.parts.heading")}>
      <div className="assistant-parts-head">
        <h4>{t("draft.parts.heading")}</h4>
        <span className="assistant-parts-count">{t("draft.parts.count", { count: parts.length })}</span>
      </div>
      <ol ref={root} className="assistant-part-list" aria-label={t("draft.parts.heading")}>
        {parts.map((part, index) => (
          <li key={part.uid} className="assistant-part">
            <div className="assistant-part-head">
              <span className="step-n" aria-hidden="true">{index + 1}</span>
              <input value={part.title} aria-label={t("draft.part.title", { position: index + 1 })} disabled={disabled} onChange={(event) => update(part.uid, { title: event.target.value })} />
              <div className="assistant-part-tools">
                <button type="button" data-part={part.uid} data-move="up" aria-label={t("draft.part.moveUp", { title: part.title })} disabled={disabled || index === 0} onClick={() => move(index, "up")}>↑</button>
                <button type="button" data-part={part.uid} data-move="down" aria-label={t("draft.part.moveDown", { title: part.title })} disabled={disabled || index === parts.length - 1} onClick={() => move(index, "down")}>↓</button>
                <button type="button" data-part={part.uid} data-move="remove" aria-label={t("draft.part.remove", { title: part.title })} disabled={disabled} onClick={() => onChange(parts.filter((entry) => entry.uid !== part.uid))}>×</button>
              </div>
            </div>
            {writing === part.uid ? (
              <div className="assistant-part-body">
                <textarea rows={5} value={part.description} aria-label={t("draft.part.description", { position: index + 1 })} onChange={(event) => update(part.uid, { description: event.target.value })} />
                <button type="button" className="text" onClick={() => setWriting(null)}>{t("draft.part.doneDescription")}</button>
              </div>
            ) : (
              <div className="assistant-part-body">
                {part.description.trim() === "" ? (
                  <p className="assistant-hint">{t("draft.part.noDescription")}</p>
                ) : (
                  <RichDescription className="is-part" value={part.description} editing={false} canEdit={false} label={t("draft.part.description", { position: index + 1 })} placeholder="" mentions={mentions} />
                )}
                <button type="button" className="text" disabled={disabled} onClick={() => setWriting(part.uid)}>{t("draft.part.editDescription")}</button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
