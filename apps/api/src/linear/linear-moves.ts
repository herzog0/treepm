import type { TenantClient } from "@treepm/db";

/** O gatilho de ciclo do banco (migration 0023) recusou o UPDATE? Só ele: qualquer outro erro é de verdade e não se engole. */
export function isParentCycleError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const texts: unknown[] = [(error as { message?: unknown }).message];
  try {
    texts.push(JSON.stringify((error as { meta?: unknown }).meta ?? null));
  } catch {
    // meta circular: só a mensagem vale
  }
  return texts.some((text) => typeof text === "string" && text.includes("ticket_parent_cycle"));
}

export type ParentMovesResult = {
  /** O lote foi recusado pelo gatilho de ciclo e refeito um a um. */
  usedFallback: boolean;
  /** Tickets que ficaram onde estavam porque o gatilho de ciclo recusou o item sozinho (só no fallback): não são erro, são `skipped`. */
  skipped: string[];
};

/**
 * Leva cada ticket para baixo do pai do plano. Um UPDATE em lote; se o gatilho de ciclo do banco recusar por causa da ORDEM em que
 * o lote passa pelas linhas (o plano já garante que o resultado final não tem ciclo), volta ao SAVEPOINT e refaz um a um, na ordem
 * do plano, cada um com o seu SAVEPOINT: `ticket_parent_cycle` num item deixa o item onde está (volta `skipped`) e o passo segue.
 * Qualquer outro erro propaga. O retrato do que foi aplicado acompanha o pai (só dos que andaram): sem isso a reimportação leria o
 * ticket como "mexido no TreePM".
 */
export async function applyParentMoves(tx: TenantClient, orgId: string, moves: readonly { id: string; parentId: string }[]): Promise<ParentMovesResult> {
  let applied = moves;
  const skipped: string[] = [];
  let usedFallback = false;
  await tx.$executeRaw`savepoint link_parents`;
  try {
    const ids = moves.map((move) => move.id);
    const parents = moves.map((move) => move.parentId);
    await tx.$executeRaw`update tickets t set parent_id = m.p, updated_at = now() from unnest(${ids}::uuid[], ${parents}::uuid[]) as m(id, p) where t.org_id = ${orgId} and t.id = m.id`;
    await tx.$executeRaw`release savepoint link_parents`;
  } catch (error) {
    if (!isParentCycleError(error)) throw error;
    usedFallback = true;
    await tx.$executeRaw`rollback to savepoint link_parents`;
    const done: { id: string; parentId: string }[] = [];
    for (const move of moves) {
      await tx.$executeRaw`savepoint link_one`;
      try {
        await tx.$executeRaw`update tickets set parent_id = ${move.parentId}::uuid, updated_at = now() where org_id = ${orgId} and id = ${move.id}::uuid`;
        await tx.$executeRaw`release savepoint link_one`;
        done.push(move);
      } catch (single) {
        if (!isParentCycleError(single)) throw single;
        await tx.$executeRaw`rollback to savepoint link_one`;
        skipped.push(move.id);
      }
    }
    applied = done;
  }
  if (applied.length > 0) {
    const ids = applied.map((move) => move.id);
    const parents = applied.map((move) => move.parentId);
    await tx.$executeRaw`update ticket_external_refs r set applied_snapshot = jsonb_set(r.applied_snapshot, '{parentId}', to_jsonb(m.p::text)) from unnest(${ids}::uuid[], ${parents}::uuid[]) as m(id, p) where r.org_id = ${orgId} and r.ticket_id = m.id`;
  }
  return { usedFallback, skipped };
}
