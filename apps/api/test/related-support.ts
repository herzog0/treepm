import type pg from "pg";

/** Os identificadores do Linear que a origem de uma relação `related` guarda: nenhum deles pode chegar ao provedor nem sair pelo MCP. */
export const LINEAR_SENTINELS = ["rel-SENTINELA", "lin-issue-SENTINELA", "lin-related-SENTINELA", "linear.app"] as const;

/**
 * Uma relação "relacionado a" (ADR 0061) entre dois tickets, como a sincronização com o Linear grava: uma linha por par com o menor id
 * primeiro, e a origem em `external_item_refs` (kind `relation`) com os ids do Linear e o endereço da issue.
 */
export async function seedRelated(pool: pg.Pool, orgId: string, projectId: string, a: string, b: string): Promise<string> {
  const [from, to] = a < b ? [a, b] : [b, a];
  const rel = await pool.query<{ id: string }>(
    "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1,$2,$3,$4,'related') returning id",
    [orgId, projectId, from, to],
  );
  const id = rel.rows[0]?.id ?? "";
  const applied = {
    type: "related",
    relationId: "rel-SENTINELA",
    issueId: "lin-issue-SENTINELA",
    relatedIssueId: "lin-related-SENTINELA",
    url: "https://linear.app/sentinela/issue/SEN-1",
  };
  await pool.query(
    "insert into external_item_refs (org_id, project_id, ticket_id, provider, kind, external_id, local_id, applied) values ($1,$2,$3,'linear','relation',$4,$5,$6)",
    [orgId, projectId, from, `rel-SENTINELA-${id}:r:lin-related-SENTINELA`, id, JSON.stringify(applied)],
  );
  return id;
}
