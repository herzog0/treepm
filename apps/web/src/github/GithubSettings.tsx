import type { ApiClient, Me } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { formatDate } from "./time.js";

const DISCONNECT_WARNING =
  "Os repositórios ligados aos projetos e os vínculos de código dos tickets serão removidos do TreePM. O app continua instalado no GitHub até você removê-lo lá.";

/** Seção "GitHub" das Configurações (ADR 0032): ligar e desligar a organização do app. Só existe com `github.enabled`. */
export function GithubSettings({ client, me }: { client: ApiClient; me: Me }) {
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
      <h2 id="settings-github">GitHub</h2>
      {state.status === "loading" && <p role="status">Carregando…</p>}
      {state.status === "error" && <LoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" && installation === null && (
        <>
          <p>A organização não está ligada ao GitHub.</p>
          {isAdmin ? (
            <>
              <button type="button" className="primary" disabled={connect.busy} onClick={() => void startConnection()}>
                Conectar GitHub
              </button>
              <p className="settings-hint">O TreePM só lê: nomes de repositórios, branches e pull requests. Nenhum código é copiado.</p>
              {connect.error && <p role="alert" className="settings-error">{describeApiError(connect.error)}</p>}
            </>
          ) : (
            <p className="settings-hint">Peça a um administrador da organização para conectar.</p>
          )}
        </>
      )}
      {state.status === "ready" && installation !== null && (
        <>
          <p>{`Ligada à conta ${installation.accountLogin} desde ${formatDate(installation.connectedAt)}.`}</p>
          {installation.repositorySelection === "selected" && <p className="settings-hint">O app vê só os repositórios escolhidos na instalação.</p>}
          {isAdmin && (
            <div className="settings-actions">
              <ConfirmAction label="Desconectar" message={DISCONNECT_WARNING} disabled={disconnect.busy} onConfirm={() => void stopConnection()} />
              {disconnect.error && <p role="alert" className="settings-error">{describeApiError(disconnect.error)}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
