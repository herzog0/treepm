import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, ApiError, LinearConnection, LinearRun, ProjectLinear, TicketSummary } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatActivityTime, formatClock, formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { AbandonControl } from "./AbandonControl.js";
import { ArrangeBlock, categorizeAnnouncement, isCategorizing } from "./LinearCategorize.js";
import type { CategorizeHook } from "./LinearCategorize.js";
import { useLinearCategorize } from "./useLinearCategorize.js";
import { useLinearRun } from "./useLinearRun.js";
import type { LoopState } from "./useLinearRun.js";

export interface LinearImportProps {
  client: ApiClient;
  projectId: string;
  /** A ligação da pessoa com o Linear, como a casca da importação a leu: a chave é pessoal. */
  connection: LinearConnection;
  /** Chegou pelo botão "Sincronizar com o Linear": o cartão da última importação já inicia a rodada, uma vez só (ADR 0061). */
  startSync?: boolean;
  /** Volta ao mapa (depois de concluir). */
  onExit: () => void;
  /** Leva às Configurações → Linear. */
  onOpenSettings: () => void;
  /** Abre o ticket no mapa (a lista "a conferir" depois de procurar o lugar dos itens). */
  onOpenTicket: (ticketId: string) => void;
}

type Phase = "projects" | "issues" | "hierarchy" | "statuses" | "mentions" | "comments" | "relations" | "history" | "missing";
const FIRST_PHASES: readonly Phase[] = ["projects", "issues", "hierarchy", "mentions", "comments", "relations", "history"];
/** A reimportação atualiza as situações depois de ligar os pais e confere, no fim, o que sumiu do Linear (ADR 0060, seção 5). */
const REIMPORT_PHASES: readonly Phase[] = ["projects", "issues", "hierarchy", "statuses", "mentions", "comments", "relations", "history", "missing"];
const phasesOf = (run: LinearRun): readonly Phase[] => (run.mode === "reimport" ? REIMPORT_PHASES : FIRST_PHASES);

/** Erros em que o caminho para corrigir é a chave ou a ligação, nas Configurações. */
const SETTINGS_CODES = new Set(["linear_key_invalid", "linear_not_connected", "linear_workspace_mismatch", "linear_team_not_visible", "linear_team_not_found", "linear_not_linked", "linear_not_configured"]);

const count = (run: LinearRun, key: string): number => {
  const value = run.counts[key];
  return typeof value === "number" ? value : 0;
};
/** Quantos itens a rodada já criou (projetos e issues), o "N criados" da linha da importação abandonada. */
const createdOf = (run: LinearRun): number => count(run, "projectsCreated") + count(run, "issuesCreated");
/** Rodada que não vai andar mais (abandonada, ou interrompida): a tela é a de começar outra. */
const isFailed = (run: LinearRun): boolean => run.done && run.phase === "failed";

/** A fase em que a rodada está, na ordem das fases mostradas; a categorização (fatia 4) ainda não aparece. */
function phaseIndex(run: LinearRun): number {
  const phases = phasesOf(run);
  if (run.done) return phases.length;
  const at = phases.indexOf(run.phase as Phase);
  return at === -1 ? phases.length - 1 : at;
}

export function LinearImportPanel(props: LinearImportProps) {
  const { t } = useTranslation("import");
  // A chave é pessoal: agindo como outra pessoa nenhuma rota do Linear vale, e a tela nem pergunta.
  if (props.connection.actingAs === true) {
    return (
      <section className="linear-import" aria-label={t("linear.title")}>
        <Notice>{t("linear.actingAs")}</Notice>
      </section>
    );
  }
  return <ConnectedPanel {...props} />;
}

function ConnectedPanel({ client, projectId, connection, startSync = false, onExit, onOpenSettings, onOpenTicket }: LinearImportProps) {
  const { t } = useTranslation("import");
  const source = useApiResource(() => safe(() => client.getProjectLinear(projectId)));
  const [announcement, setAnnouncement] = useState("");
  const link = source.state.status === "ready" ? source.state.data : null;
  const keyOk = connection.connection !== null && link?.source != null && link.keyMatches !== false;
  const run = useLinearRun(client, projectId, { enabled: keyOk });
  const categorize = useLinearCategorize(client, projectId, { enabled: keyOk });

  // Quem viu a importação andar e terminar: a situação da procura do lugar dos itens mudou (há itens novos na raiz).
  const sawOpenImport = useRef(false);
  const importFinishedKey = run.run !== null && run.run.done && run.run.phase === "done" ? `${run.run.id}:${run.run.updatedAt}` : null;
  const { refresh } = categorize;
  useEffect(() => {
    if (run.run !== null && !run.run.done) sawOpenImport.current = true;
    else if (importFinishedKey !== null && sawOpenImport.current) {
      sawOpenImport.current = false;
      refresh();
    }
  }, [run.run, importFinishedKey, refresh]);

  // Uma região de status que existe desde o início e só anuncia a mudança de fase e o fim, nunca cada passo.
  const importKey = run.run === null ? null : run.run.done ? (isFailed(run.run) ? "abandoned" : run.run.mode === "reimport" ? "reimportDone" : "done") : run.loop.kind === "waiting" ? "waiting" : run.run.phase;
  const arranging = categorizeAnnouncement(categorize);
  const phaseKey = arranging !== null ? `categorize:${arranging}` : importKey;
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (phaseKey === lastPhase.current) return;
    lastPhase.current = phaseKey;
    if (phaseKey !== null && phaseKey.startsWith("categorize:")) setAnnouncement(t(`linear.categorize.announce.${phaseKey.slice("categorize:".length) as "start"}`));
    else if (phaseKey !== null && ["projects", "issues", "hierarchy", "statuses", "mentions", "comments", "relations", "history", "missing", "done", "reimportDone", "waiting", "abandoned"].includes(phaseKey)) setAnnouncement(t(`linear.announce.${phaseKey as "done"}`));
    else setAnnouncement("");
  }, [phaseKey, t]);

  return (
    <section className="linear-import" aria-label={t("linear.title")}>
      <div className="linear-import-status limp-sr" role="status">{announcement}</div>
      {source.state.status === "loading" && <p className="import-muted">{t("linear.loading")}</p>}
      {source.state.status === "error" && <LoadFailed error={source.state.error} onRetry={source.retry} />}
      {source.state.status === "ready" && run.load.status === "loading" && <p className="import-muted">{t("linear.loading")}</p>}
      {source.state.status === "ready" && run.load.status === "error" && <LoadFailed error={run.load.error} onRetry={run.reload} />}
      {source.state.status === "ready" && run.load.status === "ready" && link && (
        <Body client={client} projectId={projectId} link={link} connection={connection} keyOk={keyOk} startSync={startSync} run={run} categorize={categorize} onExit={onExit} onOpenSettings={onOpenSettings} onOpenTicket={onOpenTicket} />
      )}
    </section>
  );
}

function LoadFailed({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  return (
    <div className="linear-import-card">
      <p role="alert" className="import-error-text">{describeError(error)}</p>
      <div className="linear-import-actions"><button type="button" onClick={onRetry}>{t("linear.retry")}</button></div>
    </div>
  );
}

type RunHook = ReturnType<typeof useLinearRun>;

function Body({ client, projectId, link, connection, keyOk, startSync, run, categorize, onExit, onOpenSettings, onOpenTicket }: { client: ApiClient; projectId: string; link: ProjectLinear; connection: LinearConnection; keyOk: boolean; startSync: boolean; run: RunHook; categorize: CategorizeHook; onExit: () => void; onOpenSettings: () => void; onOpenTicket: (ticketId: string) => void }) {
  const { t } = useTranslation("import");
  const current = run.run;
  const last = run.lastFinished;
  // O resumo ("concluída") é de quem viu a rodada andar nesta tela; ao voltar depois, o que vale é o cartão da última importação.
  const [watched, setWatched] = useState(false);
  useEffect(() => {
    if (current !== null && !current.done) setWatched(true);
  }, [current]);
  const finishedHere = watched && current !== null && current.done && !isFailed(current);
  const idle = current === null || current.done;
  return (
    <>
      {link.source === null && (
        <Notice title={t("linear.unlinked.title")} action={<button type="button" onClick={onOpenSettings}>{t("linear.openSettings")}</button>}>
          {link.canLink ? t("linear.unlinked.canLink") : t("linear.unlinked.cannotLink")}
        </Notice>
      )}
      {link.source !== null && connection.connection === null && (
        <Notice title={t("linear.noKey.title")} action={<button type="button" onClick={onOpenSettings}>{t("linear.openSettings")}</button>}>
          {t("linear.noKey.body", { workspace: link.source.workspace.name })}
        </Notice>
      )}
      {link.source !== null && connection.connection !== null && link.keyMatches === false && (
        <Notice title={t("linear.wrongKey.title")} action={<button type="button" onClick={onOpenSettings}>{t("linear.openSettings")}</button>}>
          {t("linear.wrongKey.body", { workspace: link.source.workspace.name, team: link.source.team.key })}
        </Notice>
      )}
      {link.source !== null && (current === null || isFailed(current)) && keyOk && last === null && <StartCard client={client} projectId={projectId} link={link} run={run} previous={current} />}
      {link.source !== null && keyOk && idle && !finishedHere && last !== null && <ReimportCard client={client} projectId={projectId} run={run} last={last} startSync={startSync} categorize={categorize} onExit={onExit} onOpenTicket={onOpenTicket} />}
      {current !== null && !current.done && <ProgressCard run={current} loop={run.loop} onResume={run.resume} onOpenSettings={onOpenSettings} onAbandon={run.abandon} />}
      {finishedHere && <SummaryCard client={client} projectId={projectId} run={current} categorize={categorize} onExit={onExit} onOpenTicket={onOpenTicket} />}
    </>
  );
}

function Notice({ title, children, action }: { title?: string; children: string; action?: React.ReactNode }) {
  return (
    <div className="linear-import-card linear-import-notice">
      {title !== undefined && <h3>{title}</h3>}
      <p>{children}</p>
      {action !== undefined && <div className="linear-import-actions">{action}</div>}
    </div>
  );
}

function StartCard({ client, projectId, link, run, previous }: { client: ApiClient; projectId: string; link: ProjectLinear; run: RunHook; previous: LinearRun | null }) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  const action = useAction();
  const [destination, setDestination] = useState<TicketSummary | null>(null);
  const source = link.source!;
  // "Vai trazer N issues": o servidor pergunta ao Linear; sem número (nulo, erro ou demora) a linha some e o botão nunca espera por ela.
  const previewed = useApiResource(() => safe(() => client.getLinearPreview(projectId)));
  const preview = previewed.state.status === "ready" ? previewed.state.data.issueCount : null;
  const start = async () => {
    await action.run(() => run.open({ destinationTicketId: destination?.id ?? null }));
  };
  return (
    <div className="linear-import-card">
      {previous !== null && <p className="linear-import-previous">{t("linear.abandon.previous", { count: createdOf(previous) })}</p>}
      <dl className="linear-import-facts">
        <div>
          <dt>{t("linear.source")}</dt>
          <dd><code>{source.team.key}</code> {source.team.name} · {source.workspace.name}</dd>
        </div>
        {preview !== null && (
          <div>
            <dt>{t("linear.preview.label")}</dt>
            <dd>{t("linear.preview.issues", { count: preview })}</dd>
          </div>
        )}
        <div>
          <dt id="linear-destination-label">{t("linear.destination")}</dt>
          <dd><DestinationPicker client={client} projectId={projectId} value={destination} onChange={setDestination} /></dd>
        </div>
      </dl>
      <div className="linear-import-actions">
        <button type="button" className="primary" disabled={action.busy} onClick={() => void start()}>{action.busy ? t("linear.starting") : t("linear.start")}</button>
      </div>
      {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
      <p className="linear-import-how">{t("linear.how")}</p>
    </div>
  );
}

/** O destino: a raiz do projeto ou um ticket, escolhido numa lista filtrável como a do "Pai" da página do ticket. */
function DestinationPicker({ client, projectId, value, onChange }: { client: ApiClient; projectId: string; value: TicketSummary | null; onChange: (ticket: TicketSummary | null) => void }) {
  const { t } = useTranslation("import");
  const [picking, setPicking] = useState(false);
  const id = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const rootText = t("linear.root");
  const close = () => {
    setPicking(false);
    opener.current?.focus();
  };
  return (
    <div className="linear-import-destination">
      <div className="linear-import-destination-row">
        <span>{value === null ? rootText : <><span className="linear-import-key">{value.key}</span> {value.title}</>}</span>
        <button ref={opener} type="button" className="text" aria-expanded={picking} aria-controls={`${id}-picker`} aria-describedby="linear-destination-label" onClick={() => setPicking((open) => !open)}>{t("linear.change")}</button>
      </div>
      {picking && (
        <DestinationPanel
          id={`${id}-picker`}
          client={client}
          projectId={projectId}
          onChoose={(ticket) => {
            onChange(ticket);
            close();
          }}
          onCancel={close}
        />
      )}
    </div>
  );
}

/** A lista filtrável de destinos (a raiz e os tickets do projeto, menos os de dentro de ideia); Esc fecha só ela. */
function DestinationPanel({ id, client, projectId, onChoose, onCancel }: { id: string; client: ApiClient; projectId: string; onChoose: (ticket: TicketSummary | null) => void; onCancel: () => void }) {
  const { t } = useTranslation("import");
  const [filter, setFilter] = useState("");
  const tickets = useApiResource(() => safe(() => client.listTickets(projectId)));
  const needle = filter.trim().toLowerCase();
  const rootText = t("linear.root");
  const matches = useMemo(() => {
    if (tickets.state.status !== "ready") return [];
    // Dentro de uma ideia a importação não é possível (o servidor recusa também os descendentes dela).
    return tickets.state.data.filter((entry) => entry.idea == null && (needle === "" || `${entry.key} ${entry.title}`.toLowerCase().includes(needle))).slice(0, 80);
  }, [tickets.state, needle]);
  return (
    <div id={id} className="linear-import-picker" role="group" aria-label={t("linear.picker.label")} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}>
      <input aria-label={t("linear.picker.filter")} autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} />
      {tickets.state.status === "loading" && <p className="import-muted">{t("linear.picker.loading")}</p>}
      {tickets.state.status === "error" && <p className="import-error-text" role="alert">{t("linear.picker.failed")}</p>}
      {tickets.state.status === "ready" && (
        <div className="linear-import-picker-list">
          {(needle === "" || rootText.toLowerCase().includes(needle)) && <button type="button" onClick={() => onChoose(null)}>{rootText}</button>}
          {matches.map((entry) => (
            <button key={entry.id} type="button" onClick={() => onChoose(entry)}><span className="linear-import-key">{entry.key}</span> <span>{entry.title}</span></button>
          ))}
          {matches.length === 0 && needle !== "" && !rootText.toLowerCase().includes(needle) && <p className="import-muted">{t("linear.picker.empty")}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * "Última importação · há 2 dias": depois de uma importação concluída, as contagens dela e o botão "Reimportar agora". O destino
 * das issues novas não é perguntado (o servidor herda o da primeira rodada); um controle discreto abre o mesmo seletor.
 */
function ReimportCard({ client, projectId, run, last, startSync, categorize, onExit, onOpenTicket }: { client: ApiClient; projectId: string; run: RunHook; last: LinearRun; startSync: boolean; categorize: CategorizeHook; onExit: () => void; onOpenTicket: (ticketId: string) => void }) {
  const { t, i18n } = useTranslation("import");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const action = useAction();
  // `undefined`: herda (o corpo vai sem a chave); `null`: a raiz; um ticket: ele.
  const [destination, setDestination] = useState<TicketSummary | null | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const id = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const arranging = isCategorizing(categorize);
  const when = last.finishedAt === null ? "" : formatActivityTime(language, last.finishedAt, new Date());
  const reimport = async () => {
    await action.run(() => run.open(destination === undefined ? {} : { destinationTicketId: destination?.id ?? null }));
  };
  const closePanel = () => {
    setChoosing(false);
    setTimeout(() => opener.current?.focus(), 0);
  };
  // O botão "Sincronizar com o Linear" (ADR 0061) chega por `#linear-sync` e pede a rodada uma vez só: o endereço volta a `#linear`,
  // para recarregar a página não sincronizar de novo. Com a procura do lugar dos itens aberta o servidor recusaria: fica o cartão, com a explicação.
  const requested = useRef(false);
  useEffect(() => {
    // Espera a procura dizer se está aberta (a pergunta é rápida); aberta, o pedido se perde, não fica de espreita.
    if (!startSync || requested.current || categorize.load.status === "loading") return;
    requested.current = true;
    if (window.location.hash === "#linear-sync") window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#linear`);
    if (!arranging) void reimport();
  });
  return (
    <div className="linear-import-card">
      <h3>{when === "" ? t("linear.last.titleUndated") : t("linear.last.title", { when })}</h3>
      <RunSummary run={last} />
      <p className="linear-import-how">{t("linear.last.rule")}</p>
      <ArrangeBlock client={client} projectId={projectId} categorize={categorize} onOpenTicket={onOpenTicket} />
      {destination !== undefined && (
        <p className="linear-import-note">
          {t("linear.last.destination")}: {destination === null ? t("linear.root") : <><span className="linear-import-key">{destination.key}</span> <span>{destination.title}</span></>}
        </p>
      )}
      <div className="linear-import-actions">
        <button type="button" className="primary" disabled={action.busy || arranging} aria-describedby={arranging ? `${id}-blocked` : undefined} onClick={() => void reimport()}>{action.busy ? t("linear.starting") : t("linear.last.reimport")}</button>
        <button type="button" onClick={onExit}>{t("linear.done.openMap")}</button>
        {!choosing && <button ref={opener} type="button" className="text" aria-expanded={false} aria-controls={`${id}-picker`} onClick={() => setChoosing(true)}>{t("linear.last.changeDestination")}</button>}
      </div>
      {arranging && <p id={`${id}-blocked`} className="linear-import-how">{t("linear.categorize.reimportBlocked")}</p>}
      {choosing && (
        <DestinationPanel
          id={`${id}-picker`}
          client={client}
          projectId={projectId}
          onChoose={(ticket) => {
            setDestination(ticket);
            closePanel();
          }}
          onCancel={closePanel}
        />
      )}
      {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
    </div>
  );
}

function ProgressCard({ run, loop, onResume, onOpenSettings, onAbandon }: { run: LinearRun; loop: LoopState; onResume: () => void; onOpenSettings: () => void; onAbandon: RunHook["abandon"] }) {
  const { t, i18n } = useTranslation("import");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const phases = phasesOf(run);
  const at = phaseIndex(run);
  // O destino não serve mais: continuar não adianta, só abandonar. Três falhas seguidas também pedem esse caminho em destaque.
  const destinationInvalid = loop.kind === "stopped" && loop.error.code === "linear_destination_invalid";
  const prominent = destinationInvalid || run.errorStreak >= 3;
  const total = run.totalExpected !== null && run.totalExpected > 0 ? run.totalExpected : null;
  const done = Math.min(count(run, "issuesSeen"), total ?? Number.MAX_SAFE_INTEGER);
  const issuesPhase = phases.indexOf("issues");
  // Antes das issues a barra fica em zero; depois delas, cheia. Sem total ela é indeterminada.
  const value = total === null ? undefined : at > issuesPhase ? total : at < issuesPhase ? 0 : done;
  const numbers = (n: number) => formatNumber(language, n);
  const label = (phase: Phase): string => {
    const name = t(`linear.phase.${phase}`);
    const index = phases.indexOf(phase);
    if (phase === "projects" && index < at) return `${name} (${numbers(count(run, "projectsSeen"))})`;
    if (phase === "issues" && index < at) return `${name} (${numbers(count(run, "issuesSeen"))})`;
    if (phase === "issues" && index === at) return total === null ? `${name} (${numbers(done)})` : `${name} (${t("linear.progress", { done: numbers(done), total: numbers(total) })})`;
    return name;
  };
  return (
    <div className="linear-import-card" aria-busy={loop.kind === "running"}>
      <div className="linear-import-running">
        <h3>{run.mode === "reimport" ? t("linear.reimporting") : t("linear.running")}</h3>
        <span className="linear-import-count">{total !== null && at <= issuesPhase ? t("linear.progress", { done: numbers(done), total: numbers(total) }) : ""}</span>
        <span className="linear-import-close">{t("linear.canClose")}</span>
      </div>
      <div
        className={`linear-import-bar${value === undefined ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label={t("linear.bar")}
        aria-valuemin={0}
        {...(value === undefined || total === null ? {} : { "aria-valuemax": total, "aria-valuenow": value })}
      >
        <span style={value === undefined || total === null ? undefined : { width: `${Math.round((value / total) * 100)}%` }} />
      </div>
      <ol className="linear-import-phases" aria-label={t("linear.phase.list")}>
        {phases.map((phase, index) => {
          const state = index < at ? "done" : index === at ? "doing" : "todo";
          return (
            <li key={phase} data-state={state}>
              <span className="linear-import-mark" aria-hidden="true">{state === "done" ? "✓" : state === "doing" ? "●" : "○"}</span>
              <span>{label(phase)}</span>
              <span className="limp-sr"> — {t(`linear.phaseState.${state}`)}</span>
            </li>
          );
        })}
      </ol>
      {loop.kind === "waiting" && <p className="linear-import-note">{t("linear.waiting", { time: formatClock(language, loop.until) })}</p>}
      {loop.kind === "retrying" && (
        <div className="linear-import-problem">
          <p className="linear-import-note">{t("linear.retrying")}</p>
          <div className="linear-import-actions"><button type="button" onClick={onResume}>{t("linear.retry")}</button></div>
        </div>
      )}
      {loop.kind === "gave_up" && (
        <div className="linear-import-problem">
          <p role="alert" className="import-error-text">{t("linear.gaveUp")}</p>
          <div className="linear-import-actions"><button type="button" className="primary" onClick={onResume}>{t("linear.retry")}</button></div>
        </div>
      )}
      {loop.kind === "stopped" && (
        <div className="linear-import-problem">
          <p role="alert" className="import-error-text">{describeError(loop.error)}</p>
          <div className="linear-import-actions">
            {loop.error.code !== undefined && SETTINGS_CODES.has(loop.error.code) && <button type="button" onClick={onOpenSettings}>{t("linear.openSettings")}</button>}
            {!destinationInvalid && <button type="button" className="primary" onClick={onResume}>{t("linear.continue")}</button>}
          </div>
        </div>
      )}
      <AbandonControl
        prominent={prominent}
        onAbandon={onAbandon}
        text={{ button: t("linear.abandon.button"), confirmLabel: t("linear.abandon.confirmLabel"), confirmBody: t("linear.abandon.confirmBody"), confirm: t("linear.abandon.confirm"), back: t("linear.abandon.back") }}
      />
    </div>
  );
}

type RowKey = "created" | "existing" | "elsewhere" | "flattened" | "skipped" | "skippedInvalid" | "dueDatesInvalid" | "withoutDescription" | "movedOutOfIdea" | "new" | "updated" | "keptTouched" | "keptMoved" | "missing";

/**
 * As linhas do resumo. A primeira importação: criados sempre, o resto só maior que zero. A reimportação: novos e atualizados
 * sempre, o resto só maior que zero. As duas ganham "mantidos onde você os moveu" quando há.
 */
function summaryRows(run: LinearRun): { key: RowKey; value: number }[] {
  const reimport = run.mode === "reimport";
  const rows: { key: RowKey; value: number; always?: boolean }[] = reimport
    ? [
        { key: "new", value: count(run, "projectsCreated") + count(run, "issuesCreated"), always: true },
        { key: "updated", value: count(run, "updated"), always: true },
        { key: "keptTouched", value: count(run, "keptTouched") },
        { key: "keptMoved", value: count(run, "keptMoved") },
        { key: "missing", value: count(run, "missing") + count(run, "missingProjects") },
        { key: "elsewhere", value: count(run, "elsewhere") },
        { key: "flattened", value: count(run, "flattened") },
        { key: "skipped", value: count(run, "skipped") },
        { key: "skippedInvalid", value: count(run, "skippedInvalid") },
        { key: "dueDatesInvalid", value: count(run, "dueDatesInvalid") },
        { key: "movedOutOfIdea", value: count(run, "movedOutOfIdea") },
      ]
    : [
        { key: "created", value: count(run, "projectsCreated") + count(run, "issuesCreated"), always: true },
        { key: "existing", value: count(run, "projectsExisting") + count(run, "issuesExisting") },
        { key: "elsewhere", value: count(run, "projectsElsewhere") + count(run, "issuesElsewhere") },
        { key: "keptMoved", value: count(run, "keptMoved") },
        { key: "flattened", value: count(run, "flattened") },
        { key: "skipped", value: count(run, "skipped") },
        { key: "skippedInvalid", value: count(run, "skippedInvalid") },
        { key: "dueDatesInvalid", value: count(run, "dueDatesInvalid") },
        { key: "withoutDescription", value: count(run, "withoutDescription") },
        { key: "movedOutOfIdea", value: count(run, "movedOutOfIdea") },
      ];
  return rows.filter((row) => row.always === true || row.value > 0).map(({ key, value }) => ({ key, value }));
}

/** As contagens de uma rodada concluída e os avisos dela; serve ao resumo e ao cartão da última importação. */
function RunSummary({ run }: { run: LinearRun }) {
  const { t, i18n } = useTranslation("import");
  const language = i18n.language as Language;
  const shown = summaryRows(run);
  const reimport = run.mode === "reimport";
  return (
    <>
      <dl className="linear-import-counts" aria-label={t("linear.done.counts")}>
        {shown.map((row) => (
          <div key={row.key}>
            <dt>{t(`linear.done.${row.key}`)}</dt>
            <dd>{formatNumber(language, row.value)}</dd>
          </div>
        ))}
      </dl>
      {shown.some((row) => row.key === "flattened") && <p className="linear-import-how">{t("linear.done.flattenedNote")}</p>}
      {shown.some((row) => row.key === "skipped") && <p className="linear-import-how">{t("linear.done.skippedNote")}</p>}
      {count(run, "filled") > 0 && <p className="linear-import-note">{t("linear.done.filled", { count: count(run, "filled") })}</p>}
      {count(run, "commentsCreated") > 0 && <p className="linear-import-note">{t("linear.done.commentsCreated", { count: count(run, "commentsCreated") })}</p>}
      {count(run, "commentsKeptEdited") > 0 && <p className="linear-import-note">{t("linear.done.commentsKeptEdited", { count: count(run, "commentsKeptEdited") })}</p>}
      {count(run, "relationsCreated") > 0 && <p className="linear-import-note">{t("linear.done.relationsCreated", { count: count(run, "relationsCreated") })}</p>}
      {count(run, "relationsUpdated") > 0 && <p className="linear-import-note">{t("linear.done.relationsUpdated", { count: count(run, "relationsUpdated") })}</p>}
      {count(run, "relationsCycle") > 0 && <p className="linear-import-note">{t("linear.done.relationsCycle", { count: count(run, "relationsCycle") })}</p>}
      {count(run, "relationsTruncated") > 0 && <p className="linear-import-note linear-import-warning">{t("linear.done.relationsTruncated")}</p>}
      {count(run, "historyCreated") > 0 && <p className="linear-import-note">{t("linear.done.historyCreated", { count: count(run, "historyCreated") })}</p>}
      {count(run, "historyTruncated") > 0 && <p className="linear-import-note linear-import-warning">{t("linear.done.historyTruncated", { count: count(run, "historyTruncated") })}</p>}
      {run.counts["assigneeEmailUnavailable"] === true && <p className="linear-import-note linear-import-warning">{t(reimport ? "linear.done.assigneeEmailUnavailableReimport" : "linear.done.assigneeEmailUnavailable")}</p>}
      {run.counts["descriptionUnavailable"] === true && <p className="linear-import-note linear-import-warning">{t("linear.done.descriptionUnavailable")}</p>}
      {run.counts["missingNotChecked"] === true && <p className="linear-import-note linear-import-warning">{t("linear.done.missingNotChecked")}</p>}
    </>
  );
}

function SummaryCard({ client, projectId, run, categorize, onExit, onOpenTicket }: { client: ApiClient; projectId: string; run: LinearRun; categorize: CategorizeHook; onExit: () => void; onOpenTicket: (ticketId: string) => void }) {
  const { t } = useTranslation("import");
  return (
    <div className="linear-import-card">
      <h3>{run.mode === "reimport" ? t("linear.done.reimportTitle") : t("linear.done.title")}</h3>
      <RunSummary run={run} />
      <ArrangeBlock client={client} projectId={projectId} categorize={categorize} onOpenTicket={onOpenTicket} />
      <div className="linear-import-actions"><button type="button" className="primary" onClick={onExit}>{t("linear.done.openMap")}</button></div>
    </div>
  );
}
