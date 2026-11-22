import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AccessToken, ApiClient, ApiError, ApiResult, CreatedAccessToken, Me, OrganizationAccessToken, Project } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { SNIPPET_CLIENTS, mcpAddress, snippetsFor } from "./mcpSnippets.js";
import type { SnippetClient } from "./mcpSnippets.js";
import "./mcp.css";

const VALIDITIES = [30, 90, 365] as const;
type Validity = (typeof VALIDITIES)[number];
const NAME_MAX = 80;

type TokenStatus = "active" | "expired" | "revoked";
const statusOf = (token: AccessToken, now: number): TokenStatus =>
  token.revokedAt !== null ? "revoked" : Date.parse(token.expiresAt) <= now ? "expired" : "active";

/** Ativos primeiro; dentro de cada grupo, os mais novos antes. */
function sortTokens<T extends AccessToken>(tokens: readonly T[]): T[] {
  const now = Date.now();
  const rank = (token: T) => (statusOf(token, now) === "active" ? 0 : 1);
  return [...tokens].sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Como `useApiResource`, mas recarrega quando `revision` muda e mantém a lista antiga na tela enquanto isso. */
function useRevisedResource<T>(load: () => Promise<ApiResult<T>>, revision: number) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: ApiError }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void safe(load).then((result) => {
      if (active) setState(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
    });
    return () => {
      active = false;
    };
  }, [revision, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);
  return { state, retry };
}

/** Seção "Clientes de IA (MCP)" das Configurações (ADR 0038): a chave da organização e os tokens de acesso. */
export function McpSettings({ client, me }: { client: ApiClient; me: Me }) {
  const { t } = useTranslation("settings");
  const isAdmin = me.roles.clerk === "admin";
  const [enabled, setEnabled] = useState(me.mcp?.enabled === true);
  // A chave "Permitir escrita por MCP" (ADR 0043); uma API que não a informa conta como desligada.
  const [writeEnabled, setWriteEnabled] = useState(me.mcp?.writeEnabled === true);
  const [writePending, setWritePending] = useState<boolean | null>(null);
  // O que o interruptor mostra enquanto a gravação está em andamento; a seção só abre depois de gravada.
  const [pending, setPending] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<"switchFailed" | "writeSwitchFailed" | "disabledMeanwhile" | null>(null);

  const change = async (next: boolean) => {
    setNotice(null);
    setPending(next);
    let result: ApiResult<{ mcp: { enabled: boolean; writeEnabled?: boolean | undefined } }>;
    try {
      result = await client.setMcpEnabled(next);
    } catch {
      result = { ok: false, error: { kind: "unavailable" } };
    }
    setPending(null);
    if (result.ok) {
      setEnabled(result.data.mcp.enabled);
      if (result.data.mcp.writeEnabled !== undefined) setWriteEnabled(result.data.mcp.writeEnabled);
    } else setNotice("switchFailed");
  };
  const changeWrite = async (next: boolean) => {
    setNotice(null);
    setWritePending(next);
    let result: ApiResult<{ mcp: { enabled: boolean; writeEnabled?: boolean | undefined } }>;
    try {
      result = await client.setMcpWriteEnabled(next);
    } catch {
      result = { ok: false, error: { kind: "unavailable" } };
    }
    setWritePending(null);
    if (result.ok) {
      setEnabled(result.data.mcp.enabled);
      setWriteEnabled(result.data.mcp.writeEnabled ?? next);
    } else setNotice("writeSwitchFailed");
  };
  const disabledMeanwhile = useCallback(() => {
    setEnabled(false);
    setNotice("disabledMeanwhile");
  }, []);

  return (
    <section aria-labelledby="settings-mcp" className="settings-mcp">
      <h2 id="settings-mcp">{t("mcp.title")}</h2>
      {isAdmin && (
        <div className="mcp-switch">
          <label className="settings-option">
            <input type="checkbox" role="switch" checked={pending ?? enabled} disabled={pending !== null} onChange={(event) => void change(event.target.checked)} />
            {t("mcp.switch.label")}
          </label>
          <p className="settings-hint">{t("mcp.switch.hint")}</p>
        </div>
      )}
      {isAdmin && (
        <div className="mcp-switch">
          <label className="settings-option">
            <input type="checkbox" role="switch" checked={writePending ?? writeEnabled} disabled={!enabled || pending !== null || writePending !== null} onChange={(event) => void changeWrite(event.target.checked)} />
            {t("mcp.writeSwitch.label")}
          </label>
          <p className="settings-hint">{t("mcp.writeSwitch.hint")}</p>
        </div>
      )}
      {!isAdmin && !enabled && <p>{t("mcp.askAdmin")}</p>}
      {notice !== null && <p role="alert" className="settings-error">{t(`mcp.notice.${notice}`)}</p>}
      {enabled && <McpTokens client={client} isAdmin={isAdmin} writeEnabled={writeEnabled} onDisabled={disabledMeanwhile} />}
    </section>
  );
}

function McpTokens({ client, isAdmin, writeEnabled, onDisabled }: { client: ApiClient; isAdmin: boolean; writeEnabled: boolean; onDisabled: () => void }) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const [revision, setRevision] = useState(0);
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);
  const revoke = useAction();
  const projects = useApiResource(() => safe(() => client.listProjects()));
  const own = useRevisedResource(() => client.listAccessTokens(), revision);

  const disabled = (error: ApiError) => error.code === "mcp_disabled";
  useEffect(() => {
    if (own.state.status === "error" && disabled(own.state.error)) onDisabled();
  }, [own.state, onDisabled]);

  const revokeToken = async (id: string) => {
    const result = await revoke.run(() => client.revokeAccessToken(id));
    if (result.ok) setRevision((current) => current + 1);
    else if (disabled(result.error)) onDisabled();
  };

  return (
    <>
      <div className="mcp-block">
        <h3 id="mcp-own">{t("mcp.own.title")}</h3>
        {own.state.status === "loading" && <p role="status">{t("mcp.loading")}</p>}
        {own.state.status === "error" && !disabled(own.state.error) && <LoadError error={own.state.error} onRetry={own.retry} />}
        {own.state.status === "ready" && (
          <TokenList labelledBy="mcp-own" tokens={own.state.data} empty={t("mcp.own.empty")} onRevoke={(id) => void revokeToken(id)} busy={revoke.busy} />
        )}
      </div>

      <CreateToken
        client={client}
        projects={projects.state.status === "ready" ? projects.state.data : null}
        projectsFailed={projects.state.status === "error"}
        retryProjects={projects.retry}
        writeEnabled={writeEnabled}
        created={created}
        onCreated={(token) => {
          setCreated(token);
          setRevision((current) => current + 1);
        }}
        onClose={() => setCreated(null)}
        onDisabled={onDisabled}
      />

      {isAdmin && <OrganizationTokens client={client} revision={revision} onRevoke={(id) => void revokeToken(id)} busy={revoke.busy} onDisabled={onDisabled} />}
      {revoke.error && !disabled(revoke.error) && <p role="alert" className="settings-error">{describeError(revoke.error)}</p>}
    </>
  );
}

function OrganizationTokens({ client, revision, onRevoke, busy, onDisabled }: { client: ApiClient; revision: number; onRevoke: (id: string) => void; busy: boolean; onDisabled: () => void }) {
  const { t } = useTranslation("settings");
  const list = useRevisedResource(() => client.listOrganizationAccessTokens(), revision);
  useEffect(() => {
    if (list.state.status === "error" && list.state.error.code === "mcp_disabled") onDisabled();
  }, [list.state, onDisabled]);
  return (
    <div className="mcp-block">
      <h3 id="mcp-organization">{t("mcp.organization.title")}</h3>
      {list.state.status === "loading" && <p role="status">{t("mcp.loading")}</p>}
      {list.state.status === "error" && list.state.error.code !== "mcp_disabled" && <LoadError error={list.state.error} onRetry={list.retry} />}
      {list.state.status === "ready" && (
        <TokenList labelledBy="mcp-organization" tokens={list.state.data} empty={t("mcp.organization.empty")} onRevoke={onRevoke} busy={busy} />
      )}
    </div>
  );
}

function TokenList({ labelledBy, tokens, empty, onRevoke, busy }: { labelledBy: string; tokens: readonly (AccessToken | OrganizationAccessToken)[]; empty: string; onRevoke: (id: string) => void; busy: boolean }) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.language as Language;
  if (tokens.length === 0) return <p className="settings-hint">{empty}</p>;
  const now = Date.now();
  return (
    <ul aria-labelledby={labelledBy} className="mcp-tokens">
      {sortTokens(tokens).map((token) => {
        const status = statusOf(token, now);
        return (
          <li key={token.id} className={status === "active" ? "mcp-token" : "mcp-token mcp-token-inactive"}>
            <div className="mcp-token-head">
              <h4>{token.name}</h4>
              <span className={`mcp-token-status mcp-token-status-${status}`}>{t(`mcp.status.${status}`)}</span>
              {"person" in token && <span className="mcp-token-person">{token.person.displayName}</span>}
            </div>
            <dl className="mcp-token-meta">
              <div><dt>{t("mcp.field.project")}</dt><dd>{token.project.key}</dd></div>
              <div><dt>{t("mcp.field.scope")}</dt><dd>{t(token.scope === "write" ? "mcp.scope.write" : "mcp.scope.read")}</dd></div>
              <div><dt>{t("mcp.field.token")}</dt><dd><code>…{token.tokenPrefix}…</code></dd></div>
              <div><dt>{t("mcp.field.createdAt")}</dt><dd>{formatDate(language, token.createdAt)}</dd></div>
              <div><dt>{t("mcp.field.lastUsedAt")}</dt><dd>{token.lastUsedAt === null ? t("mcp.never") : formatDate(language, token.lastUsedAt)}</dd></div>
              <div><dt>{t("mcp.field.expiresAt")}</dt><dd>{formatDate(language, token.expiresAt)}</dd></div>
            </dl>
            {status === "active" && (
              <ConfirmAction
                label={t("mcp.revoke")}
                accessibleLabel={t("mcp.revokeNamed", { name: token.name })}
                message={t("mcp.revokeWarning")}
                disabled={busy}
                onConfirm={() => onRevoke(token.id)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CreateToken({ client, projects, projectsFailed, retryProjects, writeEnabled, created, onCreated, onClose, onDisabled }: {
  client: ApiClient;
  projects: Project[] | null;
  projectsFailed: boolean;
  retryProjects: () => void;
  writeEnabled: boolean;
  created: CreatedAccessToken | null;
  onCreated: (token: CreatedAccessToken) => void;
  onClose: () => void;
  onDisabled: () => void;
}) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const create = useAction();
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState<Validity>(90);
  const [scope, setScope] = useState<"read" | "write">("read");

  const ordered = projects === null ? [] : [...projects.filter((entry) => entry.archivedAt === null), ...projects.filter((entry) => entry.archivedAt !== null)];
  const chosen = ordered.find((entry) => entry.id === projectId) ?? ordered[0];
  const trimmed = name.trim();

  const submit = async () => {
    if (!chosen || trimmed === "") return;
    const result = await create.run(() => client.createAccessToken({ projectId: chosen.id, name: trimmed, expiresInDays: days, ...(scope === "write" ? { scope } : {}) }));
    if (result.ok) {
      setName("");
      onCreated(result.data);
    } else if (result.error.code === "mcp_disabled") onDisabled();
  };
  const errorText = (error: ApiError): string => {
    if (error.code === "access_token_limit") return t("mcp.errors.limit");
    if (error.kind === "not_found") return t("mcp.errors.projectGone");
    return describeError(error);
  };

  return (
    <div className="mcp-block">
      <h3 id="mcp-create">{t("mcp.create.title")}</h3>
      {projects === null && !projectsFailed && <p role="status">{t("mcp.loading")}</p>}
      {projectsFailed && (
        <div className="load-error" role="alert">
          <p>{t("mcp.errors.projects")}</p>
          <button type="button" onClick={retryProjects}>{t("mcp.retry")}</button>
        </div>
      )}
      {projects !== null && ordered.length === 0 && <p className="settings-hint">{t("mcp.create.noProjects")}</p>}
      {chosen && (
        <form
          className="mcp-form"
          aria-labelledby="mcp-create"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="mcp-field">
            <span className="settings-label">{t("mcp.create.project")}</span>
            <select value={chosen.id} onChange={(event) => setProjectId(event.target.value)}>
              {ordered.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t(entry.archivedAt === null ? "mcp.create.projectOption" : "mcp.create.projectOptionArchived", { key: entry.key, name: entry.name })}
                </option>
              ))}
            </select>
          </label>
          <label className="mcp-field">
            <span className="settings-label">{t("mcp.create.name")}</span>
            <input type="text" value={name} maxLength={NAME_MAX} autoComplete="off" onChange={(event) => setName(event.target.value)} />
          </label>
          <div role="radiogroup" aria-labelledby="mcp-validity" className="mcp-field">
            <span id="mcp-validity" className="settings-label">{t("mcp.create.validity")}</span>
            <div className="mcp-validity">
              {VALIDITIES.map((option) => (
                <label key={option} className="settings-option">
                  <input type="radio" name="mcp-validity" checked={days === option} onChange={() => setDays(option)} />
                  {t("mcp.create.days", { days: option })}
                </label>
              ))}
            </div>
          </div>
          <div role="radiogroup" aria-labelledby="mcp-scope" className="mcp-field">
            <span id="mcp-scope" className="settings-label">{t("mcp.scope.label")}</span>
            <div className="mcp-validity">
              {(["read", "write"] as const).map((option) => (
                <label key={option} className="settings-option">
                  <input type="radio" name="mcp-scope" checked={scope === option} onChange={() => setScope(option)} />
                  {t(`mcp.scope.${option}`)}
                </label>
              ))}
            </div>
            <p className="settings-hint">{t(scope === "write" ? "mcp.scope.writeHint" : "mcp.scope.readHint")}</p>
            {scope === "write" && !writeEnabled && <p className="settings-hint mcp-write-off">{t("mcp.scope.writeOff")}</p>}
          </div>
          <div>
            <button type="submit" className="primary" disabled={create.busy || trimmed === ""}>{t("mcp.create.submit")}</button>
          </div>
          {create.error && create.error.code !== "mcp_disabled" && <p role="alert" className="settings-error">{errorText(create.error)}</p>}
        </form>
      )}
      {created && <CreatedPanel token={created} onClose={onClose} />}
    </div>
  );
}

function CreatedPanel({ token, onClose }: { token: CreatedAccessToken; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<SnippetClient>("claudeCode");
  const [feedback, setFeedback] = useState<{ kind: "copied" | "failed"; what: string } | null>(null);
  const id = useId();
  const address = mcpAddress(window.location.origin, token.project.key);

  useEffect(() => {
    headingRef.current?.focus();
    setFeedback(null);
    setTab("claudeCode");
  }, [token.id]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ kind: "copied", what });
    } catch {
      setFeedback({ kind: "failed", what });
    }
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = SNIPPET_CLIENTS.indexOf(tab);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? SNIPPET_CLIENTS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = SNIPPET_CLIENTS[(next + SNIPPET_CLIENTS.length) % SNIPPET_CLIENTS.length]!;
    setTab(target);
    document.getElementById(`${id}-tab-${target}`)?.focus();
  };

  return (
    <section className="mcp-created" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} ref={headingRef} tabIndex={-1}>{t("mcp.created.title")}</h3>
      <p role="status" className="mcp-warning">{t("mcp.created.warning")}</p>
      <div className="mcp-block-code">
        <code className="mcp-secret">{token.token}</code>
        <button type="button" onClick={() => void copy(token.token, t("mcp.copy.what.token"))} aria-label={t("mcp.copy.named", { what: t("mcp.copy.what.token") })}>{t("mcp.copy.button")}</button>
      </div>
      <p role="status" className="mcp-copy-status">
        {feedback === null ? "" : feedback.kind === "copied" ? t("mcp.copy.copied", { what: feedback.what }) : t("mcp.copy.failed")}
      </p>
      <p className="settings-hint">{t("mcp.created.snippets")}</p>
      <div role="tablist" aria-label={t("mcp.created.clients")} className="mcp-tabs">
        {SNIPPET_CLIENTS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            id={`${id}-tab-${entry}`}
            aria-selected={tab === entry}
            aria-controls={`${id}-panel`}
            tabIndex={tab === entry ? 0 : -1}
            onClick={() => setTab(entry)}
            onKeyDown={onTabKey}
          >
            {t(`mcp.client.${entry}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="mcp-tabpanel">
        {snippetsFor(tab, address, token.project.key, token.token).map((block) => (
          <div key={block.id} className="mcp-snippet">
            <div className="mcp-snippet-head">
              <span className="settings-label">{t(`mcp.block.${block.id}.title`)}</span>
              <button type="button" onClick={() => void copy(block.text, t(`mcp.block.${block.id}.what`))} aria-label={t("mcp.copy.named", { what: t(`mcp.block.${block.id}.what`) })}>{t("mcp.copy.button")}</button>
            </div>
            <pre><code>{block.text}</code></pre>
          </div>
        ))}
        {tab === "codex" && <p className="settings-hint">{t("mcp.created.codexHint")}</p>}
      </div>
      <div><button type="button" onClick={onClose}>{t("mcp.created.close")}</button></div>
    </section>
  );
}
