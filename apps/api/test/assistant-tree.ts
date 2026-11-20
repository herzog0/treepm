import type pg from "pg";
import type { World } from "./world.js";

export type Tree = Record<"auth" | "login" | "sso" | "saml" | "billing" | "invoices" | "loose", string>;

/**
 * Árvore do projeto privado, semeada com o papel dono:
 *   Auth ─ Login (folha)
 *        └ SSO ─ SAML (folha)
 *   Billing ─ Invoices (folha)
 *   Solto (folha na raiz)
 * Agrupadores: Auth, SSO, Billing; os demais são tickets (ADR 0031).
 */
export async function seedTree(pool: pg.Pool, world: World): Promise<Tree> {
  const project = world.projects.priv;
  let number = 0;
  const add = async (title: string, parentId: string | null, description = "", kind = "ticket"): Promise<string> => {
    number += 1;
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, parent_kind, kind, title, description, created_by_person_id) values ('org_A',$1,$2,$3,$7,$8,$4,$5,$6) returning id",
      [project, number, parentId, title, description, world.people.manager, parentId === null ? null : "group", kind],
    );
    return r.rows[0]?.id ?? "";
  };
  const auth = await add("Auth", null, "Tudo sobre entrar no sistema", "group");
  const login = await add("Login", auth);
  const sso = await add("SSO", auth, "", "group");
  const saml = await add("SAML", sso);
  const billing = await add("Billing", null, "", "group");
  const invoices = await add("Invoices", billing);
  const loose = await add("Solto", null);
  await pool.query("update projects set next_ticket_number = $2 where id = $1", [project, number + 1]);
  return { auth, login, sso, saml, billing, invoices, loose };
}

/** Projeto privado só com agrupadores vazios na raiz (a descrição, quando dada, é a do agrupador). */
export async function seedGroups(pool: pg.Pool, world: World, groups: { title: string; description?: string }[]): Promise<string[]> {
  const project = world.projects.priv;
  const ids: string[] = [];
  for (const [index, group] of groups.entries()) {
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, kind, title, description, created_by_person_id) values ('org_A',$1,$2,null,'group',$3,$4,$5) returning id",
      [project, index + 1, group.title, group.description ?? "", world.people.manager],
    );
    ids.push(r.rows[0]?.id ?? "");
  }
  await pool.query("update projects set next_ticket_number = $2 where id = $1", [project, groups.length + 1]);
  return ids;
}
