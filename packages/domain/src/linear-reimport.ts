/**
 * Reimportação do Linear (ADR 0060, seção 5): a decisão por campo, pura. Nada aqui lê banco nem rede.
 *
 * Por campo, três valores já mapeados do mesmo jeito: o que chega agora do Linear (`incoming`), o que veio na última importação
 * (`previousSource`) e o que o TreePM tem hoje (`current`) contra o que a importação aplicou (`applied`). Só se aplica o campo que
 * mudou no Linear E não foi mexido no TreePM. Comparar com o retrato aplicado, e não com o Linear, evita o vaivém de casos em que
 * o TreePM aplicou um valor diferente do que veio (concluído com filho aberto, ideia).
 */
import type { TicketStatus } from "./tickets.js";

/** Igualdade dos valores de campo: texto, número e nulo por `===`; listas (responsáveis) como conjuntos, sem ordem. */
export function sameLinearValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.every((value, index) => value === right[index]);
  }
  return a === b;
}

export type LinearFieldDecision = {
  /** O valor que chega difere do valor de origem da última importação. */
  changedInLinear: boolean;
  /** O valor de hoje no TreePM difere do que a importação aplicou. */
  touchedHere: boolean;
  /** Aplicar o valor novo: mudou no Linear e não foi mexido aqui. */
  apply: boolean;
};

/** `I` é o tipo do lado do Linear e `C` o do lado do TreePM (iguais, exceto no responsável: id do Linear × ids de pessoas). */
export function decideLinearField<I, C = I>(input: { incoming: I; previousSource: I; current: C; applied: C }): LinearFieldDecision {
  const changedInLinear = !sameLinearValue(input.incoming, input.previousSource);
  const touchedHere = !sameLinearValue(input.current, input.applied);
  return { changedInLinear, touchedHere, apply: changedInLinear && !touchedHere };
}

/**
 * A situação que a reimportação aplica de fato (as invariantes que já valem para o resto do TreePM): dentro de uma ideia (ou na
 * raiz dela) a situação não muda (fica a de hoje); concluído com filho aberto também não se aplica agora (fica a de hoje; quem chama
 * guarda a pendência para a rodada seguinte, e nunca rebaixa um ticket em andamento). O resto vale como veio.
 */
export function reimportedStatus(input: { target: TicketStatus; current: TicketStatus; insideIdea: boolean; hasOpenChildren: boolean }): TicketStatus {
  if (input.insideIdea) return input.current;
  if (input.target === "done" && input.hasOpenChildren) return input.current;
  return input.target;
}

export type LinearStatusDecision = {
  /** A situação de hoje difere da que a importação aplicou: alguém a mexeu no TreePM. */
  touchedHere: boolean;
  /** A situação desejada difere da do retrato de origem anterior (o Linear mudou nesta rodada). */
  changedInLinear: boolean;
  /**
   * `apply`: o ticket assume `target`; `kept`: foi mexido aqui e não se toca; `blocked`: uma invariante impede (concluído com filho
   * aberto; dentro de ideia) e o ticket fica como está, em desvio; `none`: já está como se deseja.
   */
  outcome: "apply" | "kept" | "blocked" | "none";
  /** A situação em que o ticket termina. */
  target: TicketStatus;
  /** Aplicada ≠ desejada por causa de invariante, não por decisão de pessoa: reavaliado em toda reimportação. */
  deviation: boolean;
};

/**
 * A situação na reimportação, como UMA regra (ADR 0060, seção 5). Desejada = a do Linear mapeada. Mexida aqui = atual ≠ aplicada
 * (quem mexeu manda: não se toca). Senão o ticket assume a desejada, a menos que uma invariante impeça; então fica como está e em
 * desvio, sem ser rebaixado, até poder assumir. Não depende de o Linear ter mudado agora: é o que faz um desvio convergir.
 */
export function decideLinearStatus(input: { desired: TicketStatus; previousSource: TicketStatus; current: TicketStatus; applied: TicketStatus; insideIdea: boolean; hasOpenChildren: boolean }): LinearStatusDecision {
  const touchedHere = input.current !== input.applied;
  const changedInLinear = input.desired !== input.previousSource;
  if (touchedHere) return { touchedHere, changedInLinear, outcome: "kept", target: input.current, deviation: false };
  if (input.desired === input.current) return { touchedHere, changedInLinear, outcome: "none", target: input.current, deviation: false };
  const target = reimportedStatus({ target: input.desired, current: input.current, insideIdea: input.insideIdea, hasOpenChildren: input.hasOpenChildren });
  if (target === input.current) return { touchedHere, changedInLinear, outcome: "blocked", target, deviation: true };
  return { touchedHere, changedInLinear, outcome: "apply", target, deviation: false };
}

export type LinearLateDecision = {
  /**
   * `fill`: sem retrato e vazio aqui, aplica o valor do Linear (e grava os dois lados). `synced`: sem retrato e nada a decidir (os dois
   * lados já são iguais, ou nenhum tem valor): só grava os dois lados. `hold`: sem retrato e já preenchido aqui com outro valor: o
   * daqui fica e o campo passa a "mantido daqui". `held`: já mantido daqui, nada é aplicado. `regular`: com retrato, a regra de sempre.
   */
  action: "fill" | "synced" | "hold" | "held" | "regular";
  apply: boolean;
  /** O campo passa a ser "mantido daqui" nesta rodada. */
  hold: boolean;
  /** O Linear tem um valor diferente do daqui e o daqui foi mantido (para a contagem `keptTouched`). */
  kept: boolean;
};

/**
 * A regra do campo sem retrato (ADR 0061, seção 2), pura. "Sem retrato" é o par que não existe no retrato de origem (`hasSnapshot`
 * falso). `held` é a marca "mantido daqui": vence a regra geral para sempre, mesmo que o Linear mude, e só uma pessoa a tira (nesta
 * fatia ninguém a tira). Os campos `changedInLinear` e `touchedHere` vêm de `decideLinearField` e só valem com retrato.
 * `incomingDiffers`: o valor que o Linear traria, já mapeado, difere do que o TreePM tem hoje.
 */
export function decideLinearLateField(input: {
  hasSnapshot: boolean;
  held: boolean;
  changedInLinear: boolean;
  touchedHere: boolean;
  currentEmpty: boolean;
  incomingEmpty: boolean;
  incomingDiffers: boolean;
}): LinearLateDecision {
  if (input.held) return { action: "held", apply: false, hold: false, kept: input.changedInLinear };
  if (input.hasSnapshot) return { action: "regular", apply: input.changedInLinear && !input.touchedHere, hold: false, kept: input.changedInLinear && input.touchedHere };
  if (!input.incomingDiffers) return { action: "synced", apply: false, hold: false, kept: false };
  if (input.currentEmpty && !input.incomingEmpty) return { action: "fill", apply: true, hold: false, kept: false };
  return { action: "hold", apply: false, hold: true, kept: true };
}

/** A lista de campos "mantidos daqui" depois de acrescentar `field`: sem repetir, em ordem, ignorando o que não for texto. */
export function heldFieldsAfter(current: unknown, field: string): string[] {
  const list = Array.isArray(current) ? current.filter((item): item is string => typeof item === "string") : [];
  return [...new Set([...list, field])].sort();
}
