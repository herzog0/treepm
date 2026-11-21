import type pg from "pg";
import type { World } from "./world.js";

export type Tree = Record<"auth" | "login" | "sso" | "saml" | "billing" | "invoices" | "loose", string>;

/**
 * Árvore do projeto privado, semeada com o papel dono:
 *   Auth ─ Login (folha)
 *        └ SSO ─ SAML (folha)
 *   Billing ─ Invoices (folha)
 *   Solto (folha na raiz)
 * Auth, SSO e Billing têm filhos; os demais não (ADR 0034).
 */
export async function seedTree(pool: pg.Pool, world: World): Promise<Tree> {
  const project = world.projects.priv;
  let number = 0;
  const add = async (title: string, parentId: string | null, description = ""): Promise<string> => {
    number += 1;
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5,$6) returning id",
      [project, number, parentId, title, description, world.people.manager],
    );
    return r.rows[0]?.id ?? "";
  };
  const auth = await add("Auth", null, "Tudo sobre entrar no sistema");
  const login = await add("Login", auth);
  const sso = await add("SSO", auth);
  const saml = await add("SAML", sso);
  const billing = await add("Billing", null);
  const invoices = await add("Invoices", billing);
  const loose = await add("Solto", null);
  await pool.query("update projects set next_ticket_number = $2 where id = $1", [project, number + 1]);
  return { auth, login, sso, saml, billing, invoices, loose };
}

/**
 * Projeto privado só com tickets pais na raiz (ADR 0034): cada um recebe um filho, "Item de <título>". Os pais levam os
 * números de 1 a N e os filhos, de N + 1 a 2N. A descrição, quando dada, é a do pai.
 */
export async function seedGroups(pool: pg.Pool, world: World, groups: { title: string; description?: string }[]): Promise<string[]> {
  const project = world.projects.priv;
  const ids: string[] = [];
  for (const [index, group] of groups.entries()) {
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,$2,null,$3,$4,$5) returning id",
      [project, index + 1, group.title, group.description ?? "", world.people.manager],
    );
    ids.push(r.rows[0]?.id ?? "");
  }
  for (const [index, group] of groups.entries()) {
    await pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5)",
      [project, groups.length + index + 1, ids[index], `Item de ${group.title}`, world.people.manager],
    );
  }
  await pool.query("update projects set next_ticket_number = $2 where id = $1", [project, groups.length * 2 + 1]);
  return ids;
}

/** Projeto privado só com tickets sem filhos na raiz (o que antes era um agrupador vazio). */
export async function seedLeaves(pool: pg.Pool, world: World, leaves: { title: string; description?: string }[]): Promise<string[]> {
  const project = world.projects.priv;
  const ids: string[] = [];
  for (const [index, leaf] of leaves.entries()) {
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,$2,null,$3,$4,$5) returning id",
      [project, index + 1, leaf.title, leaf.description ?? "", world.people.manager],
    );
    ids.push(r.rows[0]?.id ?? "");
  }
  await pool.query("update projects set next_ticket_number = $2 where id = $1", [project, leaves.length + 1]);
  return ids;
}
