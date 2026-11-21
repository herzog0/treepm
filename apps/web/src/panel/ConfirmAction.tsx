import { useState } from "react";

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
        aria-label={`Confirmar: ${subject}`}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Confirmar
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancelar
      </button>
    </span>
  );
}
