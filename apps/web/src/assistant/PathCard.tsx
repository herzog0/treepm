import type { ApiError, GroupProposal, PlacementOutcome, Project } from "../api/client.js";
import { useTranslation } from "react-i18next";
import { reopenWarningText } from "../ticket/reopen.js";
import { destinationLabel } from "./placement.js";
import type { Destination } from "./placement.js";
import { useDescribeApiError } from "../api/errorText.js";

interface PathCardProps {
  project: Project;
  target: Destination;
  outcome: PlacementOutcome;
  /** O destino da IA e as alternativas dela. */
  options: readonly Destination[];
  draftTitle: string;
  canGoUp: boolean;
  busy: boolean;
  error: ApiError | null;
  whereStopped: (parentId: string | null) => string;
  /** Chave do destino quando ele é um ticket concluído que será reaberto (ADR 0034); `null` nos outros casos. */
  reopensKey: string | null;
  /** O ticket de escopo que o resultado diz não caber; `null` quando não há aviso. */
  outOfScope: { title: string } | null;
  onWholeProject: () => void;
  onUse: (destination: Destination) => void;
  onUp: () => void;
  onChoose: () => void;
  onCreate: () => void;
  /** A proposta de ticket pai novo (ADR 0031, ADR 0034) enquanto o destino é o da procura; `null` quando não há ou foi descartada. */
  proposal: GroupProposal | null;
  /** Ids dos tickets da proposta que a pessoa tirou da lista. */
  unchecked: readonly string[];
  onToggle: (ticketId: string) => void;
  onCreateGroup: () => void;
  /** Quantas partes (filhos) o rascunho tem; elas nascem dentro do ticket (ADR 0044). */
  parts: number;
  /** A prévia recusa a criação: os botões de criar ficam desabilitados. */
  createBlocked: boolean;
}

/** O caminho do topo até a base, em palavras: sem probabilidades (ADR 0029). */
export function PathCard(props: PathCardProps) {
  const describeError = useDescribeApiError();
  const { t } = useTranslation("assistant");
  const { t: tTicket } = useTranslation("ticket");
  const { project, target, outcome, options, draftTitle, busy } = props;
  const others = options.filter((option) => option.parentId !== target.parentId);
  const steps = [
    { name: project.name, note: target.path.length === 0 ? t("path.root") : "" },
    ...target.path.map((step) => ({ name: step.title, note: "" })),
    { name: t("path.newTicket", { title: draftTitle }), note: t("path.entersHere") },
  ];
  const stopped = outcome.stoppedEarly;
  const { proposal } = props;
  // A última marcada não desmarca: o ticket pai novo precisa de pelo menos um ticket filho além do ticket novo.
  const checkedCount = proposal ? proposal.tickets.filter((ticket) => !props.unchecked.includes(ticket.id)).length : 0;

  return (
    <section className="assistant-card is-path" aria-label={t("path.region")}>
      <h3>{t("path.heading")}</h3>
      <ol className="assistant-steps">
        {steps.map((step, position) => (
          <li key={position}>
            <span className="step-n" aria-hidden="true">{position + 1}</span>
            <span className="step-name">{step.name}</span>
            {step.note !== "" && <span className="step-note">{step.note}</span>}
          </li>
        ))}
      </ol>
      {props.parts > 0 && <p className="assistant-notice">{t("path.partsNote", { count: props.parts })}</p>}
      {props.reopensKey !== null && <p className="assistant-notice" role="status">{reopenWarningText(tTicket, props.reopensKey)}</p>}
      {proposal && (
        <div className="assistant-proposal">
          <p className="proposal-line">{t("proposal.line")}</p>
          <p className="proposal-title">{proposal.title}</p>
          {proposal.description !== "" && <p className="proposal-description">{proposal.description}</p>}
          <ul className="proposal-tickets" aria-label={t("proposal.list")}>
            {proposal.tickets.map((ticket) => {
              const checked = !props.unchecked.includes(ticket.id);
              return (
                <li key={ticket.id}>
                  <label>
                    <input type="checkbox" checked={checked} disabled={busy || (checked && checkedCount === 1)} onChange={() => props.onToggle(ticket.id)} />
                    {ticket.title}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="proposal-actions">
            <button type="button" disabled={busy || props.createBlocked} onClick={props.onCreateGroup}>{t("proposal.create")}</button>
          </div>
        </div>
      )}
      {props.outOfScope && (
        <p className="assistant-notice" role="status">
          {t("path.outOfScope", { title: props.outOfScope.title })}{" "}
          <button type="button" className="text" disabled={busy} onClick={props.onWholeProject}>{t("scope.wholeProject")}</button>
        </p>
      )}
      {outcome.uncertain && (
        <p className="assistant-notice">{t("path.uncertain")}</p>
      )}
      {stopped && (
        <p className="assistant-notice">
          {t(stopped.reason === "candidates_too_large" ? "path.stopped.candidates_too_large" : "path.stopped.max_levels", { where: props.whereStopped(stopped.parentId) })}
        </p>
      )}
      {others.length > 0 && (
        <>
          <p className="assistant-sub">{t("path.otherPlaces")}</p>
          <ul className="assistant-alternatives">
            {others.map((option) => (
              <li key={option.parentId ?? "root"}>
                <button type="button" onClick={() => props.onUse(option)}>{t("path.use", { label: destinationLabel(t, option) })}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.error && <p role="alert">{describeError(props.error)}</p>}
      <div className="assistant-actions">
        <button type="button" className="primary" disabled={busy || props.createBlocked} onClick={props.onCreate}>{props.parts > 0 ? t("path.createWithParts", { count: props.parts }) : t("path.create")}</button>
        <button type="button" disabled={!props.canGoUp} onClick={props.onUp}>{t("path.up")}</button>
        <button type="button" className="text" onClick={props.onChoose}>{t("pick.choose")}</button>
      </div>
    </section>
  );
}
