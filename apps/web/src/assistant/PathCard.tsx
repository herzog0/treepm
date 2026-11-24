import { useEffect, useRef } from "react";
import type { ApiError, GroupProposal, PlacementOutcome, Project } from "../api/client.js";
import { useTranslation } from "react-i18next";
import { situationColor } from "../chat/situation.js";
import { reopenWarningText } from "../ticket/reopen.js";
import { destinationLabel } from "./placement.js";
import type { Destination, PlaceChoice } from "./placement.js";
import { useDescribeApiError } from "../api/errorText.js";

/** A pergunta sobre o lugar (ADR 0054, adendo): aparece no lugar do destino enquanto está aberta. */
export interface QuestionView {
  /** Onde a dúvida está: o nó da pergunta (`null` na raiz) e o caminho até ele. */
  at: { id: string | null; title: string; path: readonly { id: string; title: string }[] };
  options: readonly PlaceChoice[];
  recents: readonly PlaceChoice[];
}

interface PathCardProps {
  project: Project;
  /** `null` só enquanto `question` está aberta: não há destino. */
  target: Destination | null;
  question?: QuestionView | null;
  /** Muda a cada procura: leva o foco ao cabeçalho da pergunta quando ela aparece ou é trocada. */
  questionKey?: number;
  onAnswer?: (choice: PlaceChoice, kind: "option" | "recent") => void;
  onStay?: () => void;
  /** A pessoa já respondeu três vezes e a procura ainda tem dúvida: o destino é o último ramo que ela confirmou. */
  limitReached?: boolean;
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
  /** Sem mapa montado (a pessoa está em outra tela) não há onde escolher: o botão não aparece. */
  onChoose?: () => void;
  onCreate: () => void;
  /** A proposta de ticket pai novo (ADR 0031, ADR 0034) enquanto o destino é o da procura; `null` quando não há ou foi descartada. */
  proposal: GroupProposal | null;
  /** Ids dos tickets da proposta que a pessoa tirou da lista. */
  unchecked: readonly string[];
  onToggle: (ticketId: string) => void;
  onCreateGroup: () => void;
  /** Quantas partes (filhos) o rascunho tem; elas nascem dentro do ticket (ADR 0044). */
  parts: number;
  /** O que nasce aqui é uma ideia (a opção ligada e o lugar fora de uma ideia): o card e o botão dizem isso. */
  idea: boolean;
  /** A prévia recusa a criação: os botões de criar ficam desabilitados. */
  createBlocked: boolean;
  /** A elaboração ainda carrega (ADR 0052, item 4): criar espera por ela, ou a pessoa escolhe criar sem ela. */
  waiting?: boolean;
  onCreateNow?: () => void;
  /** O ticket de uma opção (a chave e a bolinha da situação); sem ele a opção mostra só o título e o caminho. */
  ticketOf?: (id: string) => { key: string; status: string; blocked?: boolean } | undefined;
}

/** O caminho do topo até a base, em palavras: sem probabilidades (ADR 0029). */
export function PathCard(props: PathCardProps) {
  const describeError = useDescribeApiError();
  const { t } = useTranslation("assistant");
  const { t: tTicket } = useTranslation("ticket");
  const { project, target, question, outcome, options, draftTitle, busy } = props;
  const others = target === null ? [] : options.filter((option) => option.parentId !== target.parentId);
  const steps = target === null ? [] : [
    { name: project.name, note: target.path.length === 0 ? t("path.root") : "" },
    ...target.path.map((step) => ({ name: step.title, note: "" })),
    { name: t(props.idea ? "path.newIdea" : "path.newTicket", { title: draftTitle }), note: t("path.entersHere") },
  ];
  const asking = question != null;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (asking) heading.current?.focus();
  }, [asking, props.questionKey]);
  const stopped = outcome.stoppedEarly;
  const { proposal } = props;
  // A última marcada não desmarca: o ticket pai novo precisa de pelo menos um ticket filho além do ticket novo.
  const checkedCount = proposal ? proposal.tickets.filter((ticket) => !props.unchecked.includes(ticket.id)).length : 0;

  return (
    <section className="assistant-card is-path" aria-label={t("path.region")}>
      {question ? (
        <div className="assistant-question">
          <h3 ref={heading} tabIndex={-1}>{t("question.heading")}</h3>
          <p className="assistant-question-at">{t("question.at", { where: question.at.path.length === 0 ? project.name : question.at.path.map((step) => step.title).join(" › ") })}</p>
          <ul className="assistant-choices" aria-label={t("question.options")}>
            {question.options.map((choice) => (
              <li key={choice.id}><ChoiceButton choice={choice} ticket={props.ticketOf?.(choice.id)} disabled={busy} onClick={() => props.onAnswer?.(choice, "option")} /></li>
            ))}
            {question.options.length > 0 && <li role="separator" className="assistant-choice-rule" />}
            <li>
              <button type="button" className="assistant-choice assistant-stay" disabled={busy} onClick={props.onStay}>
                {question.at.id === null ? t("question.stayRoot") : t("question.stay", { title: question.at.title })}
              </button>
            </li>
          </ul>
          {question.recents.length > 0 && (
            <>
              <p className="assistant-sub">{t("question.recent")}</p>
              <ul className="assistant-choices" aria-label={t("question.recent")}>
                {question.recents.map((choice) => (
                  <li key={choice.id}><ChoiceButton choice={choice} ticket={props.ticketOf?.(choice.id)} disabled={busy} onClick={() => props.onAnswer?.(choice, "recent")} /></li>
                ))}
              </ul>
            </>
          )}
          {props.onChoose && <button type="button" className="assistant-choice is-map" disabled={busy} onClick={props.onChoose}>{t("question.map")}</button>}
        </div>
      ) : (
        <>
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
        </>
      )}
      {props.idea && <p className="assistant-notice">{t("path.ideaNote")}</p>}
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
            <button type="button" disabled={busy || props.createBlocked || props.waiting === true} onClick={props.onCreateGroup}>{t("proposal.create")}</button>
          </div>
        </div>
      )}
      {props.outOfScope && (
        <p className="assistant-notice" role="status">
          {t("path.outOfScope", { title: props.outOfScope.title })}{" "}
          <button type="button" className="text" disabled={busy} onClick={props.onWholeProject}>{t("scope.wholeProject")}</button>
        </p>
      )}
      {props.limitReached && <p className="assistant-notice" role="status">{t("question.limit")}</p>}
      {outcome.uncertain && outcome.question === null && !asking && (
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
      {asking && <p className="assistant-hint" role="status">{busy ? t("draft.searching") : t("question.needsPlace")}</p>}
      {!asking && <div className="assistant-actions">
        <button type="button" className="primary" data-assistant-create disabled={busy || props.createBlocked || props.waiting === true} onClick={props.onCreate}>{props.waiting === true ? t("elaboration.waiting") : props.idea ? (props.parts > 0 ? t("path.createIdeaWithParts", { count: props.parts }) : t("path.createIdea")) : props.parts > 0 ? t("path.createWithParts", { count: props.parts }) : t("path.create")}</button>
        {props.waiting === true && props.onCreateNow && <button type="button" className="text" disabled={busy || props.createBlocked} onClick={props.onCreateNow}>{t("elaboration.createNow")}</button>}
        <button type="button" disabled={!props.canGoUp} onClick={props.onUp}>{t("path.up")}</button>
        {props.onChoose && <button type="button" className="text" onClick={props.onChoose}>{t("pick.choose")}</button>}
      </div>}
    </section>
  );
}

/** Uma opção da pergunta: o título e, em letra menor, onde ela está (os ancestrais; um ticket de topo não tem linha de caminho). */
function ChoiceButton({ choice, ticket, disabled, onClick }: { choice: PlaceChoice; ticket?: { key: string; status: string; blocked?: boolean }; disabled: boolean; onClick: () => void }) {
  return (
    // A chave vai no `data-key` e é pintada por CSS: o nome do botão continua sendo o título e o caminho (o que as telas e os leitores de tela já liam).
    <button type="button" className="assistant-choice" disabled={disabled} onClick={onClick}>
      {ticket && <span className="choice-dot" aria-hidden="true" style={{ background: situationColor(ticket) }} />}
      <span className="choice-text">
        <span className="choice-title" data-key={ticket?.key}>{choice.title}</span>
        {choice.path.length > 1 && <small className="choice-path">{choice.path.slice(0, -1).map((step) => step.title).join(" › ")}</small>}
      </span>
    </button>
  );
}
