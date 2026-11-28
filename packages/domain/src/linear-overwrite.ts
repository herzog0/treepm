/**
 * "Sobrescrever com o Linear" (ADR 0066), puro. Com a opção da rodada ligada, o valor do Linear, já mapeado, vence o valor ATUAL do
 * ticket, mexido aqui ou não: a comparação é com o atual, não com o retrato (o caso comum é o campo mexido aqui sem mudança no Linear,
 * em que "mudou no Linear" é falso para sempre). `overwritten` diz que a regra de sempre (ADR 0060, seção 5; ADR 0061, seção 2) teria
 * mantido o daqui: é o que conta na contagem `overwritten` da rodada.
 */
import { decideLinearTicketLabels } from "./linear-labels.js";
import type { LinearTicketLabelRef, LinearTicketLabelsDecision, LinearTicketLabelsInput } from "./linear-labels.js";
import { decideLinearStatus, sameLinearValue } from "./linear-reimport.js";
import type { LinearStatusDecision } from "./linear-reimport.js";
import { planLinearParents } from "./linear-import.js";
import type { LinearParentMove } from "./linear-import.js";

/** Um campo de valor único (título, descrição, prioridade, prazo, responsáveis). `regularApply`: o que a regra de sempre decidiu. */
export function decideLinearOverwrite<I, C = I>(input: { overwrite: boolean; incoming: I; current: C; regularApply: boolean }): { apply: boolean; overwritten: boolean } {
  if (!input.overwrite) return { apply: input.regularApply, overwritten: false };
  const differs = !sameLinearValue(input.incoming, input.current);
  return { apply: differs, overwritten: differs && !input.regularApply };
}

/**
 * A situação com a opção: o ticket mexido aqui é avaliado como se não tivesse sido (assume a do Linear), mas as regras da árvore
 * continuam valendo (dentro de ideia; concluído com dependência "para entregar" aberta): aí fica como está, em desvio, como o não
 * mexido. O pai (ADR 0068) tem a situação calculada pelos filhos: a opção não se aplica a ela.
 */
export function decideLinearStatusOverwrite(input: Parameters<typeof decideLinearStatus>[0]): LinearStatusDecision & { overwritten: boolean } {
  if (input.derived) return { ...decideLinearStatus(input), overwritten: false };
  const touchedHere = input.current !== input.applied;
  if (!touchedHere) return { ...decideLinearStatus(input), overwritten: false };
  const decision = decideLinearStatus({ ...input, applied: input.current });
  return { ...decision, touchedHere, overwritten: decision.outcome === "apply" };
}

/**
 * As etiquetas do ticket com a opção: a do Linear tirada aqui (com marca de "removida aqui" ou sem) volta e a marca sai (`restoreRefs`);
 * a que saiu no Linear sai, mesmo a adotada (já estava aqui quando a origem a reconheceu). A etiqueta sem origem no Linear fica, e a
 * apagada aqui no catálogo (resolve nulo) não renasce. O resto é a regra de sempre.
 */
export function decideLinearTicketLabelsOverwrite(input: LinearTicketLabelsInput): LinearTicketLabelsDecision & { restoreRefs: string[]; overwritten: boolean } {
  const regular = decideLinearTicketLabels(input);
  const wanted = new Set(input.linearLabelIds);
  const current = new Set(input.current);
  const restoreRefs: string[] = [];
  const refs: LinearTicketLabelRef[] = input.refs.map((ref) => {
    const local = input.resolve.get(ref.linearLabelId);
    if (wanted.has(ref.linearLabelId) && local !== undefined && local !== null) {
      if (ref.removedHere) {
        restoreRefs.push(ref.linearLabelId);
        return { ...ref, localId: null, removedHere: false };
      }
      if (ref.localId !== null && !current.has(ref.localId)) return { ...ref, localId: null };
      return ref;
    }
    if (!wanted.has(ref.linearLabelId) && ref.adopted) return { ...ref, adopted: false };
    return ref;
  });
  const decision = decideLinearTicketLabels({ ...input, refs });
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => sameLinearValue([...a], [...b]);
  const overwritten = !sameSet(decision.add, regular.add) || !sameSet(decision.remove, regular.remove);
  const revived = new Set(decision.reviveRefs.map((ref) => ref.linearLabelId));
  return { ...decision, restoreRefs: restoreRefs.filter((id) => revived.has(id)), overwritten };
}

/**
 * O plano de hierarquia com a opção (ADR 0066): `planLinearParents` aplica os pedidos em ordem, então um filho pedido antes do pai
 * que está invertido aqui cai em ciclo. Os pulados são refeitos sobre a floresta já com os movimentos planejados, até não haver
 * progresso; o ciclo de verdade continua pulado. Os movimentos saem na ordem em que podem ser aplicados um a um.
 */
export function planLinearParentsConverging(
  forest: ReadonlyMap<string, string | null>,
  requests: readonly { readonly id: string; readonly parentId: string }[],
  maxDepth: number,
): { moves: LinearParentMove[]; skipped: string[] } {
  let plan = planLinearParents(forest, requests, maxDepth);
  for (let round = 0; round < requests.length && plan.skipped.length > 0; round += 1) {
    const simulated = new Map(forest);
    for (const move of plan.moves) simulated.set(move.id, move.parentId);
    const retry = new Set(plan.skipped);
    const next = planLinearParents(simulated, requests.filter((request) => retry.has(request.id)), maxDepth);
    if (next.moves.length === 0) break;
    plan = { moves: [...plan.moves, ...next.moves], skipped: next.skipped };
  }
  return plan;
}
