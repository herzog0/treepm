import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG_G1 = "org_G1";
const ORG_G2 = "org_G2";
const TABLES = ["github_installations", "project_repositories", "ticket_code_links", "repository_sync_pages"] as const;

let owner: pg.Pool;
let prisma: PrismaClient;
let g1: Ids;
let g2: Ids;
let counter = 1000;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  g1 = await seedOrg(owner, ORG_G1);
  g2 = await seedOrg(owner, ORG_G2);
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

/** O SQLSTATE do erro do Prisma com o adaptador pg; `undefined` quando a instrução passou. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta;
    return meta?.driverAdapterError?.cause?.originalCode ?? "outro";
  }
}

async function ownerState(sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await owner.query(sql, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? "outro";
  }
}

function sql(orgId: string, text: string, ...params: unknown[]): Promise<number> {
  return asTenant(prisma, orgId, (tx) => tx.$executeRawUnsafe(text, ...params));
}

async function ids(orgId: string, text: string, ...params: unknown[]): Promise<string[]> {
  const rows = await asTenant(prisma, orgId, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(text, ...params));
  return rows.map((row) => row.id);
}

async function count(orgId: string, table: string): Promise<number> {
  const rows = await asTenant(prisma, orgId, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`));
  return rows[0]?.n ?? 0;
}

type Fixture = { installation: string; repository: string; installationId: number };

/** Instalação + repositório do projeto semeado, pelo papel dono (a organização precisa estar livre). */
async function fixture(orgId: string, owned: Ids, installationId = ++counter): Promise<Fixture> {
  const installation = (
    await owner.query<{ id: string }>(
      `insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by_person_id)
       values ($1, $2, 'herzog0', 'User', 'selected', $3) returning id`,
      [orgId, installationId, owned.person],
    )
  ).rows[0]?.id;
  const repository = (
    await owner.query<{ id: string }>(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch, linked_by_person_id)
       values ($1, $2, $3, $4, 'herzog0/app', 'https://github.com/herzog0/app', true, 'main', $5) returning id`,
      [orgId, owned.project, installation, ++counter, owned.person],
    )
  ).rows[0]?.id;
  return { installation: installation ?? "", repository: repository ?? "", installationId };
}

async function clear(orgId: string): Promise<void> {
  await owner.query("delete from github_installations where org_id = $1", [orgId]);
}

describe("migration 0007_github — estrutura", () => {
  it("cria as quatro tabelas", async () => {
    const rows = await owner.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1) order by table_name",
      [[...TABLES]],
    );
    expect(rows.rows.map((row) => row.table_name)).toEqual([...TABLES].sort());
  });

  it("todas têm RLS ativa e forçada, a política tenant_isolation e GRANT ao treepm_app", async () => {
    const flags = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any($1) order by relname",
      [[...TABLES]],
    );
    expect(flags.rows).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
    const policies = await owner.query<{ tablename: string }>(
      "select tablename from pg_policies where policyname = 'tenant_isolation' and tablename = any($1) order by tablename",
      [[...TABLES]],
    );
    expect(policies.rows.map((row) => row.tablename)).toEqual([...TABLES].sort());
    for (const table of TABLES) {
      const grants = await owner.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
        `select has_table_privilege('treepm_app', $1, 'select') as s, has_table_privilege('treepm_app', $1, 'insert') as i,
                has_table_privilege('treepm_app', $1, 'update') as u, has_table_privilege('treepm_app', $1, 'delete') as d`,
        [table],
      );
      expect(grants.rows[0], table).toEqual({ s: true, i: true, u: true, d: true });
    }
  });

  it("nenhuma coluna guarda token, chave ou conteúdo de arquivo", async () => {
    const columns = await owner.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = any($1)",
      [[...TABLES]],
    );
    expect(columns.rows.length).toBeGreaterThan(0);
    for (const { column_name } of columns.rows) expect(column_name).not.toMatch(/token|secret|key|content|body|blob/);
  });
});

describe("github_installations", () => {
  it("a organização grava a própria instalação e a lê", async () => {
    await clear(ORG_G1);
    const state = await sqlState(
      sql(
        ORG_G1,
        `insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection)
         values ($1, 9001, 'herzog0', 'User', 'all')`,
        ORG_G1,
      ),
    );
    expect(state).toBeUndefined();
    expect(await count(ORG_G1, "github_installations")).toBe(1);
    await clear(ORG_G1);
  });

  it("uma organização tem no máximo uma instalação (UNIQUE org_id)", async () => {
    await clear(ORG_G1);
    await fixture(ORG_G1, g1, 9101);
    const state = await sqlState(
      sql(
        ORG_G1,
        `insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection)
         values ($1, 9102, 'outra', 'User', 'all')`,
        ORG_G1,
      ),
    );
    expect(state).toBe("23505");
    await clear(ORG_G1);
  });

  it("uma instalação do GitHub pertence a uma só organização, mesmo com RLS escondendo a linha da outra", async () => {
    await clear(ORG_G1);
    await clear(ORG_G2);
    await fixture(ORG_G1, g1, 9201);
    expect(await count(ORG_G2, "github_installations")).toBe(0);
    const state = await sqlState(
      sql(
        ORG_G2,
        `insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection)
         values ($1, 9201, 'herzog0', 'User', 'all')`,
        ORG_G2,
      ),
    );
    expect(state).toBe("23505");
    expect(await count(ORG_G2, "github_installations")).toBe(0);
    await clear(ORG_G1);
  });

  it("a conta, o tipo e a seleção só aceitam valores válidos", async () => {
    await clear(ORG_G1);
    const insert = (type: string, selection: string, login = "herzog0") =>
      ownerState(
        `insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection)
         values ($1, ${++counter}, $2, $3, $4)`,
        [ORG_G1, login, type, selection],
      );
    expect(await insert("User", "bogus")).toBe("23514");
    expect(await insert("", "all")).toBe("23514");
    expect(await insert("User", "all", "")).toBe("23514");
    expect(await insert("Organization", "selected")).toBeUndefined();
    await clear(ORG_G1);
  });

  it("outra organização não lê, não altera nem remove a instalação", async () => {
    await clear(ORG_G1);
    await fixture(ORG_G1, g1, 9301);
    expect(await count(ORG_G2, "github_installations")).toBe(0);
    expect(await sql(ORG_G2, "update github_installations set account_login = 'hacked'")).toBe(0);
    expect(await sql(ORG_G2, "delete from github_installations")).toBe(0);
    expect(await sqlState(sql(ORG_G2, "insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection) values ('org_G1', 9302, 'x', 'User', 'all')"))).toBe("42501");
    const rows = await owner.query("select 1 from github_installations where org_id = $1 and account_login = 'herzog0'", [ORG_G1]);
    expect(rows.rowCount).toBe(1);
    await clear(ORG_G1);
  });

  it("remover quem conectou só anula connected_by_person_id", async () => {
    await clear(ORG_G1);
    const extra = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_extra', 'E', 'e@x.io', 'member') returning id", [ORG_G1])).rows[0]?.id ?? "";
    await owner.query("insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by_person_id) values ($1, 9401, 'h', 'User', 'all', $2)", [ORG_G1, extra]);
    await owner.query("delete from people where org_id = $1 and id = $2", [ORG_G1, extra]);
    const rows = await owner.query<{ connected_by_person_id: string | null }>("select connected_by_person_id from github_installations where org_id = $1", [ORG_G1]);
    expect(rows.rows).toEqual([{ connected_by_person_id: null }]);
    await clear(ORG_G1);
  });
});

describe("project_repositories", () => {
  it("o mesmo repositório não se liga duas vezes ao mesmo projeto", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    const repoId = (await owner.query<{ repo_id: string }>("select repo_id from project_repositories where org_id = $1", [ORG_G1])).rows[0]?.repo_id;
    const state = await ownerState(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
       values ($1, $2, $3, $4, 'x/y', 'https://github.com/x/y', false, 'main')`,
      [ORG_G1, g1.project, fx.installation, repoId],
    );
    expect(state).toBe("23505");
    await clear(ORG_G1);
  });

  it("o mesmo repositório pode estar em projetos diferentes", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    const repoId = (await owner.query<{ repo_id: string }>("select repo_id from project_repositories where org_id = $1", [ORG_G1])).rows[0]?.repo_id;
    const other = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Outro', 'OTR') returning id", [ORG_G1])).rows[0]?.id;
    const state = await ownerState(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
       values ($1, $2, $3, $4, 'x/y', 'https://github.com/x/y', false, 'main')`,
      [ORG_G1, other, fx.installation, repoId],
    );
    expect(state).toBeUndefined();
    await owner.query("delete from projects where org_id = $1 and key = 'OTR'", [ORG_G1]);
    await clear(ORG_G1);
  });

  it("o projeto e a instalação têm que ser da mesma organização (chave composta)", async () => {
    await clear(ORG_G1);
    await clear(ORG_G2);
    const fx1 = await fixture(ORG_G1, g1);
    const state = await ownerState(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
       values ($1, $2, $3, 777, 'x/y', 'https://github.com/x/y', false, 'main')`,
      [ORG_G2, g2.project, fx1.installation],
    );
    expect(state).toBe("23503");
    const cross = await ownerState(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
       values ($1, $2, $3, 778, 'x/y', 'https://github.com/x/y', false, 'main')`,
      [ORG_G1, g2.project, fx1.installation],
    );
    expect(cross).toBe("23503");
    await clear(ORG_G1);
  });

  it("outra organização não lê nem escreve", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await count(ORG_G2, "project_repositories")).toBe(0);
    expect(await sql(ORG_G2, "update project_repositories set full_name = 'hacked'")).toBe(0);
    expect(await sql(ORG_G2, "delete from project_repositories")).toBe(0);
    expect(
      await sqlState(
        sql(
          ORG_G2,
          `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
           values ('org_G1', $1::uuid, $2::uuid, 1, 'x/y', 'u', false, 'main')`,
          g1.project,
          fx.installation,
        ),
      ),
    ).toBe("42501");
    await clear(ORG_G1);
  });

  it("remover o projeto remove os repositórios ligados a ele", async () => {
    await clear(ORG_G1);
    await fixture(ORG_G1, g1);
    const doomed = (await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1, 'Doomed', 'DMD') returning id", [ORG_G1])).rows[0]?.id ?? "";
    const inst = (await owner.query<{ id: string }>("select id from github_installations where org_id = $1", [ORG_G1])).rows[0]?.id ?? "";
    await owner.query(
      `insert into project_repositories (org_id, project_id, installation_row_id, repo_id, full_name, html_url, private, default_branch)
       values ($1, $2, $3, 5, 'x/y', 'u', false, 'main')`,
      [ORG_G1, doomed, inst],
    );
    await owner.query("delete from projects where org_id = $1 and id = $2", [ORG_G1, doomed]);
    const left = await owner.query("select 1 from project_repositories where org_id = $1 and project_id = $2", [ORG_G1, doomed]);
    expect(left.rowCount).toBe(0);
    const kept = await owner.query("select 1 from project_repositories where org_id = $1", [ORG_G1]);
    expect(kept.rowCount).toBe(1);
    await clear(ORG_G1);
  });

  it("remover a instalação remove os repositórios, os vínculos de código e as marcas de sincronização", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    await owner.query(
      `insert into ticket_code_links (org_id, project_id, ticket_id, project_repository_id, kind, ref, state, url, seen_at)
       values ($1, $2, $3, $4, 'branch', 'feat/x', 'active', 'u', now())`,
      [ORG_G1, g1.project, g1.ticket, fx.repository],
    );
    await owner.query("insert into repository_sync_pages (org_id, project_repository_id, resource, page, etag) values ($1, $2, 'branches', 1, 'W/\"a\"')", [ORG_G1, fx.repository]);
    await owner.query("delete from github_installations where org_id = $1", [ORG_G1]);
    for (const table of ["project_repositories", "ticket_code_links", "repository_sync_pages"]) {
      const left = await owner.query(`select 1 from ${table} where org_id = $1`, [ORG_G1]);
      expect(left.rowCount, table).toBe(0);
    }
    expect((await owner.query("select 1 from tickets where org_id = $1", [ORG_G1])).rowCount).toBe(1);
  });

  it("remover quem ligou só anula linked_by_person_id", async () => {
    await clear(ORG_G1);
    const extra = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_extra2', 'E', 'e@x.io', 'member') returning id", [ORG_G1])).rows[0]?.id ?? "";
    const fx = await fixture(ORG_G1, g1);
    await owner.query("update project_repositories set linked_by_person_id = $2 where org_id = $1", [ORG_G1, extra]);
    await owner.query("delete from people where org_id = $1 and id = $2", [ORG_G1, extra]);
    const rows = await owner.query<{ linked_by_person_id: string | null }>("select linked_by_person_id from project_repositories where org_id = $1 and id = $2", [ORG_G1, fx.repository]);
    expect(rows.rows).toEqual([{ linked_by_person_id: null }]);
    await clear(ORG_G1);
  });
});

describe("ticket_code_links", () => {
  const link = (fx: Fixture, ids: Ids, over: Partial<Record<string, unknown>> = {}) => {
    const row = {
      org_id: ORG_G1,
      project_id: ids.project,
      ticket_id: ids.ticket,
      project_repository_id: fx.repository,
      kind: "branch",
      ref: "feat/x",
      number: null,
      title: null,
      state: "active",
      url: "https://github.com/herzog0/app/tree/feat/x",
      provider_updated_at: null,
      ...over,
    };
    const columns = Object.keys(row);
    return ownerState(
      `insert into ticket_code_links (${columns.join(", ")}, seen_at) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}, now())`,
      Object.values(row),
    );
  };

  it("aceita um branch ativo e um PR aberto, mesclado ou fechado", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await link(fx, g1)).toBeUndefined();
    for (const [i, state] of (["open", "merged", "closed"] as const).entries()) {
      expect(await link(fx, g1, { kind: "pull_request", ref: "feat/x", number: 10 + i, title: "PR", state, provider_updated_at: new Date() })).toBeUndefined();
    }
    await clear(ORG_G1);
  });

  it("os CHECK barram combinações inválidas, cada caso violando uma regra só", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    const pr = { kind: "pull_request", number: 4, title: "T", state: "open", provider_updated_at: new Date() };
    expect(await link(fx, g1, pr)).toBeUndefined(); // o PR-base é válido: cada variação abaixo muda uma coisa só
    expect(await link(fx, g1, { kind: "tag" })).toBe("23514"); // tipo desconhecido
    expect(await link(fx, g1, { number: 3 })).toBe("23514"); // branch com número
    expect(await link(fx, g1, { title: "T" })).toBe("23514"); // branch com título
    expect(await link(fx, g1, { provider_updated_at: new Date() })).toBe("23514"); // branch com data do provedor
    expect(await link(fx, g1, { state: "open" })).toBe("23514"); // branch só active
    expect(await link(fx, g1, { state: "merged" })).toBe("23514");
    expect(await link(fx, g1, { ref: "" })).toBe("23514"); // ref vazio
    expect(await link(fx, g1, { ...pr, number: null })).toBe("23514"); // PR sem número
    expect(await link(fx, g1, { ...pr, number: 0 })).toBe("23514"); // número menor que 1
    expect(await link(fx, g1, { ...pr, number: 5, state: "active" })).toBe("23514"); // PR não é active
    expect(await link(fx, g1, { ...pr, number: 5, state: "weird" })).toBe("23514");
    expect(await link(fx, g1, { ...pr, number: 5, provider_updated_at: null })).toBe("23514"); // PR exige a data
    await clear(ORG_G1);
  });

  it("branch é único por repositório, ticket e nome; PR, por repositório, ticket e número", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await link(fx, g1)).toBeUndefined();
    expect(await link(fx, g1)).toBe("23505");
    expect(await link(fx, g1, { ref: "feat/y" })).toBeUndefined();
    const pr = { kind: "pull_request", number: 7, title: "T", state: "open", provider_updated_at: new Date() };
    expect(await link(fx, g1, pr)).toBeUndefined();
    expect(await link(fx, g1, { ...pr, ref: "outro-branch" })).toBe("23505");
    expect(await link(fx, g1, { ...pr, number: 8 })).toBeUndefined();
    await clear(ORG_G1);
  });

  it("o ticket tem que ser do projeto do repositório da mesma organização (chaves compostas)", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await link(fx, g1, { ticket_id: g2.ticket })).toBe("23503");
    expect(await link(fx, g1, { project_id: g2.project })).toBe("23503");
    await clear(ORG_G1);
  });

  it("remover o ticket ou o repositório remove o vínculo", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    const t2 = (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 2, 'T2', $3) returning id", [ORG_G1, g1.project, g1.person])).rows[0]?.id ?? "";
    expect(await link(fx, g1)).toBeUndefined();
    expect(await link(fx, { ...g1, ticket: t2 })).toBeUndefined();
    await owner.query("delete from tickets where org_id = $1 and id = $2", [ORG_G1, t2]);
    expect((await owner.query("select 1 from ticket_code_links where org_id = $1", [ORG_G1])).rowCount).toBe(1);
    await owner.query("delete from project_repositories where org_id = $1", [ORG_G1]);
    expect((await owner.query("select 1 from ticket_code_links where org_id = $1", [ORG_G1])).rowCount).toBe(0);
    await clear(ORG_G1);
  });

  it("outra organização não lê nem escreve", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await link(fx, g1)).toBeUndefined();
    expect(await count(ORG_G2, "ticket_code_links")).toBe(0);
    expect(await sql(ORG_G2, "update ticket_code_links set title = 'hacked'")).toBe(0);
    expect(await sql(ORG_G2, "delete from ticket_code_links")).toBe(0);
    expect(
      await sqlState(
        sql(
          ORG_G2,
          `insert into ticket_code_links (org_id, project_id, ticket_id, project_repository_id, kind, ref, state, url, seen_at)
           values ('org_G1', $1::uuid, $2::uuid, $3::uuid, 'branch', 'b', 'active', 'u', now())`,
          g1.project,
          g1.ticket,
          fx.repository,
        ),
      ),
    ).toBe("42501");
    await clear(ORG_G1);
  });
});

describe("repository_sync_pages", () => {
  const page = (fx: Fixture, over: Partial<Record<string, unknown>> = {}) => {
    const row = { org_id: ORG_G1, project_repository_id: fx.repository, resource: "branches", page: 1, etag: 'W/"abc"', ...over };
    const columns = Object.keys(row);
    return ownerState(`insert into repository_sync_pages (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  };

  it("aceita branches e pulls; barra recurso desconhecido e página menor que 1", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await page(fx)).toBeUndefined();
    expect(await page(fx, { resource: "pulls" })).toBeUndefined();
    expect(await page(fx, { resource: "contents" })).toBe("23514");
    expect(await page(fx, { page: 0 })).toBe("23514");
    await clear(ORG_G1);
  });

  it("a chave é (organização, repositório, recurso, página)", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await page(fx)).toBeUndefined();
    expect(await page(fx)).toBe("23505");
    expect(await page(fx, { page: 2 })).toBeUndefined();
    await clear(ORG_G1);
  });

  it("outra organização não lê nem escreve", async () => {
    await clear(ORG_G1);
    const fx = await fixture(ORG_G1, g1);
    expect(await page(fx)).toBeUndefined();
    expect(await count(ORG_G2, "repository_sync_pages")).toBe(0);
    expect(await sql(ORG_G2, "update repository_sync_pages set etag = 'x'")).toBe(0);
    expect(await sql(ORG_G2, "delete from repository_sync_pages")).toBe(0);
    expect(
      await sqlState(
        sql(ORG_G2, "insert into repository_sync_pages (org_id, project_repository_id, resource, page, etag) values ('org_G1', $1::uuid, 'pulls', 1, 'e')", fx.repository),
      ),
    ).toBe("42501");
    await clear(ORG_G1);
  });
});

describe("isolamento pela API de dados", () => {
  it("as listas de uma organização nunca trazem linhas da outra", async () => {
    await clear(ORG_G1);
    await clear(ORG_G2);
    await fixture(ORG_G1, g1);
    await fixture(ORG_G2, g2);
    for (const table of ["github_installations", "project_repositories"]) {
      expect(await ids(ORG_G1, `select id::text from ${table}`)).toHaveLength(1);
      expect(await ids(ORG_G2, `select id::text from ${table}`)).toHaveLength(1);
      expect(await ids(ORG_G1, `select id::text from ${table}`)).not.toEqual(await ids(ORG_G2, `select id::text from ${table}`));
    }
    await clear(ORG_G1);
    await clear(ORG_G2);
  });
});
