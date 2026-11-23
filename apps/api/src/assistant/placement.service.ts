import { Injectable } from "@nestjs/common";
import { descriptionExcerpt } from "@treepm/domain";
import { branchTexts } from "./branch-text.js";
import { searchPlacement } from "./placement-search.js";
import type { PlacementDeps, PlacementOutcome } from "./placement-search.js";
import { judgeInputFits } from "./jev-branch-judge.js";
import { proposeGroup } from "./group-proposal.js";
import type { GroupProposalResult } from "./group-proposal.js";
import type { AffinityJudge, BranchCandidate, BranchJudge, GroupNamer, TicketDraft } from "./ports.js";

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
    deps: { affinity: AffinityJudge; namer: GroupNamer; timeoutMs?: number },
  ): Promise<GroupProposalResult> {
    const { childrenOf, describe } = this.context(snapshot);
    const parentId = outcome.destination.parentId;
    const destinationTicket = parentId === null ? undefined : snapshot.tickets.find((ticket) => ticket.id === parentId);
    const looseTickets = (childrenOf.get(parentId) ?? [])
      .filter((child) => (childrenOf.get(child.id) ?? []).length === 0)
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
}
