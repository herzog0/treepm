import { Injectable } from "@nestjs/common";
import { descriptionExcerpt } from "@treepm/domain";
import { branchContentMark } from "./branch-mark.js";
import { searchPlacement } from "./placement-search.js";
import type { PlacementDeps, PlacementOutcome } from "./placement-search.js";
import { judgeInputFits } from "./jev-branch-judge.js";
import { proposeGroup } from "./group-proposal.js";
import type { GroupProposalResult } from "./group-proposal.js";
import type { AffinityJudge, BranchCandidate, BranchJudge, BranchSummarizer, BranchSummaryInput, GroupNamer, TicketDraft } from "./ports.js";
import type { TenantRunner } from "../db/own-transactions.js";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";

export type TreeTicket = { id: string; parentId: string | null; number: number; title: string; description: string };
/** O texto guardado do agrupador (ADR 0033); a marca de conteúdo é só registro e não entra aqui. */
export type StoredSummary = { summary: string };
export type PlacementSnapshot = { projectId: string; projectName: string; tickets: TreeTicket[]; summaries: Map<string, StoredSummary> };

type ProviderDeps = {
  summarizer: BranchSummarizer;
  tenant: TenantRunner;
  /** Confere de novo permissão, projeto não arquivado e conversa aberta; lança se algo mudou. */
  recheck: (tx: TenantClient, principal: Principal) => Promise<unknown>;
};

/** Quantos resumos de um nível são pedidos ao mesmo tempo ao provedor. */
const SUMMARY_CONCURRENCY = 8;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await fn(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Procura do caminho de um rascunho na árvore do projeto (ADR 0029). Quem chama já leu a árvore e os textos guardados
 * (`snapshot`) em transação curta. Aqui: só os textos que faltam são escritos pelo provedor (o texto guardado não é mais
 * refeito quando os itens mudam, ADR 0033), SEM transação aberta, e gravados em transação curta que `recheck` confere de
 * novo antes de escrever.
 */
@Injectable()
export class PlacementService {
  /** Árvore do projeto como a procura a vê, com a escrita dos resumos que faltam (SEM transação aberta durante o provedor). */
  private context(snapshot: PlacementSnapshot, deps: ProviderDeps) {
    const childrenOf = new Map<string | null, TreeTicket[]>();
    for (const ticket of [...snapshot.tickets].sort((a, b) => a.number - b.number)) {
      const list = childrenOf.get(ticket.parentId) ?? [];
      list.push(ticket);
      childrenOf.set(ticket.parentId, list);
    }
    // O mapa do `snapshot` é atualizado aqui de propósito: a proposta, depois da descida, reaproveita os resumos já escritos.
    const summaries = snapshot.summaries;
    const summaryInput = (ticket: TreeTicket): BranchSummaryInput => ({
      title: ticket.title,
      descriptionExcerpt: descriptionExcerpt(ticket.description),
      children: (childrenOf.get(ticket.id) ?? []).map((child) => ({
        title: child.title,
        summary: summaries.get(child.id)?.summary ?? null,
      })),
    });

    /**
     * Os candidatos como o juiz os vê (ADR 0033, 0034). Ticket com filhos: o texto guardado vale, qualquer que seja a
     * marca de conteúdo; sem texto guardado passa pelo resumidor (e o texto fica guardado, como `assistant`). Ticket
     * sem filhos (o escopo): entra com o trecho da descrição, nada é guardado, e o texto guardado dele fica para quando
     * voltar a ter filhos.
     */
    const describe = async (children: readonly TreeTicket[]): Promise<BranchCandidate[]> => {
      const missing = children
        .filter((child) => (childrenOf.get(child.id) ?? []).length > 0 && !summaries.has(child.id))
        .map((ticket) => ({ ticket, input: summaryInput(ticket) }))
        .map((entry) => ({ ...entry, mark: branchContentMark(entry.input) }));
      if (missing.length > 0) {
        const written = await mapLimit(missing, SUMMARY_CONCURRENCY, async (entry) => ({
          ...entry,
          result: await deps.summarizer.summarize(entry.input),
        }));
        const ids = written.map((w) => w.ticket.id);
        const stored = await deps.tenant.run(async (tx, principal) => {
          await deps.recheck(tx, principal);
          const alive = new Set((await tx.ticket.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id));
          // Só cria: um texto que apareceu enquanto a IA escrevia (da pessoa ou de outra procura) nunca é sobrescrito.
          await tx.branchSummary.createMany({
            data: written
              .filter(({ ticket }) => alive.has(ticket.id)) // removido durante a chamada: nada a guardar
              .map(({ ticket, mark, result }) => ({
                orgId: principal.organization.orgId,
                projectId: snapshot.projectId,
                ticketId: ticket.id,
                summary: result.summary,
                contentMark: mark,
                model: result.model,
                source: "assistant",
              })),
            skipDuplicates: true,
          });
          return tx.branchSummary.findMany({ where: { ticketId: { in: ids } }, select: { ticketId: true, summary: true } });
        });
        // O que ficou guardado é o que vale, venha de quem vier.
        for (const row of stored) summaries.set(row.ticketId, { summary: row.summary });
      }
      return children.map((ticket) => {
        const hasChildren = (childrenOf.get(ticket.id) ?? []).length > 0;
        return {
          id: ticket.id,
          title: ticket.title,
          // O texto guardado vale para o ticket que tem filhos; sem filhos, o trecho da descrição (o texto guardado fica
          // para quando voltar a ter filhos, ADR 0034).
          summary: hasChildren ? (summaries.get(ticket.id)?.summary ?? "") : descriptionExcerpt(ticket.description),
          hasChildren,
        };
      });
    };

    return { childrenOf, describe };
  }

  async search(
    draft: TicketDraft,
    snapshot: PlacementSnapshot,
    deps: ProviderDeps & {
      /** Ticket de escopo (ADR 0031, 0034), já validado por quem chama: qualquer ticket do projeto da conversa. */
      scopeId?: string | null;
      judge: BranchJudge;
      timeoutMs?: number;
    },
  ): Promise<PlacementOutcome> {
    const { childrenOf, describe } = this.context(snapshot, deps);
    // Candidatos são os filhos diretos que têm filhos (ADR 0034, primeira fatia); o sem filhos só vira candidato na segunda.
    const candidates = (parentId: string | null): Promise<BranchCandidate[]> =>
      describe((childrenOf.get(parentId) ?? []).filter((child) => (childrenOf.get(child.id) ?? []).length > 0));

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
   * Proposta de agrupador no destino da procura (ADR 0031). Roda depois da descida, fora do prazo dela. O resumo do
   * destino (agrupador) é escrito como os demais se faltar, mas só quando a verificação acontece.
   */
  async propose(
    draft: TicketDraft,
    snapshot: PlacementSnapshot,
    outcome: PlacementOutcome,
    deps: ProviderDeps & { affinity: AffinityJudge; namer: GroupNamer; timeoutMs?: number },
  ): Promise<GroupProposalResult> {
    const { childrenOf, describe } = this.context(snapshot, deps);
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
