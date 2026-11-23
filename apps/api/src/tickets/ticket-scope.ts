/**
 * Onde uma consulta recursiva sobre `tickets` pode andar: uma organização e um projeto. O RLS já isola as organizações, mas as
 * consultas não dependem só dele: toda ligação por `parent_id` repete `org_id` e `project_id` (a chave estrangeira do pai é
 * `(org_id, project_id, parent_id)`, então um pai legítimo está sempre no mesmo escopo do filho). O teste `recursive-query-guard`
 * falha se uma consulta recursiva nova esquecer isso.
 */
export type TicketScope = { readonly orgId: string; readonly projectId: string };

/**
 * Limite de níveis de TODAS as consultas recursivas de tickets, subindo ou descendo (o mesmo do gatilho de ciclo, migration 0023).
 * Uma única constante: dois limites diferentes dariam respostas diferentes para a mesma cadeia funda.
 */
export const MAX_TREE_DEPTH = 10_000;

/** O escopo de um projeto (qualquer objeto com `orgId` e `id`, como `ProjectRow`). */
export const scopeOf = (project: { readonly orgId: string; readonly id: string }): TicketScope => ({ orgId: project.orgId, projectId: project.id });
