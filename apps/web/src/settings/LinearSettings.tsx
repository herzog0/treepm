import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, LinearConnection, LinearTeam, Me } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { LinearLinkDialog } from "./LinearLinkDialog.js";
import type { LinkResult } from "./LinearLinkDialog.js";
import { SettingsCard, SettingsLoading, SettingsNote, SettingsRow } from "./parts.js";
import "./linear.css";

type Connection = LinearConnection["connection"];

/**
 * O que a casca sabe do Linear (ADR 0060): se o servidor o tem configurado (decide se a seção aparece) e a chave da pessoa.
 * Mora na casca porque `available` das seções é síncrono; um pedido só, compartilhado com a seção. Sem `client` ou `me`, ou
 * com a API respondendo erro (inclusive uma API antiga sem a rota), a seção fica escondida.
 */
export function useLinearConnection(client: ApiClient | undefined, me: Me | null | undefined) {
  const [state, setState] = useState<{ configured: boolean; connection: Connection }>({ configured: false, connection: null });
  const [version, setVersion] = useState(0);
  const personId = me?.person.id;
  useEffect(() => {
    if (!client || personId === undefined) return;
    let active = true;
    void safe(() => client.getLinearConnection()).then((result) => {
      if (active) setState(result.ok ? { configured: result.data.configured, connection: result.data.connection } : { configured: false, connection: null });
    });
    return () => {
      active = false;
    };
  }, [client, personId, version]);
  const setConnection = useCallback((connection: Connection) => setState((current) => ({ ...current, connection })), []);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { configured: state.configured, connection: state.connection, setConnection, reload };
}
export type LinearState = ReturnType<typeof useLinearConnection>;

/** Seção "Linear" das Configurações: a chave pessoal e os times que ela enxerga, de onde se liga um projeto (ADR 0060). */
export function LinearSettings({ client, me, linear, onOpenImport }: { client: ApiClient; me: Me; linear: LinearState; onOpenImport?: ((projectId: string) => void) | undefined }) {
  const { t } = useTranslation("settings");
  if (me.actingAs != null) {
    // A chave é pessoal: agindo como outra pessoa nenhuma rota do Linear vale, e a tela nem pergunta.
    return (
      <SettingsCard title={t("linear.key.title")}>
        <SettingsNote>{t("linear.actingAs")}</SettingsNote>
      </SettingsCard>
    );
  }
  return (
    <>
      <KeyCard client={client} linear={linear} />
      {linear.connection !== null && <TeamsCard key={`${linear.connection.workspace.id}|${linear.connection.connectedAt}`} client={client} me={me} linear={linear} connection={linear.connection} onOpenImport={onOpenImport} />}
      <p className="linear-footnote">{t("linear.key.footnote")}</p>
    </>
  );
}

function KeyCard({ client, linear }: { client: ApiClient; linear: LinearState }) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const [replacing, setReplacing] = useState(false);
  const disconnect = useAction();
  const { connection } = linear;

  const remove = async () => {
    const result = await disconnect.run(() => client.disconnectLinear());
    // `linear_not_connected`: a chave já não estava lá; a tela só precisa mostrar o estado real.
    if (result.ok || result.error.code === "linear_not_connected") {
      linear.setConnection(null);
      setReplacing(false);
    }
  };

  return (
    <SettingsCard
      title={t("linear.key.title")}
      note={connection !== null ? <span className="linear-ok">{t("linear.key.connected")}</span> : undefined}
    >
      {connection === null && (
        <>
          <KeyForm client={client} onConnected={(next) => linear.setConnection(next)} guide={t("linear.key.guide")} />
          <SettingsNote tone="hint">{t("linear.key.after")}</SettingsNote>
        </>
      )}
      {connection !== null && (
        <>
          <SettingsRow
            title={t("linear.key.workspace", { name: connection.workspace.name })}
            hint={<><span className="linear-mono">••••{connection.hint}</span> {t("linear.key.connectedOn", { date: formatDate(language, connection.connectedAt) })}</>}
            control={!replacing ? <button type="button" onClick={() => setReplacing(true)}>{t("linear.key.replace")}</button> : undefined}
          />
          {replacing && (
            <KeyForm
              client={client}
              guide={t("linear.key.replaceGuide")}
              onConnected={(next) => {
                linear.setConnection(next);
                setReplacing(false);
              }}
              onCancel={() => setReplacing(false)}
            />
          )}
          <div className="settings-danger-row">
            <ConfirmAction label={t("linear.key.remove")} message={t("linear.key.removeWarning")} disabled={disconnect.busy} onConfirm={() => void remove()} />
            {disconnect.error && <SettingsNote role="alert" tone="error">{describeError(disconnect.error)}</SettingsNote>}
          </div>
        </>
      )}
    </SettingsCard>
  );
}

/** O campo da chave. O valor só vive neste estado: é apagado assim que a resposta chega, com sucesso ou não, e nunca vai ao armazenamento do navegador. */
function KeyForm({ client, guide, onConnected, onCancel }: { client: ApiClient; guide: string; onConnected: (connection: Connection) => void; onCancel?: () => void }) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const id = useId();
  const [value, setValue] = useState("");
  const connect = useAction();
  const trimmed = value.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || connect.busy) return;
    const result = await connect.run(() => client.connectLinear(trimmed));
    setValue("");
    if (result.ok) onConnected(result.data.connection);
  };
  return (
    <form className="linear-key-form" onSubmit={(event) => void submit(event)}>
      <p className="linear-guide" id={`${id}-guide`}>{guide}</p>
      <label htmlFor={`${id}-key`}>{t("linear.key.label")}</label>
      <input
        id={`${id}-key`}
        type="password"
        name="linear-personal-key"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        className="linear-mono"
        placeholder={t("linear.key.placeholder")}
        aria-describedby={`${id}-guide`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="linear-key-actions">
        <button type="submit" className="primary" disabled={trimmed === "" || connect.busy}>{connect.busy ? t("linear.key.connecting") : t("linear.key.connect")}</button>
        {onCancel && <button type="button" disabled={connect.busy} onClick={onCancel}>{t("linear.key.cancel")}</button>}
      </div>
      {connect.error && <SettingsNote role="alert" tone="error">{describeError(connect.error)}</SettingsNote>}
    </form>
  );
}

function TeamsCard({ client, me, linear, connection, onOpenImport }: { client: ApiClient; me: Me; linear: LinearState; connection: NonNullable<Connection>; onOpenImport: ((projectId: string) => void) | undefined }) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const titleId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const { state, reload, retry } = useApiResource(() => safe(() => client.listLinearTeams()));
  const [linking, setLinking] = useState<{ team: LinearTeam; opener: HTMLElement } | null>(null);
  const refocus = useRef(false);

  // A chave já não está guardada no servidor (removida em outra aba, ou ilegível): a casca relê a ligação.
  const staleConnection = state.status === "error" && state.error.code === "linear_not_connected";
  useEffect(() => {
    if (staleConnection) linear.reload();
  }, [staleConnection]);

  // Depois de ligar, o botão de origem some da lista: o foco não pode ficar perdido na página.
  useEffect(() => {
    if (refocus.current && document.activeElement === document.body) listRef.current?.focus();
    if (state.status === "ready") refocus.current = false;
  }, [state]);

  const close = (result: LinkResult) => {
    const opener = linking?.opener;
    setLinking(null);
    if (result.linked || result.stale) {
      refocus.current = result.linked;
      reload();
    }
    if (opener?.isConnected) opener.focus();
  };

  return (
    <>
      <SettingsCard
        title={t("linear.teams.title")}
        titleId={titleId}
        note={t("linear.teams.note")}
        action={<button type="button" onClick={reload}>{t("linear.teams.refresh")}</button>}
      >
        {state.status === "loading" && <SettingsLoading>{t("linear.teams.loading")}</SettingsLoading>}
        {state.status === "error" && (
          <div className="linear-state">
            <SettingsNote role="alert" tone="error">{describeError(state.error)}</SettingsNote>
            <button type="button" onClick={retry}>{t("linear.teams.retry")}</button>
          </div>
        )}
        {state.status === "ready" && state.data.length === 0 && <SettingsNote tone="hint">{t("linear.teams.empty")}</SettingsNote>}
        {state.status === "ready" && state.data.length > 0 && (
          <ul ref={listRef} tabIndex={-1} className="linear-teams" aria-labelledby={titleId}>
            {state.data.map((team) => (
              <TeamRow key={team.id} team={team} onLink={(opener) => setLinking({ team, opener })} onOpenImport={onOpenImport} />
            ))}
          </ul>
        )}
      </SettingsCard>
      {linking && <LinearLinkDialog client={client} me={me} team={linking.team} workspaceName={connection.workspace.name} onClose={close} />}
    </>
  );
}

function TeamRow({ team, onLink, onOpenImport }: { team: LinearTeam; onLink: (opener: HTMLElement) => void; onOpenImport: ((projectId: string) => void) | undefined }) {
  const { t } = useTranslation("settings");
  const linked = team.linkedProject !== null;
  const name = (
    <>
      <span className="linear-key">{team.key}</span>
      <span aria-hidden="true"> · </span>
      <span>{team.name}</span>
    </>
  );
  return (
    <li>
      <SettingsRow
        title={linked ? <>{name}{" "}<span className="linear-badge linear-badge-lock">{t("linear.teams.permanent")}</span></> : <span className={team.linkedElsewhere ? "linear-team-off" : undefined}>{name}</span>}
        hint={linked ? t("linear.teams.linkedTo", { project: team.linkedProject!.name }) : team.linkedElsewhere ? t("linear.teams.elsewhere") : t("linear.teams.free")}
        control={
          linked ? (
            onOpenImport ? (
              <button type="button" aria-label={t("linear.teams.openImportLabel", { project: team.linkedProject!.name })} onClick={() => onOpenImport(team.linkedProject!.id)}>
                {t("linear.teams.openImport")}
              </button>
            ) : undefined
          ) : team.linkedElsewhere ? (
            <span className="linear-badge">{t("linear.teams.unavailable")}</span>
          ) : (
            <button type="button" className="primary" aria-label={t("linear.teams.linkLabel", { key: team.key })} onClick={(event) => onLink(event.currentTarget)}>
              {t("linear.teams.link")}
            </button>
          )
        }
      />
    </li>
  );
}
