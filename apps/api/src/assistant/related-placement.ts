/**
 * Tickets relacionados e o lugar do ticket novo (ADR 0052, itens 2 e 3). Lógica pura: nada aqui fala com banco ou rede; a
 * escolha entre ramos (uma pergunta ao Jev) entra por `choose`.
 */
import { MAX_ALTERNATIVES } from "./placement-search.js";
import type { PlacementOutcome, PlacementTarget } from "./placement-search.js";

/** O relacionado precisa de "mesmo assunto" (a) de pelo menos isto. */
export const RELATED_SUBJECT_MIN = 0.7;
/** No máximo estes relacionados. */
export const RELATED_MAX = 8;
/** O duplicado é o relacionado de maior "pede a mesma coisa" (b), se (b) for pelo menos isto. */
export const DUPLICATE_REQUEST_MIN = 0.85;
/** Probabilidade de "mesmo assunto" a partir da qual um relacionado vence a descida num nível intermediário e deixa o lugar sem incerteza. */
export const RELATED_CONFIDENT = 0.85;
/** Quantos relacionados (os mais prováveis) podem gerar um destino candidato. */
export const RELATED_DESTINATIONS = 3;

export type JudgedRelated = { id: string; sameSubject: number; sameRequest: number };

/** Os relacionados (em ordem de probabilidade de (a); empate fica na ordem de chegada, que é a da triagem) e o duplicado. */
export function pickRelated(judged: readonly JudgedRelated[]): { related: JudgedRelated[]; duplicate: JudgedRelated | null } {
  const related = judged
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.sameSubject >= RELATED_SUBJECT_MIN)
    .sort((a, b) => b.entry.sameSubject - a.entry.sameSubject || a.index - b.index)
    .slice(0, RELATED_MAX)
    .map(({ entry }) => entry);
  // O duplicado sai de qualquer candidato julgado: "pede a mesma coisa" alto basta, mesmo com "mesmo assunto" abaixo do limiar.
  let duplicate: JudgedRelated | null = null;
  for (const entry of judged) if (entry.sameRequest >= DUPLICATE_REQUEST_MIN && (duplicate === null || entry.sameRequest > duplicate.sameRequest)) duplicate = entry;
  return { related, duplicate };
}

/**
 * Qual regra decidiu o lugar. `descent`: sem relacionado que gere destino; `related_within`: o destino da descida já era o pai
 * de um relacionado, ou estava dentro dele; `related_ancestor`: a descida parou acima e venceu o pai do relacionado;
 * `related_choice`: ramos diferentes, o Jev escolheu; `choice_unavailable`: ramos diferentes e a escolha falhou.
 */
export type PlacementRule = "descent" | "related_within" | "related_ancestor" | "related_choice" | "choice_unavailable";

export type PlaceNode = { id: string; parentId: string | null; title: string };

export type ResolveInput = {
  outcome: PlacementOutcome;
  /** Em ordem de probabilidade, só os que passaram do limiar (`pickRelated`). */
  related: readonly JudgedRelated[];
  duplicateId: string | null;
  /** A árvore da procura (sem ideias nem cancelados). */
  byId: ReadonlyMap<string, PlaceNode>;
  scopeId: string | null;
  /** A pergunta de escolha ao Jev: probabilidade de cada opção (ids de ticket, o destino da descida primeiro). Pode lançar. */
  choose(options: readonly string[]): Promise<Readonly<Record<string, number>>>;
};

export async function resolvePlacement(input: ResolveInput): Promise<{ outcome: PlacementOutcome; rule: PlacementRule }> {
  const { byId, duplicateId } = input;
  const parentOf = (id: string): string | null => byId.get(id)?.parentId ?? null;
  /** `id` é `ancestorId` ou está dentro dele. */
  const within = (id: string | null, ancestorId: string): boolean => {
    for (let at = id; at !== null; at = parentOf(at)) if (at === ancestorId) return true;
    return false;
  };
  const targetOf = (id: string | null): PlacementTarget => {
    const path: { id: string; title: string }[] = [];
    for (let at = id === null ? undefined : byId.get(id); at; at = at.parentId === null ? undefined : byId.get(at.parentId)) path.unshift({ id: at.id, title: at.title });
    return { parentId: id, path };
  };
  const idsOf = (target: PlacementTarget): string[] => target.path.map((step) => step.id);
  const withDestination = (base: PlacementOutcome, destination: PlacementTarget, alternatives: PlacementTarget[], uncertain: boolean): PlacementOutcome => ({
    ...base,
    destination,
    alternatives,
    uncertain,
    trace: { ...base.trace, chosen: idsOf(destination), alternatives: alternatives.map(idsOf) },
  });
  const insideDuplicate = (id: string | null): boolean => duplicateId !== null && within(id, duplicateId);

  // 1. Nunca propor como destino o próprio duplicado nem algo dentro dele: a descida que parou ali volta ao pai do duplicado.
  // O escopo escolhido pela pessoa vale mais: se ele é o duplicado ou está dentro dele, nada é movido.
  let { outcome } = input;
  const scopeInsideDuplicate = input.scopeId !== null && insideDuplicate(input.scopeId);
  const stays = (id: string | null): boolean => input.scopeId === null || (id !== null && within(id, input.scopeId));
  if (duplicateId !== null && !scopeInsideDuplicate && (insideDuplicate(outcome.destination.parentId) || outcome.alternatives.some((a) => insideDuplicate(a.parentId)))) {
    const moved = insideDuplicate(outcome.destination.parentId);
    const destination = moved && stays(parentOf(duplicateId)) ? targetOf(parentOf(duplicateId)) : outcome.destination;
    outcome = withDestination(outcome, destination, outcome.alternatives.filter((a) => !insideDuplicate(a.parentId) && a.parentId !== destination.parentId), outcome.uncertain);
  }
  const current = outcome.destination.parentId;

  // 2. Os relacionados que geram destino: o pai existe (não é a raiz), não está no duplicado e está no escopo. Decide o mais provável.
  const eligible = input.related
    .filter((entry) => {
      const parent = byId.has(entry.id) ? parentOf(entry.id) : null;
      if (parent === null || insideDuplicate(parent)) return false;
      return input.scopeId === null || within(parent, input.scopeId);
    })
    .slice(0, RELATED_DESTINATIONS);
  const top = eligible[0];
  if (!top) return { outcome, rule: "descent" };
  const topParent = parentOf(top.id) as string;
  const others = eligible.slice(1).map((entry) => ({ parent: parentOf(entry.id) as string, entry }));
  /** Os pais dos outros elegíveis, que a descida não tem; "outro ramo" é o que não é ancestral nem descendente do destino. */
  const sideTargets = (excluding: readonly (string | null)[]): { target: PlacementTarget; strongElsewhere: boolean }[] =>
    others
      .filter(({ parent }) => !excluding.includes(parent))
      .map(({ parent, entry }) => ({
        target: targetOf(parent),
        strongElsewhere: entry.sameSubject >= RELATED_CONFIDENT && !(within(current, parent) || within(parent, current ?? "")) && current !== null,
      }));
  const mergeAlternatives = (lists: readonly PlacementTarget[], destination: PlacementTarget): PlacementTarget[] => {
    const seen = new Set<string | null>([destination.parentId]);
    const out: PlacementTarget[] = [];
    for (const target of lists) {
      if (seen.has(target.parentId)) continue;
      seen.add(target.parentId);
      out.push(target);
    }
    return out.slice(0, MAX_ALTERNATIVES);
  };

  // 3. O pai do mais provável é o destino da descida ou está acima dele (a escolha nunca sobe): fica o da descida.
  if (within(current, topParent)) {
    const side = sideTargets([current]);
    const alternatives = mergeAlternatives([...side.map((entry) => entry.target), ...outcome.alternatives], outcome.destination);
    const uncertain = outcome.uncertain || side.some((entry) => entry.strongElsewhere);
    return { outcome: withDestination(outcome, outcome.destination, alternatives, uncertain), rule: "related_within" };
  }

  // 4. O destino da descida (inclusive a raiz) é ancestral do pai do relacionado mais provável.
  if (current === null || within(topParent, current)) {
    const winner = targetOf(topParent);
    const confident = top.sameSubject >= RELATED_CONFIDENT;
    const side = sideTargets([topParent]).map((entry) => entry.target);
    if (current === null) {
      const alternatives = mergeAlternatives(confident ? [...side, ...outcome.alternatives] : [targetOf(null), ...side, ...outcome.alternatives], winner);
      return { outcome: withDestination(outcome, winner, alternatives, outcome.uncertain || !confident), rule: "related_ancestor" };
    }
    if (confident) {
      const alternatives = mergeAlternatives([outcome.destination, ...side, ...outcome.alternatives], winner);
      return { outcome: withDestination(outcome, winner, alternatives, outcome.uncertain), rule: "related_ancestor" };
    }
    const alternatives = mergeAlternatives([winner, ...side, ...outcome.alternatives], outcome.destination);
    return { outcome: withDestination(outcome, outcome.destination, alternatives, true), rule: "descent" };
  }

  // 5. Ramos diferentes: o Jev escolhe entre o destino da descida e os pais dos relacionados (nunca um ancestral do destino).
  const parents = [...new Set(eligible.map((entry) => parentOf(entry.id) as string))].filter((parent) => parent !== current && !within(current, parent));
  const options = [current as string, ...parents];
  const targets = new Map<string, PlacementTarget>(options.map((id) => [id, id === current ? outcome.destination : targetOf(id)]));
  let ranked: string[];
  let rule: PlacementRule = "related_choice";
  try {
    const odds = await input.choose(options);
    ranked = options
      .map((id, index) => ({ id, index, p: odds[id] ?? 0 }))
      .sort((a, b) => b.p - a.p || a.index - b.index)
      .map((entry) => entry.id);
  } catch {
    // A escolha não derruba a procura: fica o destino da descida e os pais dos relacionados viram alternativas.
    ranked = options;
    rule = "choice_unavailable";
  }
  const [first, ...rest] = ranked as [string, ...string[]];
  const winner = targets.get(first) as PlacementTarget;
  const alternatives = mergeAlternatives([...rest.map((id) => targets.get(id) as PlacementTarget), ...outcome.alternatives], winner);
  return { outcome: withDestination(outcome, winner, alternatives, true), rule };
}

/**
 * O que a rota devolve dos relacionados (ADR 0052, item 4): chave, título, situação e o caminho até o pai, sem
 * probabilidades; e o duplicado. Só tickets da árvore da procura (sem ideias nem cancelados).
 */
export function relatedListing(
  tickets: readonly { id: string; parentId: string | null; number: number; title: string; status: string }[],
  projectKey: string,
  related: readonly { id: string }[],
  duplicateId: string | null,
): {
  related: { id: string; key: string; title: string; status: string; path: { id: string; title: string }[] }[];
  duplicate: { id: string; key: string; title: string; status: string } | null;
} {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const keyOf = (number: number): string => `${projectKey}-${number}`;
  const listed = related.flatMap((entry) => {
    const ticket = byId.get(entry.id);
    if (!ticket) return [];
    const path: { id: string; title: string }[] = [];
    for (let up = ticket.parentId === null ? undefined : byId.get(ticket.parentId); up; up = up.parentId === null ? undefined : byId.get(up.parentId)) path.unshift({ id: up.id, title: up.title });
    return [{ id: ticket.id, key: keyOf(ticket.number), title: ticket.title, status: ticket.status, path }];
  });
  const found = duplicateId === null ? undefined : byId.get(duplicateId);
  return { related: listed, duplicate: found ? { id: found.id, key: keyOf(found.number), title: found.title, status: found.status } : null };
}
