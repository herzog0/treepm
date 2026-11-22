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
  /** `neutral` para uma ação que não destrói nada (por exemplo, aceitar uma ideia): sem o vermelho de "Remover". */
  tone?: "danger" | "neutral";
}

/** Confirmação em linha: o primeiro clique pede "Confirmar", o segundo executa. */
export function ConfirmAction({ label, accessibleLabel, onConfirm, disabled = false, message, tone = "danger" }: ConfirmActionProps) {
  const { t } = useTranslation("panel");
  const [asking, setAsking] = useState(false);
  const subject = accessibleLabel ?? label;

  if (!asking) {
    return (
      <button type="button" className={tone === "danger" ? "destructive" : undefined} aria-label={accessibleLabel} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-action">
      {message && <span className="confirm-message">{message}</span>}
      <button
        type="button"
        className={tone === "danger" ? "danger" : "primary"}
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
