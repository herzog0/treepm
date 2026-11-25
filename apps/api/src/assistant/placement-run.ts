import type { Doubt, DoubtConfig } from "./placement-doubt.js";
import { findDoubt } from "./placement-doubt.js";
import type { PlacementOutcome } from "./placement-search.js";
import { PLACEMENT_TIMEOUT_MS } from "./placement-search.js";
import { commonAncestor, forkOf, pathTo } from "./placement-question.js";
import type { QuestionNode } from "./placement-question.js";
import { pickRelated } from "./related-placement.js";
import type { PlacementChoice, PlacementResolved, PlacementRule } from "./related-placement.js";
import type { PlacementService, PlacementSnapshot } from "./placement.service.js";
import type { BranchJudge, PlacementTimeouts, RelatedJudge, TicketDraft } from "./ports.js";
import type { SemanticSearch } from "./semantic-triage.js";
import type { FusionRule } from "@treepm/domain";

/** O que a procura do lugar precisa: o que a conversa de novo ticket e o lote do Linear fornecem do mesmo jeito. */
export type PlacementRunInput = {
  snapshot: PlacementSnapshot;
  /** O texto do pedido que a descida e a escolha veem. */
  draft: { title: string; description: string };
  /** O mesmo texto para a triagem de relacionados (título, descrição e os títulos das partes). */
  triage: TicketDraft & { partTitles: readonly string[] };
  judge: BranchJudge;
  related: RelatedJudge;
  doubt: DoubtConfig;
  semantic?: SemanticSearch;
  fusion: FusionRule;
  scopeId: string | null;
  startId: string | null;
  timeouts?: PlacementTimeouts | null;
};

export type PlacementRun = {
  /** O resultado da descida e os relacionados, já reconciliados pela regra do lugar. */
  placed: PlacementResolved;
  rule: PlacementRule;
  choice: PlacementChoice | null;
  /** O resultado ANTES de a pergunta o marcar como incerto. */
  outcome: PlacementOutcome;
  picked: ReturnType<typeof pickRelated>;
  /** O que o passo de relacionados trouxe (diagnóstico de triagem). */
  found: Awaited<ReturnType<PlacementService["findRelated"]>>;
  doubt: Doubt | null;
  nodes: Map<string, QuestionNode>;
  /** O ponto de partida da procura (ramo confirmado ou escopo); `null` = projeto inteiro. */
  origin: string | null;
};

/**
 * A procura do lugar de um pedido na árvore, do começo até a decisão de perguntar ou não (ADR 0029, 0052, 0054). É o MESMO caminho para
 * a conversa de novo ticket e para a categorização do lote importado do Linear: a descida e os relacionados andam juntos, o lugar sai da
 * regra de reconciliação e a dúvida da regra da faixa, sem limiar próprio de quem chama. Rede (Jev, vetores): quem chama garante que não
 * há transação aberta.
 */
export async function runPlacement(service: PlacementService, input: PlacementRunInput): Promise<PlacementRun> {
  const { snapshot, timeouts } = input;
  const nodes = new Map<string, QuestionNode>(snapshot.tickets.map((t) => [t.id, { id: t.id, parentId: t.parentId, number: t.number, title: t.title }]));
  const startedAt = Date.now();
  const relatedAbort = new AbortController();
  const [descent, found] = await Promise.all([
    service
      .search(input.draft, snapshot, {
        judge: input.judge,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.startId ? { startId: input.startId } : {}),
        ...(timeouts?.descentMs ? { timeoutMs: timeouts.descentMs } : {}),
      })
      .catch((error: unknown) => {
        // Se a descida falha, a requisição dos relacionados não fica rodando (e sendo paga).
        relatedAbort.abort();
        throw error;
      }),
    service.findRelated(input.triage, snapshot, {
      related: input.related,
      signal: relatedAbort.signal,
      ...(input.semantic ? { semantic: input.semantic } : {}),
      fusion: input.fusion,
      ...(timeouts?.relatedMs ? { timeoutMs: timeouts.relatedMs } : {}),
    }),
  ]);
  const picked = pickRelated(found.judged);
  // O ramo confirmado é o limite dos relacionados (como o escopo): fora dele não geram destino; dentro dele vale tudo como hoje.
  const placed = await service.place(descent, snapshot, {
    related: picked.related,
    duplicateId: picked.duplicate?.id ?? null,
    scopeId: input.startId ?? input.scopeId,
    draft: input.draft,
    judge: input.judge,
    // A escolha usa o que sobrou do prazo da descida (teto de 10 s): descida + escolha nunca passam do prazo da descida.
    timeoutMs: Math.max(1, (timeouts?.descentMs ?? PLACEMENT_TIMEOUT_MS) - (Date.now() - startedAt)),
  });
  const { rule, weakAncestor } = placed;
  // O relacionado fraco que tira o ticket da raiz também vira pergunta `related`, com os destinos em disputa como opções.
  const choice = placed.choice ?? (weakAncestor ? { options: weakAncestor.map((optionId) => ({ id: optionId, probability: null })), top: null, descentId: null } : null);
  const outcome = placed.outcome;

  // A dúvida mais rasa do caminho mantido (ADR 0054, item 1).
  const origin = input.startId ?? input.scopeId;
  const chosen = outcome.trace.chosen;
  const after = origin === null ? chosen : chosen.slice(chosen.indexOf(origin) + 1);
  const relatedAt = (rule === "related_choice" || rule === "choice_unavailable") && choice ? commonAncestor(choice.options.map((o) => o.id), nodes) : null;
  // Os relacionados só tiram o `which` da descida onde o caminho do vencedor se separa do da descida, e só se o vencedor é outro.
  const winnerId = outcome.destination.parentId;
  const divergence = rule === "related_choice" && choice?.descentId != null && winnerId !== choice.descentId ? { parentId: forkOf(choice.descentId, winnerId, nodes) } : null;
  let doubt = findDoubt(
    {
      divergence,
      steps: outcome.trace.steps,
      walk: [origin, ...after],
      stoppedEarly: outcome.stoppedEarly,
      levelOffset: origin === null ? 0 : pathTo(origin, nodes).length,
      ...(choice ? { related: { rule, choiceTop: choice.top, weak: weakAncestor !== null, parentId: relatedAt, level: pathTo(relatedAt, nodes).length + 1 } } : {}),
    },
    input.doubt,
  );
  // A raiz nunca sai como destino confirmado: só a pessoa a escolhe (ADR 0054, item 1).
  if (!doubt && outcome.destination.parentId === null) doubt = { level: 1, parentId: null, kind: "root" };
  return { placed, rule, choice, outcome, picked, found, doubt, nodes, origin };
}
