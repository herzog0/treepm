import type pg from "pg";
import type { World } from "./world.js";

export type Tree = Record<"auth" | "login" | "sso" | "saml" | "billing" | "invoices" | "loose", string>;

/**
 * Árvore do projeto privado, semeada com o papel dono:
 *   Auth ─ Login (folha)
 *        └ SSO ─ SAML (folha)
 *   Billing ─ Invoices (folha)
 *   Solto (folha na raiz)
 * Ramos (têm filhos): Auth, SSO, Billing.
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
