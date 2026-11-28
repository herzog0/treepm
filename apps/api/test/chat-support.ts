import type pg from "pg";
import type { Harness } from "./harness.js";
import { as } from "./world.js";
import type { Who, World } from "./world.js";

/** Textos únicos semeados em tudo o que o assistente NÃO pode ver (ADR 0049); se um aparecer num pedido ao provedor, o teste falha. */
export const SENTINEL = {
  comment: "SENTINELA-COMENTARIO-91f2",
  history: "SENTINELA-HISTORICO-5c0d",
  area: "SENTINELA-AREA-77ab",
  note: "SENTINELA-NOTA-MARCADOR-3e19",
  otherPerson: "SENTINELA-MENSAGEM-DE-OUTRA-PESSOA-a8d4",
  thread: "SENTINELA-THREAD-ENTRE-PESSOAS-62bf",
  threadReply: "SENTINELA-RESPOSTA-DE-THREAD-0c7e",
  grandchild: "SENTINELA-NETO-NAO-VAI-b1a3",
} as const;

export type ChatTickets = {
  root: string;
  parent: string;
  ticket: string;
  child1: string;
  child2: string;
  grandchild: string;
  dependsOn: string;
  blocker: string;
  keys: Record<"root" | "parent" | "ticket" | "child1" | "child2" | "grandchild" | "dependsOn" | "blocker", string>;
};

/**
 * No projeto privado (PRIV): Raiz(1, prioridade 5) → Pai(2) → Ticket(3, com tudo) → Filho um(4, em andamento) → Neto(8); Filho dois(5);
 * Ticket depende de "Depende deste"(6) e é bloqueio de "Bloqueado por"(7). O ticket leva um comentário, um evento de histórico, uma
 * contribuição de área e um marcador de trabalho, todos com texto sentinela, e o gestor como responsável.
 */
export async function seedChatTickets(pool: pg.Pool, world: World): Promise<ChatTickets> {
  const project = world.projects.priv;
  const manager = world.people.manager;
  const add = async (number: number, title: string, parent: string | null, extra: { description?: string; status?: string; priority?: number } = {}): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, status, priority, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5,$6,$7,$8) returning id",
      [project, number, parent, title, extra.description ?? "", extra.status ?? "todo", extra.priority ?? 0, manager],
    );
    return r.rows[0]?.id ?? "";
  };
  const root = await add(1, "Raiz do caminho", null, { priority: 5 });
  const parent = await add(2, "Pai do ticket", root);
  const ticket = await add(3, "Ticket do chat", parent, { description: "Descrição do ticket do chat.", status: "in_progress" });
  const child1 = await add(4, "Filho um", ticket, { status: "in_progress" });
  const child2 = await add(5, "Filho dois", ticket);
  const dependsOn = await add(6, "Depende deste", null, { status: "done" });
  const blocker = await add(7, "Bloqueado por este", null);
  const grandchild = await add(8, SENTINEL.grandchild, child1);
  await pool.query("update projects set next_ticket_number = 9 where id = $1", [project]);
  await pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind, need) values ('org_A',$1,$2,$3,'depends_on','start'), ('org_A',$1,$4,$2,'depends_on','start')", [project, ticket, dependsOn, blocker]);
  await pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A',$1,$2)", [ticket, manager]);
  await pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ('org_A',$1,$2,$3,$4)", [project, ticket, manager, SENTINEL.comment]);
  await pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload) values ('org_A',$1,'ticket.updated','ticket',$2,$3)", [manager, ticket, JSON.stringify({ note: SENTINEL.history })]);
  const area = (await pool.query<{ id: string }>("insert into areas (org_id, name) values ('org_A','Área sentinela') returning id")).rows[0]?.id ?? "";
  await pool.query("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5)", [project, ticket, area, SENTINEL.area, manager]);
  await pool.query("update tickets set agent_work_started_at = now(), agent_work_until = now() + interval '1 hour', agent_work_person_id = $2, agent_work_note = $3 where id = $1", [ticket, manager, SENTINEL.note]);
  return { root, parent, ticket, child1, child2, grandchild, dependsOn, blocker, keys: { root: "PRIV-1", parent: "PRIV-2", ticket: "PRIV-3", child1: "PRIV-4", child2: "PRIV-5", grandchild: "PRIV-8", dependsOn: "PRIV-6", blocker: "PRIV-7" } };
}

/** Abre (ou obtém) a conversa principal da pessoa no ticket e devolve o id. */
export async function openTicket(h: Harness, who: Who | "target", ticket: string): Promise<string> {
  const res = await h.call("POST", `/api/tickets/${ticket}/conversation`, as(who));
  if (res.status !== 200) throw new Error(`openTicket ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}
export async function openGeneral(h: Harness, who: Who | "target"): Promise<string> {
  const res = await h.call("POST", "/api/conversations/general", as(who));
  if (res.status !== 200) throw new Error(`openGeneral ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}
/** Mensagem numa conversa pelo id (principal ou thread). */
export const post = (h: Harness, who: Who | "target", conversation: string, body: string, mentions?: string[], ticketId?: string) =>
  h.call("POST", `/api/conversations/${conversation}/messages`, as(who), { body, ...(mentions ? { mentions } : {}), ...(ticketId ? { ticketId } : {}) });
/** Abre uma thread de assunto (o texto livre vira conversa com o assistente) dentro de uma conversa principal. */
export const topic = (h: Harness, who: Who | "target", conversation: string, body: string, extra: Record<string, unknown> = {}) =>
  h.call("POST", `/api/conversations/${conversation}/messages`, as(who), { body, topic: true, ...extra });
/** Mensagem na conversa principal da pessoa no ticket (abre a conversa antes). */
export const send = async (h: Harness, who: Who | "target", ticket: string, body: string, mentions?: string[]) => post(h, who, await openTicket(h, who, ticket), body, mentions);
export const reply = post;
export const view = (h: Harness, who: Who | "target", conversation: string, query = "") => h.call("GET", `/api/conversations/${conversation}${query}`, as(who));
export const ticketView = (h: Harness, who: Who | "target", ticket: string, query = "") => h.call("GET", `/api/tickets/${ticket}/conversation${query}`, as(who));
export const errorCode = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

let extraPeople = 0;
/** Uma pessoa nova da organização A, administradora (enxerga tudo): para marcar alguém de fora a cada nível sem esgotar o elenco. */
export async function newOutsider(pool: pg.Pool): Promise<string> {
  extraPeople += 1;
  const tag = `extra${extraPeople}_${Date.now()}`;
  return (await pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_A',$1,$2,$3,'admin') returning id", [`u_${tag}`, `Nome ${tag}`, `${tag}@exemplo.test`])).rows[0]!.id;
}
