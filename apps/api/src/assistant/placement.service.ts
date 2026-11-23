import { Injectable, Logger } from "@nestjs/common";
import { descriptionExcerpt, fuseBy, RELATED_SHORTLIST, triageRelated } from "@treepm/domain";
import type { FusionRule } from "@treepm/domain";
import { branchTexts } from "./branch-text.js";
import { searchPlacement } from "./placement-search.js";
import type { PlacementDeps, PlacementOutcome } from "./placement-search.js";
import { judgeInputFits } from "./jev-branch-judge.js";
import { relatedInputFits } from "./jev-related-judge.js";
import { resolvePlacement } from "./related-placement.js";
import type { JudgedRelated, PlacementRule } from "./related-placement.js";
import { proposeGroup } from "./group-proposal.js";
import type { GroupProposalResult } from "./group-proposal.js";
import { AssistantUnavailableError } from "./ports.js";
import type { TriageNumbers } from "./placement-decision.js";
import { boundedSearch, SEMANTIC_TRIAGE_DEADLINE_MS } from "./semantic-triage.js";
import type { SemanticSearch } from "./semantic-triage.js";
import type { AffinityJudge, BranchCandidate, BranchJudge, GroupNamer, RelatedJudge, TicketDraft } from "./ports.js";

/** Prazo da etapa dos relacionados (a requisição ao Jev), em milissegundos. */
export const RELATED_TIMEOUT_MS = 20_000;
/** Teto da pergunta de escolha entre ramos; ela usa o que sobrou do prazo da descida (30 s), então o total descida + escolha não passa de 30 s. */
export const CHOICE_TIMEOUT_MAX_MS = 10_000;

export type TreeTicket = { id: string; parentId: string | null; number: number; title: string; description: string; status: string };
/**
 * A árvore do projeto como a procura a vê (já sem ideias, ADR 0043) e as notas escritas por pessoa, por ticket. Uma leitura
 * de cada por procura; o texto de cada candidato é montado daqui (ADR 0052), nada é guardado nem escrito.
 */
export type PlacementSnapshot = { projectId: string; projectName: string; tickets: TreeTicket[]; notes: Map<string, string> };

/**
 * Procura do caminho de um rascunho na árvore do projeto (ADR 0029). Quem chama já leu a árvore e as notas (`snapshot`)
 * em transação curta. Aqui não há mais banco nem provedor de resumo: o texto de cada candidato é montado na hora
 * (`branchTexts`), e só o Jev é chamado.
 */
@Injectable()
export class PlacementService {
  private readonly logger = new Logger("PlacementService");

  private context(snapshot: PlacementSnapshot) {
    const childrenOf = new Map<string | null, TreeTicket[]>();
    for (const ticket of [...snapshot.tickets].sort((a, b) => a.number - b.number)) {
      const list = childrenOf.get(ticket.parentId) ?? [];
      list.push(ticket);
      childrenOf.set(ticket.parentId, list);
    }
    const texts = branchTexts(snapshot.tickets, snapshot.notes);

    /**
     * Os candidatos como o juiz os vê (ADR 0033, 0034, 0052). Ticket com filhos: o texto montado agora. Ticket sem filhos
     * (o escopo): o trecho da descrição, que é o que o texto montado traz quando não há descendentes nem nota.
     */
    const describe = (children: readonly TreeTicket[], descendantsScale = 1): Promise<BranchCandidate[]> =>
      Promise.resolve(
        children.map((ticket) => {
          const hasChildren = (childrenOf.get(ticket.id) ?? []).length > 0;
          return {
            id: ticket.id,
            title: ticket.title,
            summary: hasChildren ? texts.textOf(ticket.id, descendantsScale) : descriptionExcerpt(ticket.description),
            hasChildren,
          };
        }),
      );

    return { childrenOf, describe };
  }

  async search(
    draft: TicketDraft,
    snapshot: PlacementSnapshot,
    deps: {
      /** Ticket de escopo (ADR 0031, 0034), já validado por quem chama: qualquer ticket do projeto da conversa. */
      scopeId?: string | null;
      judge: BranchJudge;
      timeoutMs?: number;
    },
  ): Promise<PlacementOutcome> {
    const { childrenOf, describe } = this.context(snapshot);
    // Candidatos são os filhos diretos que têm filhos (ADR 0034, primeira fatia); o sem filhos só vira candidato na segunda.
    const candidates = (parentId: string | null, descendantsScale = 1): Promise<BranchCandidate[]> =>
      describe((childrenOf.get(parentId) ?? []).filter((child) => (childrenOf.get(child.id) ?? []).length > 0), descendantsScale);

    const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
    const scopeTicket = deps.scopeId ? byId.get(deps.scopeId) : undefined;
    let scope: PlacementDeps["scope"];
    if (scopeTicket) {
      const ancestors: { id: string; title: string }[] = [];
      for (let up = scopeTicket.parentId ? byId.get(scopeTicket.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
        ancestors.unshift({ id: up.id, title: up.title });
      }
      const [node] = await describe([scopeTicket]);
      scope = { node: node as BranchCandidate, ancestors };
    }

    return searchPlacement(draft, {
      judge: deps.judge,
      candidates,
      ...(scope ? { scope } : {}),
      fits: judgeInputFits,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
  }

  /**
   * Proposta de agrupador novo no destino da procura (ADR 0031). Roda depois da descida, fora do prazo dela. O texto do
   * destino (agrupador) é montado na hora, só quando a verificação acontece.
   */
  async propose(
    draft: TicketDraft,
    snapshot: PlacementSnapshot,
    outcome: PlacementOutcome,
    deps: { affinity: AffinityJudge; namer: GroupNamer; timeoutMs?: number; excludeIds?: readonly string[] },
  ): Promise<GroupProposalResult> {
    const { childrenOf, describe } = this.context(snapshot);
    const parentId = outcome.destination.parentId;
    const destinationTicket = parentId === null ? undefined : snapshot.tickets.find((ticket) => ticket.id === parentId);
    const looseTickets = (childrenOf.get(parentId) ?? [])
      .filter((child) => (childrenOf.get(child.id) ?? []).length === 0 && !(deps.excludeIds ?? []).includes(child.id))
      .map(({ id, number, title, description }) => ({ id, number, title, description }));
    return proposeGroup({
      draft,
      outcome,
      destination:
        destinationTicket === undefined
          ? { kind: "root", title: snapshot.projectName }
          : {
              kind: "group",
              title: destinationTicket.title,
              summary: async () => ((await describe([destinationTicket]))[0] as BranchCandidate).summary,
            },
      looseTickets,
      affinity: deps.affinity,
      namer: deps.namer,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
  }

  /**
   * Os tickets relacionados ao rascunho, de baixo para cima (ADR 0052, item 2; ADR 0053, item 7). Os candidatos são a FUSÃO da
   * triagem por palavras (sobre a árvore que a procura já leu, em memória) com os `RELATED_SHORTLIST` vizinhos por vetor do
   * título e da descrição do rascunho (nunca dos títulos das partes nem da conversa), até `RELATED_SHORTLIST` no total;
   * depois uma requisição ao Jev com as duas perguntas de cada candidato. Se a requisição não couber, corta os últimos da
   * lista fundida. O passo de vetor (sincronização, consulta) roda dentro do mesmo prazo da etapa, com no máximo
   * `SEMANTIC_TRIAGE_DEADLINE_MS`: o que ele consome sai do tempo do Jev, então o total da etapa não passa de `timeoutMs`.
   * Sem tempo, sem provedor ou com falha, a busca segue só com palavras (idêntica à de antes). Falha ou prazo estourado do Jev
   * NUNCA derrubam a procura: devolve `failed` e nenhum julgamento (o aviso vai ao registro sem texto). `triage` (só números e
   * códigos) vem quando há `semantic`.
   */
  async findRelated(
    draft: TicketDraft & { partTitles: readonly string[] },
    snapshot: PlacementSnapshot,
    deps: { related: RelatedJudge; timeoutMs?: number; signal?: AbortSignal; semantic?: SemanticSearch; semanticDeadlineMs?: number; fusion?: FusionRule },
  ): Promise<{ judged: JudgedRelated[]; failed: boolean; triage?: TriageNumbers }> {
    const started = Date.now();
    const timeoutMs = deps.timeoutMs ?? RELATED_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOutside = () => controller.abort();
    deps.signal?.addEventListener("abort", onOutside);
    let triageOut: TriageNumbers | undefined;
    try {
      // A consulta da árvore não tem ORDER BY: a triagem lê os tickets por número, para o resultado não variar entre execuções.
      const ordered = [...snapshot.tickets].sort((a, b) => a.number - b.number);
      const byId = new Map(ordered.map((ticket) => [ticket.id, ticket]));
      const shortlist = triageRelated(
        draft,
        ordered.map((ticket) => ({ id: ticket.id, title: ticket.title, excerpt: descriptionExcerpt(ticket.description) })),
      );
      const wordsIds = shortlist.map((hit) => hit.id);
      const asked = { title: draft.title, description: draft.description };

      // O passo de vetor: nunca lança. Só pede o que a fonte souber fazer dentro do que sobrou do prazo da etapa.
      let vectorIds: string[] = [];
      let semantic: TriageNumbers["semantic"] | undefined;
      if (deps.semantic) {
        const left = timeoutMs - (Date.now() - started);
        if (left <= 0) {
          semantic = { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "skipped_no_time" };
        } else {
          // Corre contra o prazo do passo: fonte lenta, travada ou que lança vira só palavras (nunca derruba a busca).
          const result = await boundedSearch(deps.semantic, [asked], RELATED_SHORTLIST, { signal: controller.signal, deadlineMs: Math.min(deps.semanticDeadlineMs ?? SEMANTIC_TRIAGE_DEADLINE_MS, Math.floor(left / 2)) });
          vectorIds = (result.neighbours[0] ?? []).map((neighbour) => neighbour.ticketId).filter((id) => byId.has(id));
          semantic = result.diagnostics;
        }
      }

      const fused = fuseBy(deps.fusion ?? "rrf", wordsIds, vectorIds, RELATED_SHORTLIST);
      const all = fused.map((hit) => {
        const ticket = byId.get(hit.id) as TreeTicket;
        return { id: ticket.id, title: ticket.title, excerpt: descriptionExcerpt(ticket.description) };
      });
      let candidates = all;
      // Corte por tamanho: saem primeiro os que vieram SÓ do vetor (do fim para o começo), depois os demais, do fim.
      const vectorOnly = new Set(fused.filter((hit) => hit.origin === "vector").map((hit) => hit.id));
      while (candidates.length > 0 && !relatedInputFits({ draft: asked, candidates })) {
        let drop = candidates.length - 1;
        for (let i = candidates.length - 1; i >= 0; i -= 1) {
          if (vectorOnly.has((candidates[i] as { id: string }).id)) {
            drop = i;
            break;
          }
        }
        candidates = candidates.filter((_, i) => i !== drop);
      }
      if (candidates.length < all.length) this.logger.warn(`relacionados cortados por tamanho enviados=${candidates.length} de=${all.length}`);
      if (semantic) {
        const inWords = new Set(wordsIds);
        triageOut = {
          words: wordsIds.length,
          vector: vectorIds.length,
          both: vectorIds.filter((id) => inWords.has(id)).length,
          onlyVector: candidates.filter((c) => vectorOnly.has(c.id)).length,
          sent: candidates.length,
          semantic,
        };
      }
      if (candidates.length === 0) return { judged: [], failed: false, ...(triageOut ? { triage: triageOut } : {}) };
      // O passo de vetor pode ter consumido o prazo inteiro: abortado antes de pedir, o evento já passou e não dispararia de novo.
      if (controller.signal.aborted) throw new Error("related_timeout");
      const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("related_timeout"))));
      const answers = await Promise.race([deps.related.judge({ draft: asked, candidates }, { signal: controller.signal }), timedOut]);
      return { judged: candidates.map((candidate) => ({ id: candidate.id, sameSubject: answers[candidate.id]?.sameSubject ?? 0, sameRequest: answers[candidate.id]?.sameRequest ?? 0 })), failed: false, ...(triageOut ? { triage: triageOut } : {}) };
    } catch (error) {
      // Só o motivo vai ao registro: nunca texto do rascunho nem dos tickets.
      const reason = error instanceof AssistantUnavailableError ? error.reason : error instanceof Error && error.message === "related_timeout" ? "timeout" : "error";
      this.logger.warn(`relacionados indisponíveis motivo=${reason}`);
      return { judged: [], failed: true, ...(triageOut ? { triage: triageOut } : {}) };
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onOutside);
    }
  }

  /**
   * O lugar com os relacionados concorrendo com a descida (ADR 0052, item 3). Quando a descida e os relacionados apontam
   * para ramos diferentes, uma pergunta de escolha ao Jev (o mesmo juiz de ramo, com o texto montado de cada destino).
   */
  async place(
    outcome: PlacementOutcome,
    snapshot: PlacementSnapshot,
    deps: { related: readonly JudgedRelated[]; duplicateId: string | null; scopeId: string | null; draft: TicketDraft; judge: BranchJudge; timeoutMs?: number },
  ): Promise<{ outcome: PlacementOutcome; rule: PlacementRule }> {
    const { describe } = this.context(snapshot);
    const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
    return resolvePlacement({
      outcome,
      related: deps.related,
      duplicateId: deps.duplicateId,
      byId,
      scopeId: deps.scopeId,
      choose: async (options) => {
        const candidates = await describe(options.map((id) => byId.get(id) as TreeTicket));
        const input = { draft: deps.draft, current: null, candidates };
        if (!judgeInputFits(input)) throw new AssistantUnavailableError("choice_too_large");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(deps.timeoutMs ?? CHOICE_TIMEOUT_MAX_MS, CHOICE_TIMEOUT_MAX_MS));
        try {
          const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("choice_timeout"))));
          const verdict = await Promise.race([deps.judge.judge(input, { signal: controller.signal }), timedOut]);
          return verdict.choice;
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }
}
