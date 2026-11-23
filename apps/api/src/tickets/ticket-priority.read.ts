import type { TenantClient } from "@treepm/db";
import { MAX_TREE_DEPTH } from "./ticket-scope.js";
import type { TicketScope } from "./ticket-scope.js";

/**
 * A prioridade que vale de cada ticket de `ids`, numa consulta só (para as leituras do MCP): sobe pelos pais até o primeiro com
 * prioridade diferente de 0 (a subida para ali) e guarda o valor dele. Ticket sem nenhum na cadeia vale 0.
 */
export async function readEffectivePriorities(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>(ids.map((id) => [id, 0] as const));
  if (ids.length === 0) return result;
  const rows = await tx.$queryRaw<{ origin: string; priority: number }[]>`
    with recursive up as (
      select t.id as origin, t.org_id, t.project_id, t.id, t.parent_id, t.priority, 1 as depth
      from tickets t where t.org_id = ${scope.orgId} and t.project_id = ${scope.projectId}::uuid and t.id = any(${[...new Set(ids)]}::uuid[])
      union all
      select up.origin, p.org_id, p.project_id, p.id, p.parent_id, p.priority, up.depth + 1
      from tickets p join up on p.org_id = up.org_id and p.project_id = up.project_id and p.id = up.parent_id
      where up.priority = 0 and up.depth < ${MAX_TREE_DEPTH}::int
    )
    select distinct on (origin) origin, priority from up where priority <> 0 order by origin, depth`;
  for (const row of rows) result.set(row.origin, row.priority);
  return result;
}
