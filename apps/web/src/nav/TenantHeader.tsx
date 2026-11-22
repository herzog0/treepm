import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppNav } from "./navigation.js";
import type { View } from "./navigation.js";

/** Barra do topo da aplicação autenticada: marca e navegação à esquerda; seletor da organização, estado da sessão e avatar (`children`) à direita. */
export function TenantHeader({ view, onNavigate, children }: { view: View; onNavigate: (view: View) => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <header className="tenant-header">
      <div className="tenant-brand">
        <strong>{t("brand")}</strong>
        <AppNav view={view} onNavigate={onNavigate} />
      </div>
      <div className="tenant-controls">{children}</div>
    </header>
  );
}
