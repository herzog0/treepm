import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "../settings/linear.css";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A confirmação de "Sobrescrever com o Linear" (ADR 0066, seção 5), no mesmo modelo do diálogo de ligar o projeto ao Linear: portal,
 * foco preso, Esc cancela, Enter no botão focado o aciona. O foco entra em "Cancelar" (a ação substitui texto que não volta).
 */
export function OverwriteDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation("import");
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (cancelRef.current ?? boxRef.current)?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const box = boxRef.current!;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0] ?? box;
    const last = items.at(-1) ?? box;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === box)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === box)) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div className="linear-dialog">
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lost`} tabIndex={-1} className="linear-dialog-box" onKeyDown={onKeyDown}>
        <h2 id={`${id}-title`}>{t("linear.overwrite.title")}</h2>
        <p className="linear-dialog-note">{t("linear.overwrite.back")}</p>
        <p className="linear-dialog-note">{t("linear.overwrite.same")}</p>
        <p className="linear-dialog-note">{t("linear.overwrite.review")}</p>
        <p id={`${id}-lost`} className="linear-dialog-note">
          <strong>{t("linear.overwrite.lost")}</strong> <strong>{t("linear.overwrite.descriptionLost")}</strong> {t("linear.overwrite.history")}
        </p>
        <div className="linear-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>{t("linear.overwrite.cancel")}</button>
          <button type="button" className="primary" onClick={onConfirm}>{t("linear.overwrite.confirm")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
