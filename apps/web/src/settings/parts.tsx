import type { ReactNode } from "react";
import type { ApiError } from "../api/client.js";
import { LoadError } from "../LoadError.js";

/** Cartão de uma seção: cabeçalho (título, nota e ação opcionais) e linhas. `danger` separa as ações que tiram acesso. */
export function SettingsCard({ title, titleId, note, action, danger = false, children }: { title: string; titleId?: string | undefined; note?: ReactNode; action?: ReactNode; danger?: boolean; children: ReactNode }) {
  return (
    <div className={danger ? "settings-card settings-card-danger" : "settings-card"}>
      <div className="settings-card-head">
        <h3 id={titleId}>{title}</h3>
        {note !== undefined && <span className="settings-card-note">{note}</span>}
        {action !== undefined && <div className="settings-card-action">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/** Um ajuste: nome e explicação à esquerda, controle à direita. */
export function SettingsRow({ title, hint, control, children }: { title: ReactNode; hint?: ReactNode; control?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint !== undefined && <span className="settings-row-hint">{hint}</span>}
        {children}
      </div>
      {control !== undefined && <div className="settings-row-control">{control}</div>}
    </div>
  );
}

/** Linha só de texto (estado vazio, aviso, mensagem de carregamento): o mesmo padrão em todas as seções. */
export function SettingsNote({ role, tone, children }: { role?: "status" | "alert"; tone?: "hint" | "error"; children: ReactNode }) {
  return (
    <p role={role} className={tone === "error" ? "settings-note settings-error" : tone === "hint" ? "settings-note settings-hint" : "settings-note"}>
      {children}
    </p>
  );
}

/** Carregando. */
export function SettingsLoading({ children }: { children: ReactNode }) {
  return <SettingsNote role="status" tone="hint">{children}</SettingsNote>;
}

/** Erro de carregamento com "tentar de novo". */
export function SettingsLoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="settings-state">
      <LoadError error={error} onRetry={onRetry} />
    </div>
  );
}

/** Vazio. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <SettingsNote tone="hint">{children}</SettingsNote>;
}
