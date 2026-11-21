import { useTranslation } from "react-i18next";
import type { ApiClient, Me } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { useDescribeApiError } from "../api/errorText.js";

/** Seção "GitHub" das Configurações (ADR 0032): ligar e desligar a organização do app. Só existe com `github.enabled`. */
export function GithubSettings({ client, me }: { client: ApiClient; me: Me }) {
  const { t, i18n } = useTranslation("github");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const { state, reload, retry } = useApiResource(() => safe(() => client.getGithubInstallation()));
  const connect = useAction();
  const disconnect = useAction();
  const isAdmin = me.roles.clerk === "admin";

  const startConnection = async () => {
    const result = await connect.run(() => client.connectGithub());
    if (result.ok) window.location.assign(result.data.url);
  };
  const stopConnection = async () => {
    const result = await disconnect.run(() => client.disconnectGithub());
    // Um 404 `not_connected` diz que já estava desligada: a tela só precisa mostrar o estado real.
    if (result.ok || result.error.code === "not_connected") reload();
  };

  const installation = state.status === "ready" ? state.data.installation : null;
  return (
    <section aria-labelledby="settings-github" className="settings-github">
      <h2 id="settings-github">{t("title")}</h2>
      {state.status === "loading" && <p role="status">{t("settings.loading")}</p>}
      {state.status === "error" && <LoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" && installation === null && (
        <>
          <p>{t("settings.notConnected")}</p>
          {isAdmin ? (
            <>
              <button type="button" className="primary" disabled={connect.busy} onClick={() => void startConnection()}>
                {t("settings.connect")}
              </button>
              <p className="settings-hint">{t("settings.readOnlyHint")}</p>
              {connect.error && <p role="alert" className="settings-error">{describeError(connect.error)}</p>}
            </>
          ) : (
            <p className="settings-hint">{t("settings.askAdmin")}</p>
          )}
        </>
      )}
      {state.status === "ready" && installation !== null && (
        <>
          <p>{t("settings.connectedTo", { account: installation.accountLogin, date: formatDate(language, installation.connectedAt) })}</p>
          {installation.repositorySelection === "selected" && <p className="settings-hint">{t("settings.selectedOnly")}</p>}
          {isAdmin && (
            <div className="settings-actions">
              <ConfirmAction label={t("settings.disconnect")} message={t("settings.disconnectWarning")} disabled={disconnect.busy} onConfirm={() => void stopConnection()} />
              {disconnect.error && <p role="alert" className="settings-error">{describeError(disconnect.error)}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
