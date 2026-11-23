import type { TenantClient } from "@treepm/db";
import type { TicketProgress } from "@treepm/domain";
import type { IdeaStage } from "@treepm/domain";
import { ideaStageSchema } from "./tickets.schema.js";
import { MAX_TREE_DEPTH } from "./ticket-scope.js";
import type { TicketScope } from "./ticket-scope.js";
import type { TicketRow } from "./tickets.service.js";

/**
 * Quantos pontos de código da descrição o banco devolve para o trecho: `descriptionExcerpt` olha os 600 primeiros e precisa de um
 * a mais para saber se há reticências. O banco corta por caractere (`left`), a mesma unidade de `Array.from`: cortar aqui e depois
 * aplicar `descriptionExcerpt` dá o mesmo trecho que aplicar a descrição inteira.
 */
export const EXCERPT_SOURCE_LENGTH = 601;

type RawRow = {
  id: string;
  project_id: string;
  number: number;
  parent_id: string | null;
  title: string;
  description: string;
  status: string;
  idea_stage: string | null;
  agent_work_started_at: Date | null;
  agent_work_until: Date | null;
  agent_work_note: string | null;
  priority: number;
  blocked: boolean;
};

/**
 * Os tickets do projeto como a lista do mapa e o MCP os leem, em ordem de número: SEM a descrição inteira (só os 601 primeiros
 * caracteres, o bastante para `descriptionExcerpt`) e com as pessoas em UMA consulta por projeto, não um `IN` com um parâmetro por
 * ticket (que o Postgres fatia em 32 767 e planeja a 30 ms por consulta a 20 000 tickets).
 */
export async function readSummaryRows(tx: TenantClient, projectId: string): Promise<TicketRow[]> {
  const [rows, people] = await Promise.all([
    tx.$queryRaw<RawRow[]>`
      select id, project_id, number, parent_id, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, idea_stage,
             agent_work_started_at, agent_work_until, agent_work_note, priority,
             exists (
               select 1 from ticket_relations r join tickets d on d.org_id = r.org_id and d.id = r.to_ticket_id
               where r.org_id = tickets.org_id and r.from_ticket_id = tickets.id and r.kind = 'depends_on' and d.status not in ('done', 'cancelled')
             ) as blocked
      from tickets where project_id = ${projectId}::uuid order by number asc`,
    tx.$queryRaw<{ ticket_id: string; person_id: string }[]>`
      select a.ticket_id, a.person_id from ticket_assignees a
      join tickets t on t.org_id = a.org_id and t.id = a.ticket_id
      where t.project_id = ${projectId}::uuid`,
  ]);
  const assignees = new Map<string, { personId: string }[]>();
  for (const person of people) {
    const list = assignees.get(person.ticket_id);
    if (list) list.push({ personId: person.person_id });
    else assignees.set(person.ticket_id, [{ personId: person.person_id }]);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status,
    ideaStage: row.idea_stage,
    assignees: assignees.get(row.id) ?? [],
    agentWorkStartedAt: row.agent_work_started_at,
    agentWorkUntil: row.agent_work_until,
    agentWorkNote: row.agent_work_note,
    priority: row.priority,
    blocked: row.blocked,
  }));
}

export type IdeaRoot = { id: string; number: number; stage: IdeaStage };
/** O ancestral mais próximo (ele incluído) com prioridade diferente de 0 (ADR 0047); `null` quando a cadeia toda é 0. */
export type PrioritySource = { id: string; number: number; value: number };
export type TicketBranch = { progress: TicketProgress | null; ideaRoot: IdeaRoot | null; prioritySource: PrioritySource | null };

/**
 * O ramo de cada ticket de `ids` numa consulta só (um único instantâneo do banco, então progresso e ideia nunca discordam entre si):
 *  - `ideaRoot`: a raiz de ideia mais próxima, ele incluído (`null` fora de ideia);
 *  - `progress` (ADR 0034, 0042), calculado só sobre o ramo no lugar de `ticketProgress` sobre o projeto inteiro. A regra é a mesma,
 *    escrita de outra forma:
 *      · `ideas`: quantas raízes de ideia há entre os descendentes, em qualquer nível;
 *      · `done`, `total`, `excluded`: só se o ticket está fora de qualquer ideia (ele e os ancestrais sem estágio), contados entre os
 *        descendentes que também estão fora (nem raiz de ideia nem dentro de uma): `cancelled` é excluído; os outros entram no total e
 *        `done` também em `done`;
 *      · quem não tem filho tem `progress: null` (como em `ticketProgress`).
 * Sobe e desce por `parent_id` dentro de `scope`, no máximo `MAX_TREE_DEPTH` níveis. A regra também existe em memória no domínio
 * (`ticketProgress`, `ideaRootOf`); o teste `sql-oracle` garante que concordam: quem mudar uma muda a outra.
 */
export async function readBranchOf(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<Map<string, TicketBranch>> {
  const result = new Map<string, TicketBranch>();
  if (ids.length === 0) return result;
  const rows = await tx.$queryRaw<
    { origin: string; done: bigint | null; total: bigint | null; excluded: bigint | null; ideas: bigint | null; root_id: string | null; root_number: number | null; root_stage: string | null; prio_id: string | null; prio_number: number | null; prio_value: number | null }[]
  >`
    with recursive
    sel as (select org_id, project_id, id from tickets where org_id = ${scope.orgId} and project_id = ${scope.projectId}::uuid and id = any(${[...new Set(ids)]}::uuid[])),
    up as (
      select s.id as origin, t.org_id, t.project_id, t.id, t.number, t.parent_id, t.idea_stage, t.priority, 1 as depth
      from sel s join tickets t on t.org_id = s.org_id and t.project_id = s.project_id and t.id = s.id
      union all
      select up.origin, t.org_id, t.project_id, t.id, t.number, t.parent_id, t.idea_stage, t.priority, up.depth + 1
      from tickets t join up on t.org_id = up.org_id and t.project_id = up.project_id and t.id = up.parent_id
      where up.depth < ${MAX_TREE_DEPTH}::int
    ),
    roots as (
      select distinct on (origin) origin, id, number, idea_stage from up where idea_stage is not null order by origin, depth
    ),
    prio as (
      select distinct on (origin) origin, id, number, priority from up where priority <> 0 order by origin, depth
    ),
    down as (
      select s.id as origin, t.org_id, t.project_id, t.id, t.status, (t.idea_stage is not null) as is_root, (t.idea_stage is not null) as inside, 1 as depth
      from sel s join tickets t on t.org_id = s.org_id and t.project_id = s.project_id and t.parent_id = s.id
      union all
      select d.origin, t.org_id, t.project_id, t.id, t.status, (t.idea_stage is not null), (d.inside or t.idea_stage is not null), d.depth + 1
      from tickets t join down d on t.org_id = d.org_id and t.project_id = d.project_id and t.parent_id = d.id
      where d.depth < ${MAX_TREE_DEPTH}::int
    ),
    counts as (
      select origin,
        count(*) filter (where not inside and status = 'done') as done,
        count(*) filter (where not inside and status <> 'cancelled') as total,
        count(*) filter (where not inside and status = 'cancelled') as excluded,
        count(*) filter (where is_root) as ideas
      from down group by origin
    )
    select s.id as origin,
           case when r.id is null then c.done else 0 end as done,
           case when r.id is null then c.total else 0 end as total,
           case when r.id is null then c.excluded else 0 end as excluded,
           c.ideas,
           r.id as root_id, r.number as root_number, r.idea_stage as root_stage,
           pr.id as prio_id, pr.number as prio_number, pr.priority as prio_value
    from sel s left join counts c on c.origin = s.id left join roots r on r.origin = s.id left join prio pr on pr.origin = s.id`;
  for (const row of rows) {
    result.set(row.origin, {
      progress: row.ideas === null ? null : { done: Number(row.done), total: Number(row.total), excluded: Number(row.excluded), ideas: Number(row.ideas) },
      ideaRoot: row.root_id === null ? null : { id: row.root_id, number: row.root_number as number, stage: ideaStageSchema.parse(row.root_stage) },
      prioritySource: row.prio_id === null ? null : { id: row.prio_id, number: row.prio_number as number, value: row.prio_value as number },
    });
  }
  return result;
}

/** O progresso de cada ticket de `ids` que tem filhos (ver `readBranchOf`); quem não tem filho não entra no resultado. */
export async function readProgressOf(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<Map<string, TicketProgress>> {
  const result = new Map<string, TicketProgress>();
  for (const [id, branch] of await readBranchOf(tx, scope, ids)) if (branch.progress !== null) result.set(id, branch.progress);
  return result;
}
