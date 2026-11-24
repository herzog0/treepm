import type { PlacementDecision, PlacementOutcome, TicketSummary } from "../api/client.js";
import { ancestorsOf } from "../ticket/tree.js";
import { destinationUnder } from "./placement.js";

/**
 * O resultado da procura que a tela mostrava, remontado da decisão que o servidor guarda (só ids e números) e dos tickets do projeto:
 * a pergunta aberta (o nó, as opções com título e caminho) ou o destino confirmado. É o que a thread reaberta precisa para voltar ao
 * ponto em que estava. `null` quando a decisão não diz nada (nunca houve procura, é anterior à dúvida) ou já não bate com os tickets.
 */
export function outcomeFromDecision(decision: PlacementDecision | null, list: readonly TicketSummary[], project: { name: string }): PlacementOutcome | null {
  const doubt = decision?.doubt ?? null;
  if (decision === null || doubt === null) return null;
  const byId = new Map(list.map((ticket) => [ticket.id, ticket]));
  const base = { alternatives: [], discarded: [], uncertain: false, stoppedEarly: null, scope: null, groupProposal: null, groupProposalSkipped: null };
  const related = decision.related.flatMap((entry) => {
    const ticket = byId.get(entry.ticketId);
    return ticket ? [{ id: ticket.id, key: ticket.key, title: ticket.title, status: ticket.status, path: ancestorsOf(list, ticket).map((step) => ({ id: step.id, title: step.title })) }] : [];
  });
  const duplicateOf = decision.duplicateTicketId === null ? undefined : byId.get(decision.duplicateTicketId);
  const duplicate = duplicateOf ? { id: duplicateOf.id, key: duplicateOf.key, title: duplicateOf.title, status: duplicateOf.status } : null;
  const question = doubt.question;
  if (question !== null) {
    const at = destinationUnder(list, question.parentId);
    if (question.parentId !== null && !byId.has(question.parentId)) return null;
    const options = question.options.flatMap((option) => {
      const ticket = byId.get(option.ticketId);
      return ticket ? [{ id: ticket.id, title: ticket.title, path: [...ancestorsOf(list, ticket), ticket].map((step) => ({ id: step.id, title: step.title })) }] : [];
    });
    if (options.length === 0) return null;
    const title = question.parentId === null ? project.name : byId.get(question.parentId)!.title;
    return { ...base, question: { level: question.level, kind: question.kind, at: { id: question.parentId, title, path: at.path }, options }, destinationConfirmed: false, uncertain: true, destination: at, related, duplicate };
  }
  const last = decision.chosenPath.at(-1) ?? null;
  if (last !== null && !byId.has(last)) return null;
  return { ...base, question: null, destinationConfirmed: doubt.confirmed, destination: destinationUnder(list, last), related, duplicate };
}
