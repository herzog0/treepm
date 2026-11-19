import pg from "pg";
import { createPrismaClient, withTenant } from "../src/index.js";
import type { PrismaClient, TenantClient } from "../src/index.js";
import { APP_URL, OWNER_URL } from "./env.js";

export const ORG_A = "org_A";
export const ORG_B = "org_B";

export function appPrisma(): PrismaClient {
  return createPrismaClient(APP_URL);
}

export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: OWNER_URL, max: 2 });
}

export function asTenant<T>(
  prisma: PrismaClient,
  orgId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  return withTenant(prisma, { orgId, userId: `user_of_${orgId}` }, fn);
}

export type Ids = {
  person: string;
  team: string;
  area: string;
  project: string;
  event: string;
};

/** Semeia uma organização completa pelo papel dono (que não é o caminho da API). */
export async function seedOrg(
  pool: pg.Pool,
  orgId: string,
): Promise<Ids> {
  const q = async (sql: string, params: unknown[] = []): Promise<string> => {
    const r = await pool.query<{ id: string }>(sql, params);
    return r.rows[0]?.id ?? "";
  };
  await pool.query(
    "insert into organizations (org_id, name, slug) values ($1, $2, $3)",
    [orgId, `Org ${orgId}`, orgId.toLowerCase()],
  );
  const person = await q(
    "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, $2, 'P', 'p@x.io', 'admin') returning id",
    [orgId, `user_of_${orgId}`],
  );
  const team = await q(
    "insert into teams (org_id, name) values ($1, 'T') returning id",
    [orgId],
  );
  const area = await q(
    "insert into areas (org_id, name) values ($1, 'A') returning id",
    [orgId],
  );
  const project = await q(
    "insert into projects (org_id, name, key) values ($1, 'Pr', 'KEY') returning id",
    [orgId],
  );
  await pool.query(
    "insert into team_memberships (org_id, team_id, person_id) values ($1, $2, $3)",
    [orgId, team, person],
  );
  await pool.query(
    "insert into project_teams (org_id, project_id, team_id) values ($1, $2, $3)",
    [orgId, project, team],
  );
  await pool.query(
    "insert into project_memberships (org_id, project_id, person_id, role) values ($1, $2, $3, 'manager')",
    [orgId, project, person],
  );
  const event = await q(
    "insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id) values ($1, $2, 'created', 'project', $3) returning id",
    [orgId, person, project],
  );
  return { person, team, area, project, event };
}
