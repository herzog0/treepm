import type { ApiError, PlacementOutcome, Project } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { destinationLabel } from "./placement.js";
import type { Destination } from "./placement.js";

interface PathCardProps {
  project: Project;
  target: Destination;
  outcome: PlacementOutcome;
  /** O destino da IA e as alternativas dela. */
  options: readonly Destination[];
  draftTitle: string;
  canGoUp: boolean;
  choosing: boolean;
  pickNotice: string;
  busy: boolean;
  error: ApiError | null;
  whereStopped: (parentId: string | null) => string;
  /** O destino é um ticket que ainda não tem subtickets na árvore carregada (nunca a raiz do projeto). */
  targetIsLeaf: boolean;
  onUse: (destination: Destination) => void;
  onUp: () => void;
  onChoose: () => void;
  onCancelChoose: () => void;
  onCreate: () => void;
}

/** O caminho do topo até a base, em palavras: sem probabilidades (ADR 0029). */
export function PathCard(props: PathCardProps) {
  const { project, target, outcome, options, draftTitle, choosing, pickNotice } = props;
  const others = options.filter((option) => option.parentId !== target.parentId);
  const steps = [
    { name: project.name, note: target.path.length === 0 ? "Raiz do projeto" : "" },
    ...target.path.map((step) => ({ name: step.title, note: "" })),
    { name: `Ticket novo: ${draftTitle}`, note: "Entra aqui, como filho do passo anterior." },
  ];
  const stopped = outcome.stoppedEarly;

  return (
    <section className="assistant-card is-path" aria-label="Caminho encontrado">
      <h3>Caminho, do topo até a base</h3>
      <ol className="assistant-steps">
        {steps.map((step, position) => (
          <li key={position}>
            <span className="step-n" aria-hidden="true">{position + 1}</span>
            <span className="step-name">{step.name}</span>
            {step.note !== "" && <span className="step-note">{step.note}</span>}
          </li>
        ))}
      </ol>
      {props.targetIsLeaf && target.path.length > 0 && (
        <p className="assistant-notice">«{target.path.at(-1)?.title}» ainda não tem subtickets. O ticket novo será o primeiro.</p>
      )}
      {outcome.uncertain && (
        <p className="assistant-notice">Não tenho certeza do lugar: mais de um ramo serve. Escolha uma das opções abaixo, suba um nível ou use «Escolher no mapa».</p>
      )}
      {stopped && (
        <p className="assistant-notice">
          {stopped.reason === "candidates_too_large"
            ? `A procura parou em «${props.whereStopped(stopped.parentId)}» porque havia ramos demais para comparar de uma vez. Confira se o lugar serve ou escolha outro.`
            : `A procura parou em «${props.whereStopped(stopped.parentId)}» ao atingir o limite de níveis. Confira se o lugar serve ou escolha outro.`}
        </p>
      )}
      {others.length > 0 && (
        <>
          <p className="assistant-sub">Outros lugares possíveis</p>
          <ul className="assistant-alternatives">
            {others.map((option) => (
              <li key={option.parentId ?? "root"}>
                <button type="button" onClick={() => props.onUse(option)}>Usar: {destinationLabel(option)}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {choosing && (
        <p className="assistant-notice" role="status">Clique em um ticket ou no projeto, no mapa. Esc cancela.</p>
      )}
      {choosing && pickNotice !== "" && <p role="alert">{pickNotice}</p>}
      {props.error && <p role="alert">{describeApiError(props.error)}</p>}
      <div className="assistant-actions">
        <button type="button" className="primary" disabled={props.busy} onClick={props.onCreate}>Criar aqui</button>
        <button type="button" disabled={!props.canGoUp} onClick={props.onUp}>Um nível acima</button>
        {choosing ? (
          <button type="button" className="text" onClick={props.onCancelChoose}>Cancelar escolha</button>
        ) : (
          <button type="button" className="text" onClick={props.onChoose}>Escolher no mapa</button>
        )}
      </div>
    </section>
  );
}
