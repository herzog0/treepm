import { Injectable } from "@nestjs/common";
import { descriptionExcerpt } from "@treepm/domain";
import { branchContentMark } from "./branch-mark.js";
import { searchPlacement } from "./placement-search.js";
import type { PlacementOutcome } from "./placement-search.js";
import { judgeInputFits } from "./jev-branch-judge.js";
import type { BranchCandidate, BranchJudge, BranchSummarizer, BranchSummaryInput, TicketDraft } from "./ports.js";
import type { TenantRunner } from "../db/own-transactions.js";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";

export type TreeTicket = { id: string; parentId: string | null; number: number; title: string; description: string };
export type StoredSummary = { summary: string; contentMark: string };
export type PlacementSnapshot = { projectId: string; tickets: TreeTicket[]; summaries: Map<string, StoredSummary> };

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
 * Procura do caminho de um rascunho na árvore do projeto (ADR 0029). Quem chama já leu a árvore e os resumos
 * (`snapshot`) em transação curta. Aqui: os resumos que faltam ou mudaram são escritos pelo provedor, SEM transação
 * aberta, e gravados em transação curta que `recheck` confere de novo antes de escrever.
 */
@Injectable()
export class PlacementService {
  async search(
    draft: TicketDraft,
    snapshot: PlacementSnapshot,
    deps: {
      judge: BranchJudge;
      summarizer: BranchSummarizer;
      tenant: TenantRunner;
      /** Confere de novo permissão, projeto não arquivado e conversa aberta; lança se algo mudou. */
      recheck: (tx: TenantClient, principal: Principal) => Promise<unknown>;
      timeoutMs?: number;
    },
  ): Promise<PlacementOutcome> {
    const childrenOf = new Map<string | null, TreeTicket[]>();
    for (const ticket of [...snapshot.tickets].sort((a, b) => a.number - b.number)) {
      const list = childrenOf.get(ticket.parentId) ?? [];
      list.push(ticket);
      childrenOf.set(ticket.parentId, list);
    }
    const summaries = new Map(snapshot.summaries);
    const summaryInput = (ticket: TreeTicket): BranchSummaryInput => ({
      title: ticket.title,
      descriptionExcerpt: descriptionExcerpt(ticket.description),
      children: (childrenOf.get(ticket.id) ?? []).map((child) => ({
        title: child.title,
        summary: summaries.get(child.id)?.summary ?? null,
      })),
    });

    const candidates = async (parentId: string | null): Promise<BranchCandidate[]> => {
      // Candidatos são todos os filhos diretos (ADR 0030). Só os que têm filhos passam pelo resumidor; a folha
      // entra com o trecho da descrição.
      const children = childrenOf.get(parentId) ?? [];
      const branches = children.filter((child) => (childrenOf.get(child.id) ?? []).length > 0);
      const stale = branches
        .map((ticket) => ({ ticket, input: summaryInput(ticket) }))
        .map((entry) => ({ ...entry, mark: branchContentMark(entry.input) }))
        .filter((entry) => summaries.get(entry.ticket.id)?.contentMark !== entry.mark);
      if (stale.length > 0) {
        const written = await mapLimit(stale, SUMMARY_CONCURRENCY, async (entry) => ({
          ...entry,
          result: await deps.summarizer.summarize(entry.input),
        }));
        await deps.tenant.run(async (tx, principal) => {
          await deps.recheck(tx, principal);
          const alive = new Set(
            (await tx.ticket.findMany({ where: { id: { in: written.map((w) => w.ticket.id) } }, select: { id: true } })).map((t) => t.id),
          );
          for (const { ticket, mark, result } of written) {
            if (!alive.has(ticket.id)) continue; // removido durante a chamada: nada a guardar
            const data = { summary: result.summary, contentMark: mark, model: result.model };
            await tx.branchSummary.upsert({
              where: { orgId_ticketId: { orgId: principal.organization.orgId, ticketId: ticket.id } },
              create: { orgId: principal.organization.orgId, projectId: snapshot.projectId, ticketId: ticket.id, ...data },
              update: data,
            });
          }
        });
        for (const { ticket, mark, result } of written) summaries.set(ticket.id, { summary: result.summary, contentMark: mark });
      }
      return children.map((ticket) => {
        const hasChildren = (childrenOf.get(ticket.id) ?? []).length > 0;
        return {
          id: ticket.id,
          title: ticket.title,
          summary: hasChildren ? (summaries.get(ticket.id)?.summary ?? "") : descriptionExcerpt(ticket.description),
          hasChildren,
        };
      });
    };

    return searchPlacement(draft, {
      judge: deps.judge,
      candidates,
      fits: judgeInputFits,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
  }
}
