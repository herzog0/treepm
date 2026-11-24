import type pg from "pg";
import type { Harness } from "./harness.js";
import { sessionHeader } from "./helpers.js";
import { as } from "./world.js";

export const ACT_AS = "x-treepm-act-as";

/** Cria uma pessoa de teste pela API, como o administrador. */
export async function createTestPerson(h: Harness, displayName = "Bia"): Promise<{ id: string; clerkUserId: string }> {
  const res = await h.call("POST", "/api/people/test", as("admin"), { displayName });
  if (res.status !== 201) throw new Error(`createTestPerson: ${res.status} ${JSON.stringify(res.body)}`);
  const row = await h.pool.query<{ clerk_user_id: string }>("select clerk_user_id from people where id = $1::uuid", [res.body.id]);
  return { id: res.body.id as string, clerkUserId: row.rows[0]?.clerk_user_id ?? "" };
}

/** Uma pessoa de teste semeada direto no banco (outra organização, inativa…). */
export async function seedTestPerson(pool: pg.Pool, orgId: string, name: string, active = true): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "insert into people (org_id, clerk_user_id, display_name, email, clerk_role, active, is_test) values ($1,$2,$3,$4,'member',$5,true) returning id",
    [orgId, `treepm_test_seed_${name}`, name, `${name}@teste.invalid`, active],
  );
  return r.rows[0]?.id ?? "";
}

/** Como uma pessoa de teste: a sessão é a do administrador, mais o cabeçalho. */
export const actAs = (id: string): Record<string, string> => ({ [ACT_AS]: id });

/** Uma "impressão" do banco inteiro (contagem e conteúdo de cada tabela), para provar que uma recusa não mudou nada. */
export async function snapshot(pool: pg.Pool): Promise<Record<string, string>> {
  const tables = await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by 1");
  const out: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    const r = await pool.query<{ n: string; h: string | null }>(`select count(*)::text as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from "${tablename}" t`);
    out[tablename] = `${r.rows[0]?.n}:${r.rows[0]?.h}`;
  }
  return out;
}

/** Cabeçalho de sessão para um usuário qualquer (por exemplo, um identificador que não está no mundo semeado). */
export const sessionAs = (userId: string, orgId: string, orgRole: "org:admin" | "org:member"): string => sessionHeader({ userId, orgId, orgRole });
