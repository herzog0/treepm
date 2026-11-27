/**
 * Grava um plano de projeto grande (`plan.ts`) no PostgreSQL de teste, em lote e pelo papel dono.
 *
 * Por que SQL em lote e não os serviços: `POST …/tickets/import` aceita no máximo 500 itens, não cria ideias, marcadores de
 * trabalho pela IA, comentários, contribuições nem eventos de histórico, e criar 20 000 tickets um a um custaria várias
 * idas ao banco por ticket (e a trava da linha do projeto a cada criação). Em troca, o carregamento ignora as regras dos
 * serviços; por isso o plano as respeita (ver `plan.ts`) e `load.ts` confere o resultado contra a própria API nos testes.
 *
 * Só toca em bancos de teste de medição (`treepm_p<N>` ou `treepm_test`): a ferramenta apaga TODAS as organizações do banco.
 */
import type pg from "pg";
import type { BigProjectPlan } from "./plan.js";

export const PERF_ORG = "org_perf";
export const PERF_ADMIN_USER = "u_perf_admin";
const BATCH = 800;

export function assertMeasurementDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/^treepm_(p\d+|test)$/.test(name)) throw new Error(`Banco recusado: "${name}". A ferramenta de medição só roda em treepm_p<N> ou treepm_test.`);
}

type Column = { name: string; array: string; cast?: string };

/** `insert … select … from unnest(arrays)`: uma ida ao banco por lote, qualquer que seja o número de linhas. */
async function insertRows(db: pg.Pool | pg.PoolClient, table: string, columns: readonly Column[], rows: readonly (readonly unknown[])[]): Promise<void> {
  for (let from = 0; from < rows.length; from += BATCH) {
    const slice = rows.slice(from, from + BATCH);
    const params = columns.map((_, c) => slice.map((row) => row[c] ?? null));
    const select = columns.map((column, c) => `t.c${c}${column.cast ? `::${column.cast}` : ""}`).join(", ");
    const unnest = columns.map((column, c) => `$${c + 1}::${column.array}[]`).join(", ");
    const names = columns.map((_, c) => `c${c}`).join(", ");
    await db.query(`insert into ${table} (${columns.map((column) => column.name).join(", ")}) select ${select} from unnest(${unnest}) as t(${names})`, params);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface LoadSummary {
  readonly org: string;
  readonly projectId: string;
  readonly key: string;
  readonly seconds: number;
  readonly counts: Record<string, number>;
}

export async function loadBigProject(pool: pg.Pool, plan: BigProjectPlan): Promise<LoadSummary> {
  const started = performance.now();
  const org = PERF_ORG;
  const { key, now } = plan.options;
  const client = await pool.connect();
  const { projectId } = plan;
  try {
    await client.query("begin");
    await client.query("truncate organizations cascade");
    await client.query("insert into organizations (org_id, name, slug, mcp_enabled, mcp_write_enabled) values ($1,$2,$3,true,false)", [org, "Organização de medição", "org-perf"]);
    await insertRows(client, "people", [
      { name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "clerk_user_id", array: "text" }, { name: "display_name", array: "text" }, { name: "email", array: "text" }, { name: "clerk_role", array: "text", cast: "clerk_role" },
    ], plan.people.map((p, i) => [org, p.id, p.clerkUserId, p.name, p.email, i === 0 ? "admin" : "member"]));
    await insertRows(client, "areas", [{ name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "name", array: "text" }], plan.areas.map((a) => [org, a.id, a.name]));
    await client.query("insert into projects (org_id, id, name, key, visibility, next_ticket_number) values ($1,$2,$3,$4,'organization',$5)", [org, projectId, `Projeto grande (${plan.tickets.length})`, key, plan.tickets.length + 1]);

    const tickets = plan.tickets;
    const id = (index: number | null): string | null => (index === null ? null : (tickets[index] as { id: string }).id);
    await insertRows(client, "tickets", [
      { name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "project_id", array: "uuid" }, { name: "number", array: "int" }, { name: "parent_id", array: "uuid" },
      { name: "title", array: "text" }, { name: "description", array: "text" }, { name: "status", array: "text" }, { name: "idea_stage", array: "text" },
      { name: "agent_work_started_at", array: "timestamptz" }, { name: "agent_work_until", array: "timestamptz" }, { name: "agent_work_person_id", array: "uuid" }, { name: "agent_work_note", array: "text" },
      { name: "created_by_person_id", array: "uuid" }, { name: "created_at", array: "timestamptz" }, { name: "updated_at", array: "timestamptz" },
    ], tickets.map((t) => [
      org, t.id, projectId, t.number, id(t.parent), t.title, t.description, t.status, t.ideaStage,
      t.agentWork ? iso(now - 30 * 60_000) : null, t.agentWork ? iso(now + 3 * 86_400_000) : null, t.agentWork ? plan.people[0]!.id : null, t.agentWork ? t.agentWork.note : null,
      plan.people[t.createdBy]!.id, iso(t.createdAt), iso(t.createdAt),
    ]));
    await insertRows(client, "ticket_assignees", [{ name: "org_id", array: "text" }, { name: "ticket_id", array: "uuid" }, { name: "person_id", array: "uuid" }],
      tickets.flatMap((t) => t.assignees.map((a) => [org, t.id, plan.people[a]!.id])));
    await insertRows(client, "ticket_relations", [
      { name: "org_id", array: "text" }, { name: "project_id", array: "uuid" }, { name: "from_ticket_id", array: "uuid" }, { name: "to_ticket_id", array: "uuid" }, { name: "kind", array: "text" }, { name: "need", array: "text" },
    ], plan.relations.map((r) => [org, projectId, id(r.from), id(r.to), r.kind, r.kind === "depends_on" ? (r.need ?? "start") : null]));
    await insertRows(client, "ticket_contributions", [
      { name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "project_id", array: "uuid" }, { name: "ticket_id", array: "uuid" }, { name: "area_id", array: "uuid" },
      { name: "text", array: "text" }, { name: "status", array: "text" }, { name: "created_at", array: "timestamptz" }, { name: "created_by_person_id", array: "uuid" },
    ], plan.contributions.map((c) => [org, c.id, projectId, id(c.ticket), plan.areas[c.area]!.id, c.text, c.status, iso(c.at), plan.people[c.createdBy]!.id]));
    await insertRows(client, "ticket_contribution_people", [{ name: "org_id", array: "text" }, { name: "contribution_id", array: "uuid" }, { name: "person_id", array: "uuid" }],
      plan.contributions.flatMap((c) => c.people.map((p) => [org, c.id, plan.people[p]!.id])));
    await insertRows(client, "ticket_comments", [
      { name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "project_id", array: "uuid" }, { name: "ticket_id", array: "uuid" }, { name: "author_person_id", array: "uuid" },
      { name: "body", array: "text" }, { name: "created_at", array: "timestamptz" }, { name: "contribution_id", array: "uuid" },
    ], plan.comments.map((c) => [org, c.id, projectId, id(c.ticket), plan.people[c.author]!.id, c.body, iso(c.at), c.contribution]));
    await insertRows(client, "activity_events", [
      { name: "org_id", array: "text" }, { name: "id", array: "uuid" }, { name: "actor_person_id", array: "uuid" }, { name: "kind", array: "text" }, { name: "subject_type", array: "text" },
      { name: "subject_id", array: "text" }, { name: "payload", array: "text", cast: "jsonb" }, { name: "occurred_at", array: "timestamptz" },
    ], plan.events.map((e) => [org, e.id, plan.people[e.actor]!.id, e.kind, "ticket", id(e.ticket), JSON.stringify(e.payload), iso(e.at)]));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Sem estatísticas novas o planejador escolheria planos de tabela vazia; em produção o autovacuum faz isto sozinho.
  await pool.query("analyze");
  return {
    org,
    projectId,
    key,
    seconds: (performance.now() - started) / 1000,
    counts: {
      tickets: plan.tickets.length,
      relations: plan.relations.length,
      events: plan.events.length,
      comments: plan.comments.length,
      contributions: plan.contributions.length,
      assignees: plan.tickets.reduce((sum, t) => sum + t.assignees.length, 0),
    },
  };
}
