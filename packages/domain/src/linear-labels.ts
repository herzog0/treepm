/**
 * Etiquetas do Linear no ticket (ADR 0065, seção 5; ADR 0061, seção 3): a regra das coisas que são muitas por ticket, decidida por item
 * a partir do conjunto COMPLETO de etiquetas da issue (`labelIds`), das origens já gravadas e do que o ticket tem hoje. Função pura: quem
 * chama grava. Sem mudança, devolve listas vazias (a sincronização quieta não escreve nada).
 */
import { LABELS_PER_TICKET } from "./labels.js";
import type { LabelColor } from "./labels.js";

/** A origem de um vínculo ticket↔etiqueta do Linear (`external_item_refs`, tipo `label`). `localId` nulo: tirada no Linear ou aqui. */
export type LinearTicketLabelRef = { linearLabelId: string; localId: string | null; removedHere: boolean; adopted: boolean };

export type LinearTicketLabelsInput = {
  /** O conjunto completo de etiquetas da issue no Linear (ids de lá). */
  linearLabelIds: readonly string[];
  /** Etiqueta do Linear → etiqueta daqui; `null` = apagada aqui (não renasce) ou fora do limite do projeto; ausente = não lida. */
  resolve: ReadonlyMap<string, string | null>;
  refs: readonly LinearTicketLabelRef[];
  /** As etiquetas do ticket hoje (ids daqui). */
  current: readonly string[];
};

export type LinearTicketLabelsDecision = {
  /** Etiquetas daqui a pôr no ticket, na ordem do Linear. */
  add: string[];
  /** Etiquetas daqui a tirar do ticket (tiradas no Linear, vindas de lá). */
  remove: string[];
  createRefs: { linearLabelId: string; localId: string; adopted: boolean }[];
  /**
   * Origens que voltam a apontar (tiradas no Linear e postas de novo lá), com `adopted` recalculado pelo estado de AGORA: a etiqueta já
   * estava no ticket (posta por alguém daqui) = adotada; senão, veio de lá. O `adopted` de antes do esquecimento não vale mais.
   */
  reviveRefs: { linearLabelId: string; localId: string; adopted: boolean }[];
  /** Origens que esquecem a etiqueta daqui (tirada no Linear). */
  forgetRefs: string[];
  /** Origens cuja etiqueta sumiu do ticket por um caminho que não marcou: passam a "removida aqui". */
  markRemovedHere: string[];
  /** Etiquetas que não entraram pelo limite de 20 por ticket. */
  overLimit: number;
  /** Etiquetas do Linear sem nó lido nem origem conhecida: não lidas nesta rodada (nada é removido por causa delas). */
  unresolved: number;
};

export function decideLinearTicketLabels(input: LinearTicketLabelsInput): LinearTicketLabelsDecision {
  const out: LinearTicketLabelsDecision = { add: [], remove: [], createRefs: [], reviveRefs: [], forgetRefs: [], markRemovedHere: [], overLimit: 0, unresolved: 0 };
  const wanted = [...new Set(input.linearLabelIds)];
  const wantedSet = new Set(wanted);
  const refs = new Map(input.refs.map((ref) => [ref.linearLabelId, ref] as const));
  const has = new Set(input.current);
  /** Etiquetas daqui que alguma etiqueta ainda posta no Linear segura (para não tirar a que outra origem também aponta). */
  const heldByLinear = new Set<string>();
  for (const linearId of wanted) {
    const local = input.resolve.get(linearId);
    if (local !== undefined && local !== null) heldByLinear.add(local);
  }

  const room = (): boolean => has.size < LABELS_PER_TICKET;
  const put = (local: string): boolean => {
    if (has.has(local)) return true;
    if (!room()) {
      out.overLimit += 1;
      return false;
    }
    has.add(local);
    out.add.push(local);
    return true;
  };

  for (const linearId of wanted) {
    const local = input.resolve.get(linearId);
    if (local === undefined) {
      out.unresolved += 1;
      continue;
    }
    if (local === null) continue;
    const ref = refs.get(linearId);
    if (ref?.removedHere) continue;
    if (ref && ref.localId !== null) {
      if (!has.has(ref.localId) && !input.current.includes(ref.localId)) out.markRemovedHere.push(linearId);
      continue;
    }
    if (ref) {
      const adopted = input.current.includes(local);
      if (put(local)) out.reviveRefs.push({ linearLabelId: linearId, localId: local, adopted });
      continue;
    }
    const adopted = input.current.includes(local);
    if (put(local)) out.createRefs.push({ linearLabelId: linearId, localId: local, adopted });
  }

  for (const ref of input.refs) {
    if (ref.localId === null || ref.removedHere || wantedSet.has(ref.linearLabelId)) continue;
    // Não lida nesta rodada (id fora do conjunto mas sem certeza)? O conjunto `labelIds` é completo: fora dele é tirada no Linear.
    out.forgetRefs.push(ref.linearLabelId);
    if (ref.adopted || heldByLinear.has(ref.localId) || !has.has(ref.localId)) continue;
    has.delete(ref.localId);
    out.remove.push(ref.localId);
  }
  return out;
}

export type LinearLabelState = { name: string; color: LabelColor };

/**
 * Etiqueta do Linear renomeada ou recolorida lá: muda aqui o que ainda é o aplicado pela última sincronização (o que foi mudado aqui
 * segura). Devolve só os campos a gravar.
 */
export function decideLinearLabelUpdate(input: { current: LinearLabelState; applied: LinearLabelState; incoming: LinearLabelState }): Partial<LinearLabelState> {
  const out: Partial<LinearLabelState> = {};
  if (input.incoming.name !== input.applied.name && input.current.name === input.applied.name && input.incoming.name !== input.current.name) out.name = input.incoming.name;
  if (input.incoming.color !== input.applied.color && input.current.color === input.applied.color && input.incoming.color !== input.current.color) out.color = input.incoming.color;
  return out;
}
