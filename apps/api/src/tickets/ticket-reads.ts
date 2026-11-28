import { Prisma } from "@treepm/db";
import type { TenantClient } from "@treepm/db";
import type { QueuePlace, TicketProgress } from "@treepm/domain";
import type { IdeaStage } from "@treepm/domain";
import { labelsByTicket } from "./labels.service.js";
import { ideaStageSchema, queuePlaceSchema } from "./tickets.schema.js";
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
  due_date: string | null;
  blocked: boolean;
  place: string | null;
};

/** O ticket `x` tem lugar na fila: aberto, sem filho que não seja ideia, fora de ideia (precisa do CTE `idea_tree`, com a coluna `id`). */
const hasPlaceSql = (x: string) => Prisma.sql`(
        ${Prisma.raw(x)}.status not in ('done', 'cancelled')
        and ${Prisma.raw(x)}.id not in (select id from idea_tree)
        and not exists (
          select 1 from tickets c where c.org_id = ${Prisma.raw(x)}.org_id and c.project_id = ${Prisma.raw(x)}.project_id and c.parent_id = ${Prisma.raw(x)}.id and c.idea_stage is null
        )
      )`;

/** O ticket `x` tem dependência "para começar" aberta. */
const hasOpenStartSql = (x: string) => Prisma.sql`exists (
          select 1 from ticket_relations r2 join tickets e on e.org_id = r2.org_id and e.id = r2.to_ticket_id
          where r2.org_id = ${Prisma.raw(x)}.org_id and r2.from_ticket_id = ${Prisma.raw(x)}.id and r2.kind = 'depends_on' and r2.need = 'start' and e.status not in ('done', 'cancelled')
        )`;

/**
 * O lugar na fila (ADR 0068, seção 4) do ticket `t` da consulta, como expressão SQL: nulo para quem não tem lugar (finalizado, com filho
 * que não é ideia, ou numa ideia); `free` sem dependência "para começar" aberta; `next` quando todo alvo aberto é ele mesmo livre (tem
 * lugar e nenhuma dependência para começar aberta: alvo pai ou ideia NÃO conta como livre, decisão da revisão 1); `waiting` nos demais.
 * Precisa, no `with recursive` da consulta, de um CTE `idea_tree` com o `id` de cada ticket numa ideia que a expressão pode olhar (`t` e os
 * alvos abertos de `t`): a lista (`readSummaryRows`) desce das raízes de ideia do projeto; o ramo de um ticket (`readBranchOf`, o
 * detalhe e o `get_ticket`) sobe dos tickets pedidos e dos seus alvos, na MESMA consulta recursiva do progresso e da ideia. A regra também
 * existe em memória no domínio (`queuePlaces`); o teste `sql-oracle` confere os dois caminhos: quem mudar uma muda a outra.
 */
const QUEUE_PLACE_SQL = Prisma.sql`
      case
        when not ${hasPlaceSql("t")} then null
        when not exists (
          select 1 from ticket_relations r join tickets d on d.org_id = r.org_id and d.id = r.to_ticket_id
          where r.org_id = t.org_id and r.from_ticket_id = t.id and r.kind = 'depends_on' and r.need = 'start' and d.status not in ('done', 'cancelled')
        ) then 'free'
        when not exists (
          select 1 from ticket_relations r join tickets d on d.org_id = r.org_id and d.id = r.to_ticket_id
          where r.org_id = t.org_id and r.from_ticket_id = t.id and r.kind = 'depends_on' and r.need = 'start' and d.status not in ('done', 'cancelled')
            and (not ${hasPlaceSql("d")} or ${hasOpenStartSql("d")})
        ) then 'next'
        else 'waiting'
      end`;

const placeOf = (value: string | null): QueuePlace | null => (value === null ? null : queuePlaceSchema.parse(value));

/**
 * Os tickets do projeto como a lista do mapa e o MCP os leem, em ordem de número: SEM a descrição inteira (só os 601 primeiros
 * caracteres, o bastante para `descriptionExcerpt`) e com as pessoas, as etiquetas (ADR 0065) e o lugar na fila (ADR 0068) em UMA
 * consulta por projeto cada, não
 * um `IN` com um parâmetro por ticket (que o Postgres fatia em 32 767 e planeja a 30 ms por consulta a 20 000 tickets).
 */
export async function readSummaryRows(tx: TenantClient, projectId: string): Promise<TicketRow[]> {
  const [rows, people, labels] = await Promise.all([
    tx.$queryRaw<RawRow[]>`
      with recursive idea_tree as (
        select i.org_id, i.project_id, i.id, 1 as depth from tickets i
        where i.org_id = (select p.org_id from projects p where p.id = ${projectId}::uuid) and i.project_id = ${projectId}::uuid and i.idea_stage is not null
        union all
        select c.org_id, c.project_id, c.id, it.depth + 1 from tickets c join idea_tree it on c.org_id = it.org_id and c.project_id = it.project_id and c.parent_id = it.id
        where it.depth < ${MAX_TREE_DEPTH}::int
      )
      select id, project_id, number, parent_id, title, left(description, ${EXCERPT_SOURCE_LENGTH}::int) as description, status, idea_stage,
             agent_work_started_at, agent_work_until, agent_work_note, priority,
             to_char(due_date, 'YYYY-MM-DD') as due_date,
             (impediment_reason is not null and status not in ('done', 'cancelled')) as blocked,
             ${QUEUE_PLACE_SQL} as place
      from tickets t where project_id = ${projectId}::uuid order by number asc`,
    tx.$queryRaw<{ ticket_id: string; person_id: string }[]>`
      select a.ticket_id, a.person_id from ticket_assignees a
      join tickets t on t.org_id = a.org_id and t.id = a.ticket_id
      where t.project_id = ${projectId}::uuid`,
    labelsByTicket(tx, { projectId }),
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
    dueDate: row.due_date,
    blocked: row.blocked,
    place: placeOf(row.place),
    labels: labels.get(row.id) ?? [],
  }));
}

export type IdeaRoot = { id: string; number: number; stage: IdeaStage };
/** O ancestral mais próximo (ele incluído) com prioridade diferente de 0 (ADR 0047); `null` quando a cadeia toda é 0. */
export type PrioritySource = { id: string; number: number; value: number };
export type TicketBranch = { progress: TicketProgress | null; ideaRoot: IdeaRoot | null; prioritySource: PrioritySource | null; place: QueuePlace | null };

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
 *  - `place`: o lugar na fila (ADR 0068, `QUEUE_PLACE_SQL`). A subida também parte dos alvos abertos "para começar" de cada ticket
 *    pedido, para saber se o alvo está numa ideia, sem outra consulta recursiva.
 * Sobe e desce por `parent_id` dentro de `scope`, no máximo `MAX_TREE_DEPTH` níveis. A regra também existe em memória no domínio
 * (`ticketProgress`, `ideaRootOf`, `queuePlaces`); o teste `sql-oracle` garante que concordam: quem mudar uma muda a outra.
 */
export async function readBranchOf(tx: TenantClient, scope: TicketScope, ids: readonly string[]): Promise<Map<string, TicketBranch>> {
  const result = new Map<string, TicketBranch>();
  if (ids.length === 0) return result;
  const rows = await tx.$queryRaw<
    { origin: string; done: bigint | null; total: bigint | null; excluded: bigint | null; ideas: bigint | null; root_id: string | null; root_number: number | null; root_stage: string | null; prio_id: string | null; prio_number: number | null; prio_value: number | null; place: string | null }[]
  >`
    with recursive
    base as (select org_id, project_id, id from tickets where org_id = ${scope.orgId} and project_id = ${scope.projectId}::uuid and id = any(${[...new Set(ids)]}::uuid[])),
    sel as (
      select org_id, project_id, id from base
      union
      select d.org_id, d.project_id, d.id from base b
        join ticket_relations r on r.org_id = b.org_id and r.project_id = b.project_id and r.from_ticket_id = b.id and r.kind = 'depends_on' and r.need = 'start'
        join tickets d on d.org_id = r.org_id and d.project_id = r.project_id and d.id = r.to_ticket_id
      where d.status not in ('done', 'cancelled')
    ),
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
    -- Os tickets pedidos e os seus alvos que estão numa ideia: o que QUEUE_PLACE_SQL olha.
    idea_tree as (select origin as id from roots),
    prio as (
      select distinct on (origin) origin, id, number, priority from up where priority <> 0 order by origin, depth
    ),
    down as (
      select s.id as origin, t.org_id, t.project_id, t.id, t.status, (t.idea_stage is not null) as is_root, (t.idea_stage is not null) as inside, 1 as depth
      from base s join tickets t on t.org_id = s.org_id and t.project_id = s.project_id and t.parent_id = s.id
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
           pr.id as prio_id, pr.number as prio_number, pr.priority as prio_value,
           ${QUEUE_PLACE_SQL} as place
    from base s join tickets t on t.org_id = s.org_id and t.project_id = s.project_id and t.id = s.id
      left join counts c on c.origin = s.id left join roots r on r.origin = s.id left join prio pr on pr.origin = s.id`;
  for (const row of rows) {
    result.set(row.origin, {
      progress: row.ideas === null ? null : { done: Number(row.done), total: Number(row.total), excluded: Number(row.excluded), ideas: Number(row.ideas) },
      ideaRoot: row.root_id === null ? null : { id: row.root_id, number: row.root_number as number, stage: ideaStageSchema.parse(row.root_stage) },
      prioritySource: row.prio_id === null ? null : { id: row.prio_id, number: row.prio_number as number, value: row.prio_value as number },
      place: placeOf(row.place),
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
