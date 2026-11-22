import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { viewHref } from "../nav/navigation.js";
import type { ApiError } from "./client.js";

const AdminContext = createContext(false);

/** Diz aos avisos de "assistente desligado" se a pessoa é administradora da organização (então eles levam às Configurações). */
export function AdminProvider({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  return <AdminContext.Provider value={isAdmin}>{children}</AdminContext.Provider>;
}

/** Uma rota de IA recusou porque a organização não tem (mais) o aceite em vigor (ADR 0039): a tela trata como "desligado". */
export const isConsentRequired = (error: ApiError | null | undefined): boolean => error?.code === "assistant_consent_required";

/** O aviso de assistente desligado por falta de aceite: diz que um administrador precisa ativá-lo e, se for o caso, leva às Configurações. */
export function ConsentRequiredNotice({ className }: { className?: string }) {
  const { t } = useTranslation("api");
  const isAdmin = useContext(AdminContext);
  return (
    <p role="alert" {...(className ? { className } : {})}>
      {t("errors.code.assistant_consent_required")}
      {isAdmin && (
        <>
          {" "}
          <a href={`${viewHref("settings")}`} target="_blank" rel="noopener noreferrer">{t("errors.settingsLink")}</a>
        </>
      )}
    </p>
  );
}
