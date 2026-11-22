import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiConsent, ApiClient, ApiError, ApiResult, Me } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";

type Kind = "assistant" | "code_reading";
type Given = AiConsent["assistant"];

/** Os endereços dos dois documentos públicos (ADR 0039); as páginas são de outro PR. */
const DOCUMENTS = { terms: "/termos", privacy: "/privacidade" } as const;

/** Seção "IA e privacidade" das Configurações (ADR 0039): o aceite da organização para a IA. Só administrador muda. */
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

  const failure = (error: ApiError | null) => (error ? <p role="alert" className="settings-error">{describeError(error)}</p> : null);

  const describe = (consent: Given) =>
    consent.acceptedBy !== null && consent.acceptedAt !== null && consent.version !== null
      ? t("ai.given", { name: consent.acceptedBy, date: formatDate(language, consent.acceptedAt), version: consent.version })
      : null;

  const block = (kind: Kind, consent: Given, offerable: boolean) => {
    const prefix = kind === "assistant" ? "ai.assistant" : "ai.codeReading";
    const taken = describe(consent);
    return (
      <div className="ai-block">
        <h3>{t(`${prefix}.heading`)}</h3>
        <p>{t(`${prefix}.explain`)}</p>
        {kind === "assistant" && (
          <div className="ai-docs">
            <a href={DOCUMENTS.terms} target="_blank" rel="noopener noreferrer">{t("ai.terms")}<span className="assistant-visually-hidden"> ({t("ai.newTab")})</span></a>
            <a href={DOCUMENTS.privacy} target="_blank" rel="noopener noreferrer">{t("ai.privacy")}<span className="assistant-visually-hidden"> ({t("ai.newTab")})</span></a>
          </div>
        )}
        <p className="ai-state">{consent.inForce ? t(`${prefix}.on`) : t(`${prefix}.off`)}</p>
        {taken !== null && <p className="settings-hint">{taken}</p>}
        {consent.outdated && data && <p className="ai-warning" role="status">{t("ai.outdated", { current: data.currentVersion })}</p>}
        {isAdmin ? (
          <div className="settings-actions">
            {!consent.inForce && (
              <button type="button" className="primary" disabled={change.busy || !offerable} onClick={() => accept(kind)}>
                {t(`${prefix}.accept`)}
              </button>
            )}
            {!consent.inForce && !offerable && kind === "code_reading" && <p className="settings-hint">{t("ai.codeReading.needsAssistant")}</p>}
            {(consent.inForce || consent.outdated) && (
              <ConfirmAction label={t("ai.withdraw")} message={t(`${prefix}.withdrawWarning`)} disabled={change.busy} onConfirm={() => withdraw(kind)} />
            )}
          </div>
        ) : (
          !consent.inForce && <p className="settings-hint">{t("ai.askAdmin")}</p>
        )}
      </div>
    );
  };

  return (
    <section aria-labelledby="settings-ai" className="settings-ai">
      <h2 id="settings-ai">{t("ai.title")}</h2>
      {state.status === "loading" && data === null && <p role="status">{t("ai.loading")}</p>}
      {state.status === "error" && data === null && <LoadError error={state.error} onRetry={retry} />}
      {data && (
        <>
          {block("assistant", data.assistant, true)}
          {data.codeReading.githubConnected && block("code_reading", data.codeReading, data.codeReading.offerable)}
        </>
      )}
      {versionChanged && <p role="alert" className="settings-error">{t("ai.versionChanged")}</p>}
      {failure(change.error)}
    </section>
  );
}
