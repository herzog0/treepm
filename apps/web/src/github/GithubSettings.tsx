import { useTranslation } from "react-i18next";
import type { ApiClient, Me } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { useDescribeApiError } from "../api/errorText.js";
import { SettingsCard, SettingsLoadError, SettingsLoading, SettingsNote, SettingsRow } from "../settings/parts.js";

/** Conteúdo da seção "GitHub" das Configurações (ADR 0032): ligar e desligar a organização do app. Só existe com `github.enabled`. */
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
    <SettingsCard title={t("settings.card")}>
      {state.status === "loading" && <SettingsLoading>{t("settings.loading")}</SettingsLoading>}
      {state.status === "error" && <SettingsLoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" && installation === null && (
        <>
          <SettingsRow
            title={t("settings.notConnected")}
            hint={isAdmin ? t("settings.readOnlyHint") : t("settings.askAdmin")}
            control={isAdmin ? (
              <button type="button" className="primary" disabled={connect.busy} onClick={() => void startConnection()}>
                {t("settings.connect")}
              </button>
            ) : undefined}
          />
          {isAdmin && connect.error && <SettingsNote role="alert" tone="error">{describeError(connect.error)}</SettingsNote>}
        </>
      )}
      {state.status === "ready" && installation !== null && (
        <>
          <SettingsRow
            title={t("settings.connectedTo", { account: installation.accountLogin, date: formatDate(language, installation.connectedAt) })}
            hint={installation.repositorySelection === "selected" ? t("settings.selectedOnly") : undefined}
          />
          {isAdmin && (
            <div className="settings-danger-row">
              <ConfirmAction label={t("settings.disconnect")} message={t("settings.disconnectWarning")} disabled={disconnect.busy} onConfirm={() => void stopConnection()} />
              {disconnect.error && <SettingsNote role="alert" tone="error">{describeError(disconnect.error)}</SettingsNote>}
            </div>
          )}
        </>
      )}
    </SettingsCard>
  );
}
