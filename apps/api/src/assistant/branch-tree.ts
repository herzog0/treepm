import { ideaRootsOf } from "@treepm/domain";
import type { IdeaStage, TicketStatus } from "@treepm/domain";
import type { TenantClient } from "@treepm/db";
import { MAX_TREE_DEPTH } from "../tickets/ticket-scope.js";
import type { BranchNode } from "./branch-text.js";
import type { TreeTicket } from "./placement.service.js";

/** O trecho da descrição só usa os primeiros 600 pontos de código; 601 bastam para saber se há reticências (`descriptionExcerpt`). */
const EXCERPT_READ = 601;

/**
 * A árvore do projeto como a procura a vê e as notas escritas por pessoa (ADR 0052), em DUAS leituras, qualquer que seja o
 * tamanho do projeto: nenhuma consulta por candidato, e a descrição vem cortada no banco. Saem da árvore, uma vez só, aqui:
 * ideia (a raiz e o que está dentro, ADR 0043) e ticket cancelado com toda a sua subárvore (revisão 1). Notas de origem
 * "assistente" já guardadas deixam de ser lidas.
 */
export async function loadPlacementTree(tx: TenantClient, projectId: string): Promise<{ tickets: TreeTicket[]; notes: Map<string, string> }> {
  const [all, notes] = await Promise.all([
    tx.$queryRaw<{ id: string; parentId: string | null; number: number; title: string; description: string; status: string; ideaStage: string | null }[]>`
      select id, parent_id as "parentId", number, title, left(description, ${EXCERPT_READ}::int) as description, status, idea_stage as "ideaStage"
      from tickets where project_id = ${projectId}::uuid`,
    tx.branchSummary.findMany({ where: { projectId, source: "person" }, select: { ticketId: true, summary: true } }),
  ]);
  const inIdea = ideaRootsOf(all.map((t) => ({ id: t.id, parentId: t.parentId, status: t.status as TicketStatus, ideaStage: (t.ideaStage ?? null) as IdeaStage | null })));
  const cancelled = new Set(all.filter((t) => t.status === "cancelled").map((t) => t.id));
  const childrenOf = new Map<string, string[]>();
  for (const t of all) if (t.parentId !== null) childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t.id]);
  const stack = [...cancelled];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop() as string) ?? []) {
      if (!cancelled.has(child)) {
        cancelled.add(child);
        stack.push(child);
      }
    }
  }
  return {
    tickets: all.filter((t) => !inIdea.has(t.id) && !cancelled.has(t.id)).map(({ id, parentId, number, title, description, status }) => ({ id, parentId, number, title, description, status })),
    notes: new Map(notes.map((note) => [note.ticketId, note.summary])),
  };
}

/**
 * A subárvore viva de UM ticket (ele e os descendentes, sem ideias nem cancelados), para a leitura do texto do ramo: só
 * `id, parentId, number, title, status` e o trecho da descrição do próprio ticket. Consulta recursiva com o filtro explícito de
 * organização e projeto (`ticket-scope.ts`).
 */
export async function loadBranchSubtree(tx: TenantClient, scope: { orgId: string; projectId: string }, id: string): Promise<BranchNode[]> {
  const rows = await tx.$queryRaw<{ id: string; parentId: string | null; number: number; title: string; description: string; status: string }[]>`
    with recursive down as (
      select org_id, project_id, id, parent_id, number, title, status, left(description, ${EXCERPT_READ}::int) as description, 1 as depth
      from tickets where org_id = ${scope.orgId} and project_id = ${scope.projectId}::uuid and id = ${id}::uuid
      union all
      select t.org_id, t.project_id, t.id, t.parent_id, t.number, t.title, t.status, '' as description, down.depth + 1
      from tickets t join down on t.org_id = down.org_id and t.project_id = down.project_id and t.parent_id = down.id
      where down.depth < ${MAX_TREE_DEPTH}::int and t.status <> 'cancelled' and t.idea_stage is null
    )
    select id, parent_id as "parentId", number, title, status, description from down`;
  return rows.map((row) => (row.id === id ? { ...row, parentId: null } : row));
}
