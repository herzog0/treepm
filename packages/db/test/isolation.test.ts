import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/index.js";
import {
  ORG_A,
  ORG_B,
  appPrisma,
  asTenant,
  ownerPool,
  seedOrg,
} from "./helpers.js";
import type { Ids } from "./helpers.js";

type TableSpec = {
  table: string;
  /** Insere uma linha com org_id de outra organização (parâmetro $1). */
  insert: string;
  /** Altera linhas da organização em $1. */
  update: string;
  /** Remove linhas da organização em $1. */
  remove: string;
  /** false quando o papel de aplicação não tem UPDATE/DELETE na tabela. */
  appCanUpdateAndDelete: boolean;
};

const TABLES: TableSpec[] = [
  {
    table: "organizations",
    insert: "insert into organizations (org_id, name, slug) values ('org_C', 'x', $1)",
    update: "update organizations set name = 'hacked' where org_id = $1",
    remove: "delete from organizations where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "people",
    insert:
      "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u2', 'X', 'x@x.io', 'member')",
    update: "update people set display_name = 'hacked' where org_id = $1",
    remove: "delete from people where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "teams",
    insert: "insert into teams (org_id, name) values ($1, 'T2')",
    update: "update teams set name = 'hacked' where org_id = $1",
    remove: "delete from teams where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "team_memberships",
    insert:
      "insert into team_memberships (org_id, team_id, person_id) values ($1, gen_random_uuid(), gen_random_uuid())",
    update: "update team_memberships set role = 'admin' where org_id = $1",
    remove: "delete from team_memberships where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "areas",
    insert: "insert into areas (org_id, name) values ($1, 'A2')",
    update: "update areas set name = 'hacked' where org_id = $1",
    remove: "delete from areas where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "projects",
    insert: "insert into projects (org_id, name, key) values ($1, 'X', 'KEY2')",
    update: "update projects set name = 'hacked' where org_id = $1",
    remove: "delete from projects where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "project_teams",
    insert:
      "insert into project_teams (org_id, project_id, team_id) values ($1, gen_random_uuid(), gen_random_uuid())",
    update: "update project_teams set updated_at = now() where org_id = $1",
    remove: "delete from project_teams where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "project_memberships",
    insert:
      "insert into project_memberships (org_id, project_id, person_id, role) values ($1, gen_random_uuid(), gen_random_uuid(), 'reader')",
    update: "update project_memberships set role = 'reader' where org_id = $1",
    remove: "delete from project_memberships where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "tickets",
    insert:
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, gen_random_uuid(), 99, 'X', gen_random_uuid())",
    update: "update tickets set title = 'hacked' where org_id = $1",
    remove: "delete from tickets where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "ticket_relations",
    insert:
      "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'mentions')",
    update: "update ticket_relations set kind = 'depends_on' where org_id = $1",
    remove: "delete from ticket_relations where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "ticket_comments",
    insert:
      "insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')",
    update: "update ticket_comments set body = 'hacked' where org_id = $1",
    remove: "delete from ticket_comments where org_id = $1",
    appCanUpdateAndDelete: false,
  },
  {
    table: "ticket_contributions",
    insert:
      "insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
    update: "update ticket_contributions set text = 'hacked' where org_id = $1",
    remove: "delete from ticket_contributions where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "ticket_contribution_people",
    insert:
      "insert into ticket_contribution_people (org_id, contribution_id, person_id) values ($1, gen_random_uuid(), gen_random_uuid())",
    update: "update ticket_contribution_people set person_id = gen_random_uuid() where org_id = $1",
    remove: "delete from ticket_contribution_people where org_id = $1",
    appCanUpdateAndDelete: false,
  },
  {
    table: "access_tokens",
    insert:
      "insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at) values ($1, gen_random_uuid(), gen_random_uuid(), 'x', 'abcd1234', md5(random()::text), now())",
    update: "update access_tokens set revoked_at = now() where org_id = $1",
    remove: "delete from access_tokens where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "organization_consents",
    insert:
      "insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ($1, 'assistant', 'rascunho-1', gen_random_uuid())",
    update: "update organization_consents set withdrawn_at = now() where org_id = $1",
    remove: "delete from organization_consents where org_id = $1",
    appCanUpdateAndDelete: false,
  },
  {
    table: "ticket_assignees",
    insert:
      "insert into ticket_assignees (org_id, ticket_id, person_id) values ($1, gen_random_uuid(), gen_random_uuid())",
    update: "update ticket_assignees set updated_at = now() where org_id = $1",
    remove: "delete from ticket_assignees where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "ticket_conversations",
    insert:
      "insert into ticket_conversations (org_id, project_id, author_person_id, status) values ($1, gen_random_uuid(), gen_random_uuid(), 'open')",
    update: "update ticket_conversations set draft_title = 'hacked', draft_description = '' where org_id = $1",
    remove: "delete from ticket_conversations where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "ticket_conversation_messages",
    insert:
      "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ($1, gen_random_uuid(), 1, 'person', 'x')",
    update: "update ticket_conversation_messages set body = 'hacked' where org_id = $1",
    remove: "delete from ticket_conversation_messages where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "branch_summaries",
    insert:
      "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, model) values ($1, gen_random_uuid(), gen_random_uuid(), 'x', 'm', 'modelo')",
    update: "update branch_summaries set summary = 'hacked' where org_id = $1",
    remove: "delete from branch_summaries where org_id = $1",
    appCanUpdateAndDelete: true,
  },
  {
    table: "activity_events",
    insert:
      "insert into activity_events (org_id, kind, subject_type, subject_id) values ($1, 'k', 't', 's')",
    update: "update activity_events set kind = 'hacked' where org_id = $1",
    remove: "delete from activity_events where org_id = $1",
    appCanUpdateAndDelete: false,
  },
];

/** UPDATE/DELETE em tabela sem esse privilégio falha por permissão: só isso é tolerado. */
function tolerate(spec: TableSpec): (error: unknown) => number {
  return (error) => {
    if (!spec.appCanUpdateAndDelete && /permission denied/i.test(String(error))) return 0;
    throw error;
  };
}

const RLS_ERROR = /row-level security/i;

let owner: pg.Pool;
let app: PrismaClient;
let idsA: Ids;
let idsB: Ids;

async function ownerCount(table: string, orgId: string): Promise<number> {
  const r = await owner.query<{ n: number }>(
    `select count(*)::int as n from ${table} where org_id = $1`,
    [orgId],
  );
  return r.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  owner = ownerPool();
  app = appPrisma();
  await owner.query("truncate organizations cascade");
  idsA = await seedOrg(owner, ORG_A);
  idsB = await seedOrg(owner, ORG_B);
  // Uma ligação por organização, para a tabela ticket_relations ter linhas a isolar.
  for (const ids of [idsA, idsB]) {
    const orgId = ids === idsA ? ORG_A : ORG_B;
    const second = await owner.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 2, 'Segundo', $3) returning id",
      [orgId, ids.project, ids.person],
    );
    await owner.query(
      "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'mentions')",
      [orgId, ids.project, second.rows[0]?.id, ids.ticket],
    );
    // Um aceite por organização, para a tabela organization_consents ter linhas a isolar.
    await owner.query(
      "insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ($1, 'assistant', 'rascunho-1', $2)",
      [orgId, ids.person],
    );
    // Um comentário por organização, para a tabela ticket_comments ter linhas a isolar.
    await owner.query(
      "insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ($1, $2, $3, $4, 'Comentário')",
      [orgId, ids.project, ids.ticket, ids.person],
    );
    // Uma contribuição (com uma pessoa) por organização, para as tabelas ticket_contributions e ticket_contribution_people.
    const contribution = await owner.query<{ id: string }>(
      "insert into ticket_contributions (org_id, project_id, ticket_id, area_id, created_by_person_id) values ($1, $2, $3, $4, $5) returning id",
      [orgId, ids.project, ids.ticket, ids.area, ids.person],
    );
    await owner.query("insert into ticket_contribution_people (org_id, contribution_id, person_id) values ($1, $2, $3)", [orgId, contribution.rows[0]?.id, ids.person]);
    // Um token por organização, para a tabela access_tokens ter linhas a isolar.
    await owner.query(
      "insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at) values ($1, $2, $3, 'T', 'abcd1234', $4, now() + interval '1 day')",
      [orgId, ids.person, ids.project, `isolation-${orgId}`],
    );
  }
});

afterAll(async () => {
  await app.$disconnect();
  await owner.end();
});

describe("papel conectado", () => {
  it("é treepm_app: sem superusuário, sem BYPASSRLS e sem ser dono das tabelas", async () => {
    const [role] = await app.$queryRawUnsafe<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(role).toEqual({
      current_user: "treepm_app",
      rolsuper: false,
      rolbypassrls: false,
    });
    const [owned] = await app.$queryRawUnsafe<{ n: number }[]>(
      "select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user",
    );
    expect(owned?.n).toBe(0);
  });

  it("toda tabela de produto tem RLS habilitado, forçado e uma política única", async () => {
    for (const { table } of TABLES) {
      const r = await owner.query<{ rls: boolean; forced: boolean; policies: number }>(
        `select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
                (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
           from pg_class c where c.oid = ('public.' || $1)::regclass`,
        [table],
      );
      expect(r.rows[0], table).toEqual({ rls: true, forced: true, policies: 1 });
    }
  });

  it("organizations tem org_id como chave primária e as demais têm (org_id, ...)", async () => {
    for (const { table } of TABLES) {
      const r = await owner.query<{ first: string }>(
        `select a.attname as first
           from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
          where i.indrelid = ('public.' || $1)::regclass and i.indisprimary`,
        [table],
      );
      expect(r.rows[0]?.first, table).toBe("org_id");
    }
  });
});

describe.each(TABLES)("isolamento por organização em $table", (spec) => {
  it("com A no contexto, lê só as linhas de A", async () => {
    const rows = await asTenant(app, ORG_A, (tx) =>
      tx.$queryRawUnsafe<{ org_id: string }[]>(`select org_id from ${spec.table}`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([ORG_A]));
    const seesB = await asTenant(app, ORG_A, (tx) =>
      tx.$queryRawUnsafe<unknown[]>(
        `select 1 from ${spec.table} where org_id = $1`,
        ORG_B,
      ),
    );
    expect(seesB).toHaveLength(0);
  });

  it("com A no contexto, não altera linhas de B", async () => {
    const affected = await asTenant(app, ORG_A, (tx) =>
      tx.$executeRawUnsafe(spec.update, ORG_B).catch(tolerate(spec)),
    );
    expect(affected).toBe(0);
    expect(await ownerCount(spec.table, ORG_B)).toBeGreaterThan(0);
    const hacked = await owner.query(
      `select 1 from ${spec.table} where org_id = $1 and (to_jsonb(${spec.table}) ->> 'name' = 'hacked' or to_jsonb(${spec.table}) ->> 'title' = 'hacked' or to_jsonb(${spec.table}) ->> 'kind' = 'hacked' or to_jsonb(${spec.table}) ->> 'display_name' = 'hacked' or to_jsonb(${spec.table}) ->> 'draft_title' = 'hacked' or to_jsonb(${spec.table}) ->> 'body' = 'hacked' or to_jsonb(${spec.table}) ->> 'text' = 'hacked' or to_jsonb(${spec.table}) ->> 'summary' = 'hacked')`,
      [ORG_B],
    );
    expect(hacked.rowCount).toBe(0);
  });

  it("com A no contexto, não remove linhas de B", async () => {
    const before = await ownerCount(spec.table, ORG_B);
    const affected = await asTenant(app, ORG_A, (tx) =>
      tx.$executeRawUnsafe(spec.remove, ORG_B).catch(tolerate(spec)),
    );
    expect(affected).toBe(0);
    expect(await ownerCount(spec.table, ORG_B)).toBe(before);
  });

  it("com A no contexto, não insere linha com org_id de outra organização", async () => {
    await expect(
      asTenant(app, ORG_A, (tx) => tx.$executeRawUnsafe(spec.insert, ORG_B)),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("sem contexto, não devolve linha alguma (falha fechada)", async () => {
    expect(await ownerCount(spec.table, ORG_A)).toBeGreaterThan(0);
    const rows = await app.$queryRawUnsafe<unknown[]>(`select 1 from ${spec.table}`);
    expect(rows).toHaveLength(0);
  });

  it("sem contexto, toda escrita é rejeitada ou não afeta linha", async () => {
    await expect(app.$executeRawUnsafe(spec.insert, ORG_A)).rejects.toThrow(RLS_ERROR);
    const before = await ownerCount(spec.table, ORG_A);
    const updated = await app.$executeRawUnsafe(spec.update, ORG_A).catch(tolerate(spec));
    const removed = await app.$executeRawUnsafe(spec.remove, ORG_A).catch(tolerate(spec));
    expect(updated).toBe(0);
    expect(removed).toBe(0);
    expect(await ownerCount(spec.table, ORG_A)).toBe(before);
  });
});

describe("activity_events é só de inserção e leitura para a aplicação", () => {
  it("rejeita UPDATE e DELETE até nas próprias linhas (sem privilégio)", async () => {
    await expect(
      asTenant(app, ORG_A, (tx) =>
        tx.$executeRawUnsafe("update activity_events set kind = 'x' where org_id = $1", ORG_A),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(app, ORG_A, (tx) =>
        tx.$executeRawUnsafe("delete from activity_events where org_id = $1", ORG_A),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("controle positivo: a política não bloqueia a própria organização", () => {
  it("A cria e lê seus dados; B continua sem vê-los", async () => {
    await asTenant(app, ORG_A, (tx) =>
      tx.team.create({ data: { orgId: ORG_A, name: "Plataforma" } }),
    );
    const names = await asTenant(app, ORG_A, (tx) => tx.team.findMany({ select: { name: true } }));
    expect(names.map((t) => t.name)).toContain("Plataforma");
    const fromB = await asTenant(app, ORG_B, (tx) => tx.team.findMany({ select: { name: true } }));
    expect(fromB.map((t) => t.name)).not.toContain("Plataforma");
  });

  it("os IDs gerados no servidor são UUID v7", async () => {
    const team = await asTenant(app, ORG_A, (tx) =>
      tx.team.create({ data: { orgId: ORG_A, name: "V7" } }),
    );
    expect(team.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("chave estrangeira composta", () => {
  it("recusa associar time de A a projeto de B (no papel de aplicação)", async () => {
    await expect(
      asTenant(app, ORG_A, (tx) =>
        tx.$executeRawUnsafe(
          "insert into project_teams (org_id, project_id, team_id) values ($1, $2::uuid, $3::uuid)",
          ORG_A,
          idsB.project,
          idsA.team,
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("recusa a relação mesmo para o papel dono, que ignora RLS: é o banco, não a política", async () => {
    for (const orgId of [ORG_A, ORG_B]) {
      await expect(
        owner.query(
          "insert into project_teams (org_id, project_id, team_id) values ($1, $2, $3)",
          [orgId, idsB.project, idsA.team],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    }
    await expect(
      owner.query(
        "insert into project_memberships (org_id, project_id, person_id, role) values ($1, $2, $3, 'reader')",
        [ORG_A, idsA.project, idsB.person],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner.query(
        "insert into team_memberships (org_id, team_id, person_id) values ($1, $2, $3)",
        [ORG_B, idsB.team, idsA.person],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("controle: papel dono e FORCE ROW LEVEL SECURITY", () => {
  it("documenta o comportamento observado do papel dono", async () => {
    // 1) O papel dono do contêiner (POSTGRES_USER) é superusuário: ignora RLS
    //    mesmo com FORCE, como o papel `neon_superuser` com BYPASSRLS no Neon.
    const sup = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(sup.rows[0]?.rolsuper || sup.rows[0]?.rolbypassrls).toBe(true);
    const seen = await owner.query<{ n: number }>(
      "select count(distinct org_id)::int as n from projects",
    );
    expect(seen.rows[0]?.n).toBe(2);

    // 2) Dono SEM superusuário e SEM BYPASSRLS: com FORCE, o RLS vale para ele.
    //    Reproduzido numa transação revertida (nada permanece).
    const client = await owner.connect();
    try {
      await client.query("begin");
      await client.query("create role treepm_probe_owner nologin nosuperuser nobypassrls");
      await client.query("grant usage on schema public to treepm_probe_owner");
      await client.query("alter table projects owner to treepm_probe_owner");
      await client.query("set local role treepm_probe_owner");
      const none = await client.query<{ n: number }>("select count(*)::int as n from projects");
      await client.query("select set_config('app.org_id', $1, true)", [ORG_A]);
      const onlyA = await client.query<{ org_id: string }>("select distinct org_id from projects");
      expect(none.rows[0]?.n).toBe(0);
      expect(onlyA.rows.map((r) => r.org_id)).toEqual([ORG_A]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
