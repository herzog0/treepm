import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ApiClient, LinearTeam, Me, Project } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import "./linear.css";

/** O que o diálogo conta ao fechar: se ligou, e se o que a tela mostrava ficou velho (o time já tinha dono, o projeto já tinha origem). */
export interface LinkResult {
  linked: boolean;
  stale: boolean;
}

/** Códigos em que o servidor diz que a lista de times da tela está desatualizada. */
const STALE_CODES = new Set(["linear_team_in_use", "linear_already_linked", "linear_team_not_found", "linear_not_connected"]);
/** Quantos projetos se consultam ao mesmo tempo: cada leitura pode ir ao Linear no servidor. */
const BATCH = 4;
const FOCUSABLE = 'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Candidates = { status: "loading" } | { status: "error" } | { status: "ready"; projects: Project[] };

/** Os projetos que a pessoa administra, ativos e ainda sem origem. Só se consulta ao abrir o diálogo, nunca na montagem da seção. */
async function findCandidates(client: ApiClient, me: Me): Promise<Candidates> {
  const listed = await safe(() => client.listProjects());
  if (!listed.ok) return { status: "error" };
  const isAdmin = me.roles.clerk === "admin";
  const managed = new Set(me.roles.projects.filter((entry) => entry.role === "manager").map((entry) => entry.projectId));
  const mine = listed.data.filter((project) => project.archivedAt === null && (isAdmin || managed.has(project.id)));
  const eligible: Project[] = [];
  for (let at = 0; at < mine.length; at += BATCH) {
    const batch = mine.slice(at, at + BATCH);
    const answers = await Promise.all(batch.map((project) => safe(() => client.getProjectLinear(project.id))));
    answers.forEach((answer, index) => {
      if (answer.ok && answer.data.source === null && answer.data.canLink) eligible.push(batch[index]!);
    });
  }
  return { status: "ready", projects: eligible };
}

/**
 * A confirmação dupla da ligação permanente (ADR 0060, seção 2): escolher o projeto, ler o aviso e digitar a chave do time.
 * Diálogo modal: o foco fica preso nele, Esc cancela e o foco volta a quem o abriu (o `onClose` da tela cuida disso).
 */
export function LinearLinkDialog({ client, me, team, workspaceName, onClose }: { client: ApiClient; me: Me; team: LinearTeam; workspaceName: string; onClose: (result: LinkResult) => void }) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [candidates, setCandidates] = useState<Candidates>({ status: "loading" });
  const [projectId, setProjectId] = useState("");
  const [typed, setTyped] = useState("");
  const [stale, setStale] = useState(false);
  const link = useAction();

  useEffect(() => {
    let active = true;
    void findCandidates(client, me).then((found) => {
      if (!active) return;
      setCandidates(found);
      if (found.status === "ready" && found.projects.length === 1) setProjectId(found.projects[0]!.id);
    });
    return () => {
      active = false;
    };
  }, [client, me]);

  // O foco entra no diálogo ao abrir (no próprio diálogo enquanto carrega) e vai ao primeiro campo quando os projetos chegam.
  const ready = candidates.status !== "loading";
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const first = ready ? box.querySelector<HTMLElement>(FOCUSABLE) : null;
    (first ?? box).focus();
  }, [ready]);

  const project = candidates.status === "ready" ? candidates.projects.find((entry) => entry.id === projectId) : undefined;
  const matches = project !== undefined && typed.trim().toLocaleLowerCase() === team.key.toLocaleLowerCase();
  const close = (linked: boolean) => onClose({ linked, stale });

  const submit = async () => {
    if (!matches || link.busy) return;
    const result = await link.run(() => client.linkProjectToLinear(project.id, { teamId: team.id, confirmTeamKey: typed.trim() }));
    if (result.ok) close(true);
    else if (result.error.code !== undefined && STALE_CODES.has(result.error.code)) setStale(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!link.busy) close(false);
      return;
    }
    if (event.key !== "Tab") return;
    const box = boxRef.current!;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0] ?? box;
    const last = items.at(-1) ?? box;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === box)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === box)) {
      event.preventDefault();
      first.focus();
    }
  };

  const title = project ? t("linear.dialog.title", { project: project.name, team: team.name }) : t("linear.dialog.titleNoProject", { team: team.name });
  return createPortal(
    <div className="linear-dialog">
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-warning`} tabIndex={-1} className="linear-dialog-box" onKeyDown={onKeyDown}>
        <h2 id={`${id}-title`}>{title}</h2>
        {candidates.status === "loading" && <p role="status" className="linear-dialog-note">{t("linear.dialog.loading")}</p>}
        {candidates.status === "error" && <p role="alert" className="linear-dialog-note linear-dialog-error">{t("linear.dialog.loadFailed")}</p>}
        {candidates.status === "ready" && candidates.projects.length === 0 && <p className="linear-dialog-note">{t("linear.dialog.none")}</p>}
        {candidates.status === "ready" && candidates.projects.length > 0 && (
          <>
            <dl className="linear-summary">
              <dt><label htmlFor={`${id}-project`}>{t("linear.dialog.pick")}</label></dt>
              <dd>
                <select id={`${id}-project`} value={projectId} disabled={link.busy} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">{t("linear.dialog.pickPlaceholder")}</option>
                  {candidates.projects.map((entry) => (
                    <option key={entry.id} value={entry.id}>{`${entry.key} · ${entry.name}`}</option>
                  ))}
                </select>
              </dd>
              <dt>{t("linear.dialog.workspace")}</dt>
              <dd>{workspaceName}</dd>
              <dt>{t("linear.dialog.team")}</dt>
              <dd><span className="linear-key">{team.key}</span> {team.name}</dd>
            </dl>
            <div className="linear-warning" id={`${id}-warning`}>
              <strong>{t("linear.dialog.warningTitle")}</strong> {t("linear.dialog.warningBody")}
            </div>
            <label className="linear-confirm" htmlFor={`${id}-confirm`}>
              {t("linear.dialog.confirm")} <strong className="linear-key">{team.key}</strong>
            </label>
            <input
              id={`${id}-confirm`}
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="linear-mono"
              value={typed}
              disabled={link.busy}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {link.error && <p role="alert" className="linear-dialog-error">{describeError(link.error)}</p>}
          </>
        )}
        <div className="linear-dialog-actions">
          <button type="button" disabled={link.busy} onClick={() => close(false)}>
            {candidates.status === "ready" && candidates.projects.length > 0 ? t("linear.dialog.cancel") : t("linear.dialog.close")}
          </button>
          {candidates.status === "ready" && candidates.projects.length > 0 && (
            <button type="button" className="primary" disabled={!matches || link.busy} onClick={() => void submit()}>
              {link.busy ? t("linear.dialog.submitting") : t("linear.dialog.submit")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
