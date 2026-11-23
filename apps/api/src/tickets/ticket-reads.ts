import type { TenantClient } from "@treepm/db";
import type { TicketProgress } from "@treepm/domain";
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
             agent_work_started_at, agent_work_until, agent_work_note
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
  }));
}

/**
 * O progresso (ADR 0034, 0042) de cada ticket de `ids` que tem filhos, calculado pelo banco só sobre o ramo de cada um, no lugar de
 * `ticketProgress` sobre o projeto inteiro. A regra é a mesma, escrita de outra forma:
 *  - `ideas`: quantas raízes de ideia há entre os descendentes, em qualquer nível;
 *  - `done`, `total`, `excluded`: só se o ticket está fora de qualquer ideia (ele e os ancestrais sem estágio), contados entre os
 *    descendentes que também estão fora (nem raiz de ideia nem dentro de uma): `cancelled` é excluído; os outros entram no total e
 *    `done` também em `done`;
 *  - quem não tem filho não entra no resultado (como em `ticketProgress`).
 * Sobe e desce por `parent_id`, no máximo 10 000 níveis (o mesmo limite do gatilho de ciclo).
 */
export async function readProgressOf(tx: TenantClient, ids: readonly string[]): Promise<Map<string, TicketProgress>> {
  const result = new Map<string, TicketProgress>();
  if (ids.length === 0) return result;
  const rows = await tx.$queryRaw<{ origin: string; done: bigint; total: bigint; excluded: bigint; ideas: bigint }[]>`
    with recursive
    sel as (select id from tickets where id = any(${[...ids]}::uuid[])),
    up as (
      select s.id as origin, t.parent_id, t.idea_stage, 1 as depth from sel s join tickets t on t.id = s.id
      union all
      select up.origin, t.parent_id, t.idea_stage, up.depth + 1 from tickets t join up on t.id = up.parent_id where up.depth < 10000
    ),
    outside as (select origin, bool_and(idea_stage is null) as outside from up group by origin),
    down as (
      select s.id as origin, t.id, t.status, (t.idea_stage is not null) as is_root, (t.idea_stage is not null) as inside, 1 as depth
      from sel s join tickets t on t.parent_id = s.id
      union all
      select d.origin, t.id, t.status, (t.idea_stage is not null), (d.inside or t.idea_stage is not null), d.depth + 1
      from tickets t join down d on t.parent_id = d.id where d.depth < 10000
    ),
    counts as (
      select origin,
        count(*) filter (where not inside and status = 'done') as done,
        count(*) filter (where not inside and status <> 'cancelled') as total,
        count(*) filter (where not inside and status = 'cancelled') as excluded,
        count(*) filter (where is_root) as ideas
      from down group by origin
    )
    select o.origin,
           case when o.outside then c.done else 0 end as done,
           case when o.outside then c.total else 0 end as total,
           case when o.outside then c.excluded else 0 end as excluded,
           c.ideas
    from outside o join counts c on c.origin = o.origin`;
  for (const row of rows) {
    result.set(row.origin, { done: Number(row.done), total: Number(row.total), excluded: Number(row.excluded), ideas: Number(row.ideas) });
  }
  return result;
}
