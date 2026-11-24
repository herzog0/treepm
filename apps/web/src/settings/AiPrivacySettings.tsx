import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiConsent, ApiClient, ApiError, ApiResult, Me } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { SettingsCard, SettingsLoadError, SettingsLoading, SettingsNote } from "./parts.js";

type Kind = "assistant" | "code_reading";
type Given = AiConsent["assistant"];

/** Os endereços dos dois documentos públicos (ADR 0039); as páginas são de outro PR. */
const DOCUMENTS = { terms: "/termos", privacy: "/privacidade" } as const;

/** Conteúdo da seção "IA e privacidade" das Configurações (ADR 0039): o aceite da organização para a IA. Só administrador muda. */
export function AiPrivacySettings({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (() => void) | undefined }) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const isAdmin = me.roles.clerk === "admin";
  const { state, reload, retry } = useApiResource(() => safe(() => client.getAiConsent()));
  const [current, setCurrent] = useState<AiConsent | null>(null);
  const [versionChanged, setVersionChanged] = useState(false);
  const change = useAction();

  const data = current ?? (state.status === "ready" ? state.data : null);

  const run = async (action: () => Promise<ApiResult<AiConsent>>) => {
    setVersionChanged(false);
    const result = await change.run(action);
    if (result.ok) {
      setCurrent(result.data);
      onChange?.();
    } else if (result.error.code === "consent_version_changed") {
      setVersionChanged(true);
      change.clear();
      setCurrent(null);
      reload();
    }
  };
  const accept = (kind: Kind) => void run(() => client.acceptAiConsent(kind, data?.currentVersion ?? ""));
  const withdraw = (kind: Kind) => void run(() => client.withdrawAiConsent(kind));

  const failure = (error: ApiError | null) => (error ? <SettingsNote role="alert" tone="error">{describeError(error)}</SettingsNote> : null);

  const describe = (consent: Given) =>
    consent.acceptedBy !== null && consent.acceptedAt !== null && consent.version !== null
      ? t("ai.given", { name: consent.acceptedBy, date: formatDate(language, consent.acceptedAt), version: consent.version })
      : null;

  const block = (kind: Kind, consent: Given, offerable: boolean) => {
    const prefix = kind === "assistant" ? "ai.assistant" : "ai.codeReading";
    const taken = describe(consent);
    return (
      <SettingsCard title={t(`${prefix}.heading`)}>
        <SettingsNote>{t(`${prefix}.explain`)}</SettingsNote>
        {kind === "assistant" && (
          <div className="ai-docs">
            <a href={DOCUMENTS.terms} target="_blank" rel="noopener noreferrer">{t("ai.terms")}<span className="assistant-visually-hidden"> ({t("ai.newTab")})</span></a>
            <a href={DOCUMENTS.privacy} target="_blank" rel="noopener noreferrer">{t("ai.privacy")}<span className="assistant-visually-hidden"> ({t("ai.newTab")})</span></a>
          </div>
        )}
        <SettingsNote>{consent.inForce ? t(`${prefix}.on`) : t(`${prefix}.off`)}</SettingsNote>
        {taken !== null && <SettingsNote tone="hint">{taken}</SettingsNote>}
        {consent.outdated && data && <p className="ai-warning" role="status">{t("ai.outdated", { current: data.currentVersion })}</p>}
        {isAdmin ? (
          <>
            {!consent.inForce && (
              <div className="settings-actions">
                <button type="button" className="primary" disabled={change.busy || !offerable} onClick={() => accept(kind)}>
                  {t(`${prefix}.accept`)}
                </button>
              </div>
            )}
            {!consent.inForce && !offerable && kind === "code_reading" && <SettingsNote tone="hint">{t("ai.codeReading.needsAssistant")}</SettingsNote>}
            {(consent.inForce || consent.outdated) && (
              <div className="settings-danger-row">
                <ConfirmAction label={t("ai.withdraw")} message={t(`${prefix}.withdrawWarning`)} disabled={change.busy} onConfirm={() => withdraw(kind)} />
              </div>
            )}
          </>
        ) : (
          !consent.inForce && <SettingsNote tone="hint">{t("ai.askAdmin")}</SettingsNote>
        )}
      </SettingsCard>
    );
  };

  return (
    <>
      {state.status === "loading" && data === null && <SettingsLoading>{t("ai.loading")}</SettingsLoading>}
      {state.status === "error" && data === null && <SettingsLoadError error={state.error} onRetry={retry} />}
      {data && (
        <>
          {block("assistant", data.assistant, true)}
          {data.codeReading.githubConnected && block("code_reading", data.codeReading, data.codeReading.offerable)}
        </>
      )}
      {versionChanged && <SettingsNote role="alert" tone="error">{t("ai.versionChanged")}</SettingsNote>}
      {failure(change.error)}
    </>
  );
}
