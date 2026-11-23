import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import type { PlacementOutcome } from "./placement-search.js";

/**
 * A decisão da procura guardada (ADR 0052, item 5; migration 0028): SÓ identificadores e números. O schema é estrito de
 * propósito: um campo de texto que alguém acrescente ao rastro é recusado aqui, antes de chegar ao banco. Nenhum título,
 * trecho de descrição, rascunho ou texto de conversa passa por este arquivo.
 */
const id = z.string().uuid();
const probability = z.number().min(0).max(1);

export const decisionLevelSchema = z
  .object({
    level: z.number().int().min(1),
    parentId: id.nullable(),
    parentNumber: z.number().int().nullable(),
    result: z.enum(["descended", "band", "below_low", "no_candidates", "too_large"]),
    belongs: probability.nullable(),
    candidates: z.array(z.object({ ticketId: id, number: z.number().int(), probability }).strict()),
  })
  .strict();

export const decisionSchema = z
  .object({
    uncertain: z.boolean(),
    stopReason: z.enum(["no_candidates", "below_low", "band", "candidates_too_large", "max_levels"]).nullable(),
    chosenPath: z.array(id),
    alternatives: z.array(z.array(id)),
    scope: z.object({ ticketId: id, fit: probability.nullable() }).strict().nullable(),
    levels: z.array(decisionLevelSchema),
  })
  .strict();
export type PlacementDecisionRecord = z.output<typeof decisionSchema>;

/** Do resultado da procura para o registro: `numberOf` dá o número de cada ticket (ids que não estão no mapa viram erro). */
export function decisionOf(outcome: Pick<PlacementOutcome, "uncertain" | "trace">, numberOf: ReadonlyMap<string, number>): PlacementDecisionRecord {
  const number = (ticketId: string): number => {
    const found = numberOf.get(ticketId);
    if (found === undefined) throw new Error("ticket do rastro fora da árvore lida");
    return found;
  };
  const { trace } = outcome;
  return decisionSchema.parse({
    uncertain: outcome.uncertain,
    stopReason: trace.stop,
    chosenPath: trace.chosen,
    alternatives: trace.alternatives,
    scope: trace.scope ? { ticketId: trace.scope.id, fit: trace.scope.fit } : null,
    levels: trace.steps.map((step) => ({
      level: step.level,
      parentId: step.parentId,
      parentNumber: step.parentId === null ? null : number(step.parentId),
      result: step.result,
      belongs: step.belongs,
      candidates: step.candidates.map((candidate) => ({ ticketId: candidate.ticketId, number: number(candidate.ticketId), probability: candidate.probability })),
    })),
  });
}

/** Uma decisão por conversa: a procura nova substitui a anterior. */
export async function saveDecision(
  tx: TenantClient,
  input: { orgId: string; projectId: string; conversationId: string; record: PlacementDecisionRecord },
): Promise<void> {
  const { record } = input;
  await tx.placementDecision.deleteMany({ where: { orgId: input.orgId, conversationId: input.conversationId } });
  await tx.placementDecision.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      chosenPath: record.chosenPath,
      alternatives: record.alternatives,
      uncertain: record.uncertain,
      stopReason: record.stopReason,
      scopeTicketId: record.scope?.ticketId ?? null,
      scopeFit: record.scope?.fit ?? null,
      levels: record.levels,
    },
  });
}

/** O código do erro (Prisma `code` ou `code` da exceção), nunca o texto: a mensagem pode trazer valores. */
export function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[\w.-]{1,32}$/.test(code) ? code : error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Roda `work` num ponto de salvamento da transação: se falhar, desfaz só o trabalho dele e a transação segue válida
 * (um try/catch simples não basta, o PostgreSQL deixa a transação abortada). Devolve `failed` com o código do erro.
 */
async function guarded<T>(tx: TenantClient, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  await tx.$executeRaw`savepoint placement_decision_guard`;
  try {
    const value = await work();
    await tx.$executeRaw`release savepoint placement_decision_guard`;
    return { ok: true, value };
  } catch (error) {
    await tx.$executeRaw`rollback to savepoint placement_decision_guard`;
    return { ok: false, code: errorCode(error) };
  }
}

/**
 * Ao criar o ticket a decisão passa a ser dele: o dono troca na mesma transação e a conversa pode ser apagada sem levá-la.
 * É diagnóstico: se a troca falhar (tabela ausente, qualquer erro), a criação do ticket segue; devolve o código do erro.
 */
export async function handDecisionToTicket(tx: TenantClient, input: { orgId: string; conversationId: string; ticketId: string }): Promise<string | null> {
  const result = await guarded(tx, () =>
    tx.placementDecision.updateMany({
      where: { orgId: input.orgId, conversationId: input.conversationId },
      data: { ticketId: input.ticketId, conversationId: null },
    }),
  );
  return result.ok ? null : result.code;
}

/** Leitura segura: sem a tabela ou com qualquer falha, "sem decisão". */
export async function readDecisionSafely(tx: TenantClient, conversationId: string): Promise<PlacementDecisionRecord | null> {
  const result = await guarded(tx, () => readDecisionOfConversation(tx, conversationId));
  return result.ok ? result.value : null;
}

export async function readDecisionOfConversation(tx: TenantClient, conversationId: string): Promise<PlacementDecisionRecord | null> {
  const row = await tx.placementDecision.findFirst({ where: { conversationId } });
  if (!row) return null;
  return decisionSchema.parse({
    uncertain: row.uncertain,
    stopReason: row.stopReason,
    chosenPath: row.chosenPath,
    alternatives: row.alternatives,
    scope: row.scopeTicketId ? { ticketId: row.scopeTicketId, fit: row.scopeFit } : null,
    levels: row.levels,
  });
}
