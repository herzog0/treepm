/**
 * A pergunta do lugar (ADR 0054, item 2), montada em código: nenhum texto de modelo e nenhuma chamada a provedor.
 * Lógica pura sobre a árvore que a procura já leu.
 */
import type { Doubt, DoubtKind } from "./placement-doubt.js";
import type { PlacementChoice } from "./related-placement.js";

export type QuestionNode = { id: string; parentId: string | null; number: number; title: string };
export type QuestionPath = { id: string; title: string }[];
export type QuestionOption = { id: string; title: string; path: QuestionPath; probability: number | null };
export type PlacementQuestion = {
  level: number;
  kind: DoubtKind;
  at: { id: string | null; title: string; path: QuestionPath };
  /** Até 3, em ordem de probabilidade. `probability` é nula quando o Jev não julgou (`interrupted`); só a decisão guardada a usa. */
  options: QuestionOption[];
};
export const MAX_OPTIONS = 3;

export const pathTo = (id: string | null, byId: ReadonlyMap<string, QuestionNode>): QuestionPath => {
  const out: QuestionPath = [];
  for (let at = id === null ? undefined : byId.get(id); at; at = at.parentId === null ? undefined : byId.get(at.parentId)) out.unshift({ id: at.id, title: at.title });
  return out;
};

/** O nó mais fundo que é ancestral estrito de todos os nós dados (`null` = raiz): onde as opções são alternativas entre si. */
export function commonAncestor(ids: readonly string[], byId: ReadonlyMap<string, QuestionNode>): string | null {
  const paths = ids.map((id) => pathTo(id, byId).slice(0, -1).map((step) => step.id));
  const first = paths[0] ?? [];
  let common: string | null = null;
  for (let i = 0; i < first.length && paths.every((path) => path[i] === first[i]); i += 1) common = first[i] as string;
  return common;
}

/**
 * O nó em que os caminhos até `a` e `b` (cada um incluído) se separam: o mais fundo que é `a`, `b` ou ancestral dos dois (`null` = raiz).
 * Com `a === b`, é o próprio nó.
 */
export function forkOf(a: string | null, b: string | null, byId: ReadonlyMap<string, QuestionNode>): string | null {
  const first = pathTo(a, byId).map((step) => step.id);
  const second = pathTo(b, byId).map((step) => step.id);
  let fork: string | null = null;
  for (let i = 0; i < first.length && first[i] === second[i]; i += 1) fork = first[i] as string;
  return fork;
}

export type QuestionInput = {
  doubt: Doubt;
  /** Os candidatos julgados no nó da dúvida (passo da descida), com as probabilidades. */
  stepCandidates: readonly { ticketId: string; probability: number }[];
  /** Para `related`: as opções da escolha, já na ordem final. */
  choice: PlacementChoice | null;
  /** Para `interrupted` sem julgamento: os filhos do nó que têm filhos, por número. */
  unjudged: readonly string[];
  byId: ReadonlyMap<string, QuestionNode>;
  projectName: string;
};

export function buildQuestion(input: QuestionInput): PlacementQuestion {
  const { doubt, byId } = input;
  let ranked: { id: string; probability: number | null }[];
  if (doubt.kind === "related" && input.choice) ranked = input.choice.options.map((o) => ({ id: o.id, probability: o.probability }));
  else if (input.stepCandidates.length > 0) ranked = input.stepCandidates.map((c, i) => ({ c, i })).sort((a, b) => b.c.probability - a.c.probability || a.i - b.i).map(({ c }) => ({ id: c.ticketId, probability: c.probability }));
  else ranked = input.unjudged.map((id) => ({ id, probability: null }));
  const options = ranked.filter((o) => byId.has(o.id)).slice(0, MAX_OPTIONS).map((o) => ({ id: o.id, title: (byId.get(o.id) as QuestionNode).title, path: pathTo(o.id, byId), probability: o.probability }));
  const at = doubt.parentId === null ? { id: null, title: input.projectName, path: [] } : { id: doubt.parentId, title: byId.get(doubt.parentId)?.title ?? "", path: pathTo(doubt.parentId, byId) };
  return { level: doubt.level, kind: doubt.kind, at, options };
}
