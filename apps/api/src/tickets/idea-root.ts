import type { TenantClient } from "@treepm/db";
import type { IdeaStage } from "@treepm/domain";
import { ideaStageSchema } from "./tickets.schema.js";
import { MAX_TREE_DEPTH } from "./ticket-scope.js";
import type { TicketScope } from "./ticket-scope.js";

/**
 * A raiz de ideia mais próxima de `startId`, ele incluído (ADR 0042): uma consulta recursiva, qualquer que seja a
 * profundidade (até `MAX_TREE_DEPTH`). `null` quando `startId` é nulo ou não está dentro de nenhuma ideia. Só anda dentro de `scope`.
 */
export async function ideaRootOfTicket(tx: TenantClient, scope: TicketScope, startId: string | null): Promise<{ id: string; number: number; stage: IdeaStage } | null> {
  if (startId === null) return null;
  const rows = await tx.$queryRaw<{ id: string; number: number; idea_stage: string }[]>`
    with recursive up as (
      select org_id, project_id, id, number, parent_id, idea_stage, 1 as depth
      from tickets where org_id = ${scope.orgId} and project_id = ${scope.projectId}::uuid and id = ${startId}::uuid
      union all
      select t.org_id, t.project_id, t.id, t.number, t.parent_id, t.idea_stage, up.depth + 1
      from tickets t join up on t.org_id = up.org_id and t.project_id = up.project_id and t.id = up.parent_id
      where up.idea_stage is null and up.depth < ${MAX_TREE_DEPTH}::int
    )
    select id, number, idea_stage from up where idea_stage is not null order by depth limit 1`;
  const row = rows[0];
  return row ? { id: row.id, number: row.number, stage: ideaStageSchema.parse(row.idea_stage) } : null;
}
