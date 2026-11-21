import type { ApiError, GroupProposal, PlacementOutcome, Project } from "../api/client.js";
import { reopenWarning } from "../ticket/reopen.js";
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
  choosing: boolean;
  pickNotice: string;
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
  onCancelChoose: () => void;
  onCreate: () => void;
  /** A proposta de ticket pai novo (ADR 0031, ADR 0034) enquanto o destino é o da procura; `null` quando não há ou foi descartada. */
  proposal: GroupProposal | null;
  /** Ids dos tickets da proposta que a pessoa tirou da lista. */
  unchecked: readonly string[];
  onToggle: (ticketId: string) => void;
  onCreateGroup: () => void;
}

/** O caminho do topo até a base, em palavras: sem probabilidades (ADR 0029). */
export function PathCard(props: PathCardProps) {
  const describeError = useDescribeApiError();
  const { project, target, outcome, options, draftTitle, choosing, pickNotice, busy } = props;
  const others = options.filter((option) => option.parentId !== target.parentId);
  const steps = [
    { name: project.name, note: target.path.length === 0 ? "Raiz do projeto" : "" },
    ...target.path.map((step) => ({ name: step.title, note: "" })),
    { name: `Ticket novo: ${draftTitle}`, note: "Entra aqui, como filho do passo anterior." },
  ];
  const stopped = outcome.stoppedEarly;
  const { proposal } = props;
  // A última marcada não desmarca: o ticket pai novo precisa de pelo menos um ticket filho além do ticket novo.
  const checkedCount = proposal ? proposal.tickets.filter((ticket) => !props.unchecked.includes(ticket.id)).length : 0;

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
      {props.reopensKey !== null && <p className="assistant-notice" role="status">{reopenWarning(props.reopensKey)}</p>}
      {proposal && (
        <div className="assistant-proposal">
          <p className="proposal-line">Este ticket parece formar um grupo com outros daqui.</p>
          <p className="proposal-title">{proposal.title}</p>
          {proposal.description !== "" && <p className="proposal-description">{proposal.description}</p>}
          <ul className="proposal-tickets" aria-label="Tickets que vão para o ticket pai novo">
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
            <button type="button" disabled={busy} onClick={props.onCreateGroup}>Criar ticket pai e mover</button>
          </div>
        </div>
      )}
      {props.outOfScope && (
        <p className="assistant-notice" role="status">
          Este ticket talvez não caiba em «{props.outOfScope.title}».{" "}
          <button type="button" className="text" disabled={busy} onClick={props.onWholeProject}>Procurar no projeto inteiro</button>
        </p>
      )}
      {outcome.uncertain && (
        <p className="assistant-notice">Não tenho certeza do lugar: mais de um ticket serve. Escolha uma das opções abaixo, suba um nível ou use «Escolher no mapa».</p>
      )}
      {stopped && (
        <p className="assistant-notice">
          {stopped.reason === "candidates_too_large"
            ? `A procura parou em «${props.whereStopped(stopped.parentId)}» porque havia tickets demais para comparar de uma vez. Confira se o lugar serve ou escolha outro.`
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
      {props.error && <p role="alert">{describeError(props.error)}</p>}
      <div className="assistant-actions">
        <button type="button" className="primary" disabled={busy} onClick={props.onCreate}>Criar aqui</button>
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
