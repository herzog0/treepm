/**
 * Quando a procura do lugar pergunta (ADR 0054, item 1). Lógica pura, num lugar só: a rota (a procura de verdade) e a
 * ferramenta de medição (`doubt-curve`, sobre julgamentos gravados) chamam a MESMA função, com configurações diferentes.
 *
 * A faixa daqui decide QUANDO perguntar; a descida (`BELONGS_LOW`/`BELONGS_HIGH` em `placement-search.ts`) continua
 * decidindo COMO ela anda. Os valores de partida (0,2, 0,8 e 0,5) não são critério de aceite: a largura é de Teodoro.
 */
import type { PlacementRule } from "./related-placement.js";

export type DoubtConfig = {
  /** A probabilidade de "cabe em algum ramo daqui" dentro de [low, high] (inclusive) é dúvida. */
  low: number;
  high: number;
  /** O ramo escolhido com probabilidade ESTRITAMENTE menor que isto, havendo mais de um candidato, não se destaca. */
  choice: number;
  /** Só para conferir contas antigas na curva: `false` desliga a dúvida `root` (padrão: ligada, como no produto). */
  rootIsDoubt?: boolean;
};

export const DEFAULT_DOUBT: DoubtConfig = { low: 0.2, high: 0.8, choice: 0.5 };

/**
 * `fit`: cabe em algum? está na faixa. `which`: em qual? desceria sem se destacar. `root`: no primeiro nível concluiria
 * que não cabe em nenhum (o destino seria a raiz). `related`: os relacionados apontam para outro ramo e a escolha não foi
 * confiante (ou falhou). `interrupted`: nível grande demais ou limite de níveis. Falha ou prazo do Jev na descida NÃO é dúvida:
 * continua 503 (`assistant_unavailable`), como antes da ADR 0054.
 */
export type DoubtKind = "fit" | "which" | "root" | "related" | "interrupted";
export const DOUBT_KINDS: readonly DoubtKind[] = ["fit", "which", "root", "related", "interrupted"];

/** O que a função precisa de cada passo da descida (é o `PlacementStep` do rastro, sem o que não usa). */
export type DoubtStepInput = {
  level: number;
  parentId: string | null;
  result: "descended" | "band" | "below_low" | "no_candidates" | "too_large";
  belongs: number | null;
  candidates: readonly { ticketId: string; probability: number }[];
};

export type Doubt = { level: number; parentId: string | null; kind: DoubtKind };

export type DoubtInput = {
  steps: readonly DoubtStepInput[];
  /**
   * O caminho mantido: o primeiro item é o nó de onde a procura partiu (`null` é a raiz) e os seguintes são os nós do
   * caminho escolhido, na ordem. O filho do nó `i` é o item `i + 1`; o último nó não tem filho.
   */
  walk: readonly (string | null)[];
  stoppedEarly: { reason: "candidates_too_large" | "max_levels"; level: number; parentId: string | null } | null;
  /** Soma ao nível do passo para dar a profundidade na árvore: a procura que parte de um ramo ou escopo recomeça em 1. */
  levelOffset?: number;
  /**
   * A regra dos relacionados que decidiu o lugar, com a probabilidade do vencedor e onde a pergunta `related` seria feita (o
   * ancestral comum de todas as opções da escolha). `weak`: só para `related_ancestor`; o relacionado que venceu ficou abaixo de
   * `RELATED_CONFIDENT`.
   */
  related?: { rule: PlacementRule; choiceTop: number | null; weak?: boolean; parentId: string | null; level: number } | null;
  /**
   * Só quando a escolha dos relacionados (`related_choice`) tirou o ticket do destino da descida: o nó em que o caminho do
   * vencedor se separa do caminho da descida (`parentId`, `null` = raiz). Ali, e só ali, as probabilidades da descida não valem
   * para dizer "em qual" (quem escolheu o ramo foram os relacionados). Acima da bifurcação o caminho é o da descida e abaixo dela
   * `fit` e nível grande demais valem sempre. `null`/ausente: o vencedor é o destino da descida e nada é ignorado.
   */
  divergence?: { parentId: string | null } | null;
};

/** A dúvida mais rasa do caminho mantido, ou `null` quando não há (a procura propõe um destino sem perguntar). */
export function findDoubt(input: DoubtInput, config: DoubtConfig): Doubt | null {
  const offset = input.levelOffset ?? 0;
  const found: Doubt[] = [];
  const byParent = new Map(input.steps.map((step) => [step.parentId, step]));

  for (let i = 0; i < input.walk.length; i += 1) {
    const parentId = input.walk[i] as string | null;
    const child = i + 1 < input.walk.length ? (input.walk[i + 1] as string | null) : null;
    const step = byParent.get(parentId);
    if (!step) continue;
    const level = step.level + offset;
    if (step.result === "too_large") {
      found.push({ level, parentId, kind: "interrupted" });
      break;
    }
    const belongs = step.belongs;
    if (belongs === null) continue; // sem candidatos: não há o que perguntar
    if (belongs >= config.low && belongs <= config.high) {
      found.push({ level, parentId, kind: "fit" });
      break;
    }
    if (belongs < config.low || step.result === "below_low") {
      // Parar aqui é confiante, menos na raiz: nenhum ticket vai para a raiz sem a pessoa ter dito isso.
      if (config.rootIsDoubt !== false && parentId === null && child === null && step.result === "below_low") {
        found.push({ level, parentId, kind: "root" });
        break;
      }
      continue;
    }
    if (child !== null && step.candidates.length > 1 && !(input.divergence && input.divergence.parentId === parentId)) {
      const probability = step.candidates.find((candidate) => candidate.ticketId === child)?.probability ?? 0;
      if (probability < config.choice) {
        found.push({ level, parentId, kind: "which" });
        break;
      }
    }
  }
  // O limite de níveis não tem passo próprio: a dúvida é onde a descida parou.
  if (input.stoppedEarly?.reason === "max_levels" && !found.some((doubt) => doubt.kind === "interrupted")) {
    // A pergunta é sobre os filhos do nó onde a descida parou: o nível dele no caminho mantido mais um.
    const at = input.walk.indexOf(input.stoppedEarly.parentId);
    const level = at >= 0 ? at + 1 + offset : input.stoppedEarly.level + 1 + offset;
    found.push({ level, parentId: input.stoppedEarly.parentId, kind: "interrupted" });
  }
  const related = input.related;
  if (
    related &&
    (related.rule === "choice_unavailable" ||
      (related.rule === "related_choice" && (related.choiceTop ?? 0) < config.choice) ||
      (related.rule === "related_ancestor" && related.weak === true))
  ) {
    found.push({ level: related.level, parentId: related.parentId, kind: "related" });
  }
  // O mais raso vence; no mesmo nível, o primeiro achado (a descida, depois o limite, depois os relacionados).
  return found.reduce<Doubt | null>((best, doubt) => (best === null || doubt.level < best.level ? doubt : best), null);
}
