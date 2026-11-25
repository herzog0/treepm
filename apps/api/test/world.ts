import { AI_CONSENT_VERSION } from "@treepm/domain";
import type pg from "pg";
import { sessionHeader } from "./helpers.js";

export const ORG = "org_A";
export const OTHER_ORG = "org_B";

export type Who = "admin" | "teamAdmin" | "manager" | "contributor" | "reader" | "plain";
export const WHO: readonly Who[] = ["admin", "teamAdmin", "manager", "contributor", "reader", "plain"];

export type World = {
  people: Record<Who | "target", string>;
  teams: { t1: string; t2: string };
  projects: { priv: string; org: string };
  other: { person: string; team: string; project: string };
};

/** Grava, pelo papel dono, um aceite em vigor (a API só grava pelas rotas; isto é só semente de teste). */
export async function giveConsent(pool: pg.Pool, orgId: string, personId: string, kind: "assistant" | "code_reading" = "assistant", version: string = AI_CONSENT_VERSION): Promise<void> {
  await pool.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ($1,$2,$3,$4)", [orgId, kind, version, personId]);
}

/** Cabeçalho de sessão de uma pessoa do mundo semeado (papel Clerk coerente com as linhas). */
export function as(who: Who | "target" | "outsider", orgId: string = ORG): string {
  return sessionHeader({
    userId: `u_${who}`,
    orgId,
    orgRole: who === "admin" ? "org:admin" : "org:member",
  });
}

/**
 * Semeia, com o papel dono, uma organização com uma pessoa por papel da matriz
 * e uma organização B. Por padrão as duas já têm o aceite `assistant` em vigor (ADR 0039), para os testes das funções de
 * IA não mudarem; `consent: false` semeia sem aceite nenhum. Não passa pela API de propósito.
 */
export async function seedWorld(pool: pg.Pool, options: { consent?: boolean } = {}): Promise<World> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => {
    const r = await pool.query<{ id: string }>(sql, params);
    return r.rows[0]?.id ?? "";
  };
  for (const org of [ORG, OTHER_ORG]) {
    await pool.query("insert into organizations (org_id, name, slug) values ($1, $2, $3)", [org, org, org.toLowerCase()]);
  }
  const person = (org: string, user: string, role: "admin" | "member") =>
    one(
      "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,$2,$3,$4,$5) returning id",
      [org, `u_${user}`, `Nome ${user}`, `${user}@exemplo.test`, role],
    );
  const people = {
    admin: await person(ORG, "admin", "admin"),
    teamAdmin: await person(ORG, "teamAdmin", "member"),
    manager: await person(ORG, "manager", "member"),
    contributor: await person(ORG, "contributor", "member"),
    reader: await person(ORG, "reader", "member"),
    plain: await person(ORG, "plain", "member"),
    target: await person(ORG, "target", "member"),
  };
  const team = (org: string, name: string) =>
    one("insert into teams (org_id, name) values ($1,$2) returning id", [org, name]);
  const t1 = await team(ORG, "T1");
  const t2 = await team(ORG, "T2");
  const project = (org: string, name: string, key: string, visibility: string) =>
    one("insert into projects (org_id, name, key, visibility) values ($1,$2,$3,$4) returning id", [
      org,
      name,
      key,
      visibility,
    ]);
  const priv = await project(ORG, "Privado", "PRIV", "private");
  const orgProject = await project(ORG, "Aberto", "OPEN", "organization");

  const tm = (teamId: string, personId: string, role: string) =>
    pool.query("insert into team_memberships (org_id, team_id, person_id, role) values ($1,$2,$3,$4)", [
      ORG,
      teamId,
      personId,
      role,
    ]);
  await tm(t1, people.teamAdmin, "admin");
  await tm(t1, people.target, "member");
  await tm(t2, people.target, "member");
  const pm = (projectId: string, personId: string, role: string) =>
    pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,$4)", [
      ORG,
      projectId,
      personId,
      role,
    ]);
  await pm(priv, people.manager, "manager");
  await pm(priv, people.contributor, "contributor");
  await pm(priv, people.reader, "reader");
  await pm(priv, people.target, "reader");
  await pool.query("insert into project_teams (org_id, project_id, team_id) values ($1,$2,$3)", [ORG, priv, t1]);

  const otherPerson = await person(OTHER_ORG, "outsider", "admin");
  if (options.consent !== false) {
    for (const [org, accepted] of [[ORG, people.admin], [OTHER_ORG, otherPerson]] as const) await giveConsent(pool, org, accepted);
  }
  const otherTeam = await team(OTHER_ORG, "TB");
  const otherProject = await project(OTHER_ORG, "Privado de B", "PRIV", "private");
  return {
    people,
    teams: { t1, t2 },
    projects: { priv, org: orgProject },
    other: { person: otherPerson, team: otherTeam, project: otherProject },
  };
}
