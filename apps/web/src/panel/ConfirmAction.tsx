import { useState } from "react";
import { useTranslation } from "react-i18next";

interface ConfirmActionProps {
  /** Texto do primeiro botão, ex.: "Remover". */
  label: string;
  /** Nome acessível completo do primeiro botão, ex.: "Remover Design". */
  accessibleLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** Explica o efeito da ação enquanto a confirmação está aberta. */
  message?: string;
}

/** Confirmação em linha: o primeiro clique pede "Confirmar", o segundo executa. */
export function ConfirmAction({ label, accessibleLabel, onConfirm, disabled = false, message }: ConfirmActionProps) {
  const { t } = useTranslation("panel");
  const [asking, setAsking] = useState(false);
  const subject = accessibleLabel ?? label;

  if (!asking) {
    return (
      <button type="button" className="destructive" aria-label={accessibleLabel} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-action">
      {message && <span className="confirm-message">{message}</span>}
      <button
        type="button"
        className="danger"
        aria-label={t("confirm.label", { subject })}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {t("confirm.confirm")}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        {t("confirm.cancel")}
      </button>
    </span>
  );
}
