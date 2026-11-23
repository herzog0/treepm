/**
 * Conferência de integridade depois de uma rodada de escritas concorrentes. A parte pura (`checkTreeShape`) recebe só
 * `(id, parent_id)` e acha ciclo, auto-pai e pai que não existe; o resto confere, no banco real, o que as ADR 0034, 0045 e 0046
 * prometem: nenhum concluído com filho aberto, progresso e raiz de ideia do SQL iguais aos do domínio em memória (a mesma
 * comparação de `test/sql-oracle.test.ts`) e a lista da API igual à lida do banco.
 */
import { ideaRootsOf, ticketProgress } from "@treepm/domain";
import type { TicketNode } from "@treepm/domain";
import type pg from "pg";

export interface TreeRow { readonly id: string; readonly parent_id: string | null }
export interface TreeShape {
  /** Ids que estão em algum ciclo ou que descem de um (não alcançam uma raiz). */
  readonly cycle: string[];
  readonly selfParent: string[];
  /** `parent_id` aponta para um id que não está no conjunto (órfão). */
  readonly orphan: string[];
}

export function checkTreeShape(rows: readonly TreeRow[]): TreeShape {
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id] as const));
  const selfParent = rows.filter((r) => r.parent_id === r.id).map((r) => r.id);
  const orphan = rows.filter((r) => r.parent_id !== null && !parentOf.has(r.parent_id)).map((r) => r.id);
  // 0 = não visitado, 1 = no caminho atual, 2 = chega a uma raiz (ou a um órfão, já contado à parte).
  const state = new Map<string, number>();
  const cycle: string[] = [];
  for (const row of rows) {
    const path: string[] = [];
    let cursor: string | null = row.id;
    let ok = true;
    while (cursor !== null) {
      const s = state.get(cursor) ?? 0;
      if (s === 2) break;
      if (s === 1) {
        ok = false;
        break;
      }
      state.set(cursor, 1);
      path.push(cursor);
      const next: string | null | undefined = parentOf.get(cursor);
      cursor = next === undefined ? null : next;
    }
    for (const id of path) state.set(id, ok ? 2 : 3);
    if (!ok) cycle.push(...path);
    // Um caminho que bateu em um nó já marcado como 3 (dentro de ciclo) também não chega a uma raiz.
    else if (cursor !== null && state.get(cursor) === 3) {
      for (const id of path) state.set(id, 3);
      cycle.push(...path);
    }
  }
  return { cycle: [...new Set(cycle)], selfParent, orphan };
}

type FullRow = { id: string; parent_id: string | null; status: TicketNode["status"]; idea_stage: string | null; number: number; title: string; priority: number };

export interface IntegrityReport {
  readonly tickets: number;
  readonly shape: TreeShape;
  /** Concluído com filho direto aberto (ADR 0034). */
  readonly doneWithOpenChild: string[];
  /** Tickets cujo progresso do domínio em memória difere do que a leitura SQL do produto devolve (`readBranchOf`). */
  readonly progressMismatch: string[];
  readonly ideaRootMismatch: string[];
  readonly ticketsVersion: number;
  readonly ok: boolean;
}

export type ReadBranch = (ids: string[]) => Promise<Map<string, { progress: unknown; ideaRoot: { id: string } | null }>>;

/** `readBranch`: a função do produto (`readBranchOf`) já ligada a um cliente e ao escopo; injetada para o teste não depender dela. */
export async function checkIntegrity(pool: pg.Pool, projectId: string, readBranch?: ReadBranch): Promise<IntegrityReport> {
  const rows = (await pool.query<FullRow>("select id, parent_id, status, idea_stage, number, title, priority from tickets where project_id = $1 order by number", [projectId])).rows;
  const version = Number(((await pool.query<{ v: string }>("select tickets_version::text as v from projects where id = $1", [projectId])).rows[0] as { v: string }).v);
  const shape = checkTreeShape(rows);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const closed = (s: string): boolean => s === "done" || s === "cancelled";
  const doneWithOpenChild = [...new Set(rows.filter((r) => r.parent_id !== null && !closed(r.status) && byId.get(r.parent_id)?.status === "done").map((r) => r.parent_id as string))];
  const progressMismatch: string[] = [];
  const ideaRootMismatch: string[] = [];
  // O domínio em memória só é definido para árvore sem ciclo.
  if (readBranch && shape.cycle.length === 0) {
    const nodes: TicketNode[] = rows.map((r) => ({ id: r.id, parentId: r.parent_id, status: r.status, ideaStage: r.idea_stage as TicketNode["ideaStage"] }));
    const progress = ticketProgress(nodes);
    const roots = ideaRootsOf(nodes);
    const branches = await readBranch(rows.map((r) => r.id));
    for (const r of rows) {
      const b = branches.get(r.id);
      if (!b || JSON.stringify(b.progress) !== JSON.stringify(progress.get(r.id) ?? null)) progressMismatch.push(r.id);
      if ((b?.ideaRoot?.id ?? null) !== (roots.get(r.id) ?? null)) ideaRootMismatch.push(r.id);
    }
  }
  return {
    tickets: rows.length,
    shape,
    doneWithOpenChild,
    progressMismatch,
    ideaRootMismatch,
    ticketsVersion: version,
    ok: shape.cycle.length + shape.selfParent.length + shape.orphan.length + doneWithOpenChild.length + progressMismatch.length + ideaRootMismatch.length === 0,
  };
}

export interface ListedTicket { id: string; parentId: string | null; title: string; status: string; priority: number; number: number; assigneeIds: string[] }

/** A lista devolvida pela API (sem `If-None-Match`) contra as linhas do banco: ids, título, situação, pai, prioridade própria e pessoas. */
export async function compareListWithDatabase(pool: pg.Pool, projectId: string, listed: readonly ListedTicket[]): Promise<string[]> {
  const rows = (await pool.query<FullRow & { assignees: string[] }>(
    "select t.id, t.parent_id, t.status, t.idea_stage, t.number, t.title, t.priority, coalesce(array(select person_id::text from ticket_assignees a where a.ticket_id = t.id order by 1), '{}') as assignees from tickets t where t.project_id = $1",
    [projectId],
  )).rows;
  const diffs: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  if (rows.length !== listed.length) diffs.push(`contagem: banco ${rows.length}, lista ${listed.length}`);
  for (const t of listed) {
    const r = byId.get(t.id);
    if (!r) diffs.push(`${t.id}: na lista e fora do banco`);
    else if (r.parent_id !== t.parentId || r.title !== t.title || r.status !== t.status || r.priority !== t.priority || r.number !== t.number || JSON.stringify([...t.assigneeIds].sort()) !== JSON.stringify([...r.assignees].sort()))
      diffs.push(`${t.id} (#${r.number}): lista ${JSON.stringify({ p: t.parentId, s: t.status, pr: t.priority, a: t.assigneeIds.length })} × banco ${JSON.stringify({ p: r.parent_id, s: r.status, pr: r.priority, a: r.assignees.length })}`);
  }
  const seen = new Set(listed.map((t) => t.id));
  for (const r of rows) if (!seen.has(r.id)) diffs.push(`${r.id} (#${r.number}): no banco e fora da lista`);
  return diffs.slice(0, 50);
}
