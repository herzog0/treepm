import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, ApiError, CategorizeView, ToCheckItem } from "../api/client.js";
import { ConsentRequiredNotice } from "../api/ConsentRequired.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { formatClock, formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { viewHref } from "../nav/navigation.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { AbandonControl } from "./AbandonControl.js";
import type { useLinearCategorize } from "./useLinearCategorize.js";
import type { LoopState } from "./useLinearRun.js";

export type CategorizeHook = ReturnType<typeof useLinearCategorize>;

/** Enquanto a procura do lugar dos itens está aberta, reimportar fica de fora (o servidor também recusa). */
export const isCategorizing = (categorize: CategorizeHook): boolean => categorize.run !== null && !categorize.run.finished;

/** O que a procura anuncia na região de status: só o começo, a espera e o fim, nunca cada item. */
export function categorizeAnnouncement(categorize: CategorizeHook): "start" | "waiting" | "done" | "abandoned" | null {
  const run = categorize.run;
  if (run === null) return null;
  if (!run.finished) return categorize.loop.kind === "waiting" ? "waiting" : "start";
  if (!categorize.watched) return null;
  return run.phase === "failed" ? "abandoned" : "done";
}

interface ArrangeProps {
  client: ApiClient;
  projectId: string;
  categorize: CategorizeHook;
  onOpenTicket: (ticketId: string) => void;
}

/**
 * "Arrumar na árvore" (ADR 0060, seção 6): o que ainda cabe depois de importar. Os itens que vieram do Linear e ficaram onde a importação os pôs podem ser
 * colocados pela IA no lugar certo; na dúvida o item fica onde está e vai para "a conferir". O bloco só existe quando há algo a
 * fazer, uma procura a acompanhar, um resumo a mostrar ou itens a conferir.
 */
export function ArrangeBlock({ client, projectId, categorize, onOpenTicket }: ArrangeProps) {
  const { t } = useTranslation("import");
  const titleId = useId();
  if (categorize.load.status === "loading") return null;
  if (categorize.load.status === "error") {
    return (
      <section className="linear-categorize" aria-labelledby={titleId}>
        <h4 id={titleId}>{t("linear.categorize.title")}</h4>
        <ProblemLine error={categorize.load.error} onRetry={categorize.reload} />
      </section>
    );
  }
  const overview = categorize.overview;
  const run = categorize.run;
  if (overview === null) return null;
  const open = run !== null && !run.finished;
  const summary = run !== null && run.finished && categorize.watched;
  const toCheck = overview.toCheck;
  if (!open && !summary && overview.candidates === 0 && toCheck === 0) return null;
  return (
    <section className="linear-categorize" aria-labelledby={titleId}>
      <h4 id={titleId}>{t("linear.categorize.title")}</h4>
      {open && <CategorizeProgress run={run} loop={categorize.loop} onResume={categorize.resume} onAbandon={categorize.abandon} />}
      {!open && summary && <CategorizeSummary run={run} />}
      {!open && overview.candidates > 0 && <StartArrange categorize={categorize} candidates={overview.candidates} batchLimit={overview.batchLimit} reason={overview.reason} />}
      {!open && toCheck > 0 && <ToCheckSection client={client} projectId={projectId} count={toCheck} onChanged={categorize.refresh} onOpenTicket={onOpenTicket} />}
    </section>
  );
}

function ProblemLine({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  return (
    <div className="linear-import-problem">
      <p role="alert" className="import-error-text">{describeError(error)}</p>
      <div className="linear-import-actions"><button type="button" onClick={onRetry}>{t("linear.retry")}</button></div>
    </div>
  );
}

function StartArrange({ categorize, candidates, batchLimit, reason }: { categorize: CategorizeHook; candidates: number; batchLimit: number; reason: "assistant_not_configured" | "assistant_consent_required" | null }) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  const action = useAction();
  const { i18n } = useTranslation("import");
  const language = i18n.language as Language;
  const thisRound = Math.min(candidates, batchLimit);
  if (reason === "assistant_consent_required") return <ConsentRequiredNotice className="linear-import-note" text={t("linear.categorize.noConsent")} />;
  if (reason === "assistant_not_configured") return <p className="linear-import-note">{t("linear.categorize.notConfigured")}</p>;
  return (
    <>
      <p className="linear-import-note">{t("linear.categorize.intro", { count: candidates })}</p>
      {candidates > batchLimit && <p className="linear-import-note">{t("linear.categorize.batchNote", { total: formatNumber(language, candidates), limit: formatNumber(language, batchLimit) })}</p>}
      <div className="linear-import-actions">
        <button type="button" className="primary" disabled={action.busy} onClick={() => void action.run(() => categorize.open())}>
          {action.busy ? t("linear.starting") : t("linear.categorize.start", { count: thisRound })}
        </button>
      </div>
      <p className="linear-import-how">{t("linear.categorize.sends")}</p>
      {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
    </>
  );
}

function CategorizeProgress({ run, loop, onResume, onAbandon }: { run: CategorizeView; loop: LoopState; onResume: () => void; onAbandon: CategorizeHook["abandon"] }) {
  const { t, i18n } = useTranslation("import");
  const language = i18n.language as Language;
  const describeError = useDescribeApiError();
  const numbers = (n: number) => formatNumber(language, n);
  const total = Math.max(run.total, 1);
  const done = Math.min(run.done, total);
  const stoppedCode = loop.kind === "stopped" ? loop.error.code : undefined;
  return (
    <div className="linear-categorize-running" aria-busy={loop.kind === "running"}>
      <div className="linear-import-running">
        <h5>{t("linear.categorize.running")}</h5>
        <span className="linear-import-count">{t("linear.progress", { done: numbers(done), total: numbers(run.total) })}</span>
        <span className="linear-import-close">{t("linear.canClose")}</span>
      </div>
      <div className="linear-import-bar" role="progressbar" aria-label={t("linear.categorize.bar")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </div>
      <dl className="linear-import-counts" aria-label={t("linear.categorize.counts")}>
        <div><dt>{t("linear.categorize.moved")}</dt><dd>{numbers(run.placed)}</dd></div>
        <div><dt>{t("linear.categorize.toCheck")}</dt><dd>{numbers(run.toCheck)}</dd></div>
        <div><dt>{t("linear.categorize.kept")}</dt><dd>{numbers(run.kept)}</dd></div>
        {run.failed > 0 && <div><dt>{t("linear.categorize.failed")}</dt><dd>{numbers(run.failed)}</dd></div>}
      </dl>
      {loop.kind === "waiting" && <p className="linear-import-note">{t("linear.categorize.waiting", { time: formatClock(language, loop.until) })}</p>}
      {loop.kind === "retrying" && (
        <div className="linear-import-problem">
          <p className="linear-import-note">{t(run.lastErrorCode === "step_failed" ? "linear.categorize.retryingStepFailed" : run.lastErrorCode === "assistant_rate_limited" ? "linear.categorize.retryingRateLimited" : "linear.categorize.retrying")}</p>
          <div className="linear-import-actions"><button type="button" onClick={onResume}>{t("linear.retry")}</button></div>
        </div>
      )}
      {loop.kind === "gave_up" && (
        <div className="linear-import-problem">
          <p role="alert" className="import-error-text">{t("linear.categorize.gaveUp")}</p>
          <div className="linear-import-actions"><button type="button" className="primary" onClick={onResume}>{t("linear.retry")}</button></div>
        </div>
      )}
      {loop.kind === "stopped" && (
        <div className="linear-import-problem">
          {stoppedCode === "assistant_consent_required" ? (
            <ConsentRequiredNotice className="import-error-text" text={t("linear.categorize.noConsent")} />
          ) : stoppedCode === "assistant_not_configured" ? (
            <p role="alert" className="import-error-text">{t("linear.categorize.notConfigured")}</p>
          ) : (
            <p role="alert" className="import-error-text">{describeError(loop.error)}</p>
          )}
          <div className="linear-import-actions"><button type="button" className="primary" onClick={onResume}>{t("linear.continue")}</button></div>
        </div>
      )}
      <AbandonControl
        prominent={run.errorStreak > 2}
        onAbandon={onAbandon}
        text={{ button: t("linear.categorize.abandon.button"), confirmLabel: t("linear.categorize.abandon.confirmLabel"), confirmBody: t("linear.categorize.abandon.confirmBody"), confirm: t("linear.categorize.abandon.confirm"), back: t("linear.categorize.abandon.back") }}
      />
    </div>
  );
}

/** "7 movidos · 3 a conferir · 2 já no lugar · 1 falha": só o que for maior que zero. */
export function categorizeSummaryLine(run: CategorizeView, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (run.placed > 0) parts.push(t("linear.categorize.summary.moved", { count: run.placed }));
  if (run.toCheck > 0) parts.push(t("linear.categorize.summary.toCheck", { count: run.toCheck }));
  if (run.kept > 0) parts.push(t("linear.categorize.summary.kept", { count: run.kept }));
  if (run.failed > 0) parts.push(t("linear.categorize.summary.failed", { count: run.failed }));
  return parts.join(" · ");
}

/** O resumo da procura; "Abrir no mapa" fica no cartão que o contém (o da última importação ou o da conclusão). */
function CategorizeSummary({ run }: { run: CategorizeView }) {
  const { t } = useTranslation("import");
  const line = categorizeSummaryLine(run, t as never);
  return (
    <div className="linear-categorize-summary">
      <h5>{run.phase === "failed" ? t("linear.categorize.abandonedTitle") : t("linear.categorize.doneTitle")}</h5>
      <p className="linear-categorize-line">{line === "" ? t("linear.categorize.nothing") : line}</p>
    </div>
  );
}

function ToCheckSection({ client, projectId, count, onChanged, onOpenTicket }: { client: ApiClient; projectId: string; count: number; onChanged: () => void; onOpenTicket: (ticketId: string) => void }) {
  const { t } = useTranslation("import");
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="linear-categorize-check">
      <div className="linear-import-actions">
        <button type="button" aria-expanded={shown} aria-controls={`${id}-list`} onClick={() => setShown((value) => !value)}>
          {shown ? t("linear.categorize.check.hide") : t("linear.categorize.check.show", { count })}
        </button>
      </div>
      {shown && <ToCheckList id={`${id}-list`} client={client} projectId={projectId} onChanged={onChanged} onOpenTicket={onOpenTicket} />}
    </div>
  );
}

/** A lista "a conferir": relida ao abrir e ao voltar à tela (a pessoa pode ter movido ou conferido o item em outro lugar). */
function ToCheckList({ id, client, projectId, onChanged, onOpenTicket }: { id: string; client: ApiClient; projectId: string; onChanged: () => void; onOpenTicket: (ticketId: string) => void }) {
  const { t } = useTranslation("import");
  const list = useApiResource(() => safe(() => client.listLinearToCheck(projectId)));
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;
  useEffect(() => {
    const again = () => reloadRef.current();
    const visible = () => {
      if (document.visibilityState === "visible") again();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (list.state.status === "loading") return <p id={id} className="import-muted">{t("linear.categorize.check.loading")}</p>;
  if (list.state.status === "error") return <div id={id}><ProblemLine error={list.state.error} onRetry={list.retry} /></div>;
  const items = list.state.data.items;
  if (items.length === 0) return <p id={id} className="import-muted">{t("linear.categorize.check.empty")}</p>;
  return (
    <ul id={id} className="linear-categorize-list" aria-label={t("linear.categorize.check.list")}>
      {items.map((item) => (
        <ToCheckRow
          key={item.ticketId}
          item={item}
          client={client}
          projectId={projectId}
          onOpen={onOpenTicket}
          onDismissed={() => {
            list.update((current) => ({ items: current.items.filter((entry) => entry.ticketId !== item.ticketId) }));
            onChanged();
          }}
        />
      ))}
    </ul>
  );
}

function ToCheckRow({ item, client, projectId, onOpen, onDismissed }: { item: ToCheckItem; client: ApiClient; projectId: string; onOpen: (ticketId: string) => void; onDismissed: () => void }) {
  const { t } = useTranslation("import");
  const describeError = useDescribeApiError();
  const action = useAction();
  const href = viewHref("map", window.location.href, null, { ticketId: item.ticketId });
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    // Clique simples abre dentro da aplicação; com modificador (nova aba) o navegador faz o que sempre fez.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(item.ticketId);
  };
  const dismiss = async () => {
    const result = await action.run(() => client.dismissLinearToCheck(projectId, item.ticketId));
    if (result.ok) onDismissed();
  };
  return (
    <li className="linear-categorize-row">
      <a href={href} onClick={follow} className="linear-categorize-ticket">
        <span className="linear-import-key">{item.key}</span> <span>{item.title}</span>
      </a>
      <span className="linear-import-how">{item.suggestedPath.length > 0 ? t("linear.categorize.check.suggestion", { path: item.suggestedPath.map((step) => step.title).join(" › ") }) : t("linear.categorize.check.none")}</span>
      <button type="button" className="text" disabled={action.busy} onClick={() => void dismiss()}>{action.busy ? t("linear.categorize.check.dismissing") : t("linear.categorize.check.dismiss")}</button>
      {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
    </li>
  );
}
