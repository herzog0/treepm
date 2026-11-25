import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0037 (ADR 0060, TREEPM-428): credencial cifrada por pessoa e vínculo permanente do projeto com um time do Linear.
const ORG_1 = "org_L37a";
const ORG_2 = "org_L37b";
let owner: pg.Pool;
let prisma: PrismaClient;
let a: Ids;
let b: Ids;
let secondProject: string;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  a = await seedOrg(owner, ORG_1);
  b = await seedOrg(owner, ORG_2);
  const r = await owner.query<{ id: string }>("insert into projects (org_id, name, key) values ($1,'Outro','OUT') returning id", [ORG_1]);
  secondProject = r.rows[0]?.id ?? "";
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

const credential = (orgId: string, personId: string, provider = "linear") =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
      values (${orgId}, ${personId}::uuid, ${provider}, ${Buffer.from("cifrado-0123456789ab")}, ${Buffer.alloc(12, 3)}, 1, 'ws-1', 'Acme', 'abcd')`,
  );

const source = (orgId: string, projectId: string, personId: string, teamId = "team-1") =>
  asTenant(prisma, orgId, (tx) =>
    tx.$executeRaw`insert into project_external_sources (org_id, project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id)
      values (${orgId}, ${projectId}::uuid, 'linear', 'ws-1', 'Acme', ${teamId}, 'ENG', 'Engenharia', ${personId}::uuid)`,
  );

describe("external_credentials", () => {
  it("o papel da aplicação grava, lê, substitui e apaga a credencial da pessoa", async () => {
    expect(await failure(() => credential(ORG_1, a.person))).toBeNull();
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.externalCredential.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "linear", keyVersion: 1, externalWorkspaceName: "Acme", secretHint: "abcd" });
    await asTenant(prisma, ORG_1, (tx) => tx.externalCredential.update({ where: { orgId_personId_provider: { orgId: ORG_1, personId: a.person, provider: "linear" } }, data: { secretHint: "wxyz" } }));
    expect((await owner.query("select secret_hint from external_credentials where org_id = $1", [ORG_1])).rows[0]).toEqual({ secret_hint: "wxyz" });
    await asTenant(prisma, ORG_1, (tx) => tx.externalCredential.deleteMany());
    expect((await owner.query("select 1 from external_credentials where org_id = $1", [ORG_1])).rowCount).toBe(0);
  });

  it("uma credencial por pessoa e provedor", async () => {
    await credential(ORG_1, a.person);
    expect(await failure(() => credential(ORG_1, a.person))).toMatch(/duplicate key|unique/i);
    await owner.query("delete from external_credentials where org_id = $1", [ORG_1]);
  });

  it.each([
    ["provedor fora da lista", (o: string, p: string) => credential(o, p, "github")],
  ])("recusa %s", async (_n, run) => {
    expect(await failure(() => run(ORG_1, a.person))).toMatch(/check constraint/i);
  });

  it("recusa nonce com tamanho errado, versão 0 e dica vazia ou longa", async () => {
    const bad = (nonce: Buffer, version: number, hint: string) =>
      asTenant(prisma, ORG_1, (tx) =>
        tx.$executeRaw`insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
          values (${ORG_1}, ${a.person}::uuid, 'linear', ${Buffer.from("x")}, ${nonce}, ${version}, 'w', 'W', ${hint})`,
      );
    const cases: [Buffer, number, string][] = [[Buffer.alloc(11), 1, "abcd"], [Buffer.alloc(12), 0, "abcd"], [Buffer.alloc(12), 1, ""], [Buffer.alloc(12), 1, "abcde"]];
    for (const [nonce, version, hint] of cases) {
      expect(await failure(() => bad(nonce, version, hint))).toMatch(/check constraint/i);
    }
  });

  it("RLS: outra organização não lê, não grava para esta organização e não apaga", async () => {
    await credential(ORG_1, a.person);
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalCredential.findMany())).toHaveLength(0);
    expect(await failure(() => credential(ORG_2, a.person))).not.toBeNull(); // pessoa de outra organização
    const forged = await failure(() =>
      asTenant(prisma, ORG_2, (tx) =>
        tx.$executeRaw`insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
          values (${ORG_1}, ${a.person}::uuid, 'linear', ${Buffer.from("x")}, ${Buffer.alloc(12)}, 1, 'w', 'W', 'abcd')`,
      ),
    );
    expect(forged).toMatch(/row-level security/i);
    expect(await asTenant(prisma, ORG_2, (tx) => tx.externalCredential.deleteMany())).toMatchObject({ count: 0 });
    expect((await owner.query("select 1 from external_credentials where org_id = $1", [ORG_1])).rowCount).toBe(1);
    await owner.query("delete from external_credentials where org_id = $1", [ORG_1]);
  });

  it("remover a pessoa remove a credencial dela", async () => {
    const p = (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,'u_tmp37','Tmp','t@x.io','member') returning id", [ORG_1])).rows[0]?.id ?? "";
    await credential(ORG_1, p);
    await owner.query("delete from people where id = $1::uuid", [p]);
    expect((await owner.query("select 1 from external_credentials where person_id = $1::uuid", [p])).rowCount).toBe(0);
  });
});

describe("project_external_sources (vínculo permanente)", () => {
  it("o papel da aplicação insere e lê", async () => {
    expect(await failure(() => source(ORG_1, a.project, a.person))).toBeNull();
    const rows = await asTenant(prisma, ORG_1, (tx) => tx.projectExternalSource.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "linear", externalTeamKey: "ENG", externalWorkspaceId: "ws-1" });
  });

  it("apagar o projeto ligado, pelo papel da aplicação, falha (a FK é RESTRICT, não CASCADE)", async () => {
    const del = await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from projects where org_id = ${ORG_1} and id = ${a.project}::uuid`));
    expect(del).toMatch(/foreign key|violates|restrict/i);
    const rows = await owner.query("select 1 from projects where id = $1::uuid", [a.project]);
    expect(rows.rows).toHaveLength(1);
    expect((await owner.query("select 1 from project_external_sources where project_id = $1::uuid", [a.project])).rows).toHaveLength(1);
    // O banco registra a regra: ON DELETE RESTRICT (confdeltype 'r').
    const fk = await owner.query("select confdeltype from pg_constraint where conname = 'project_external_sources_org_id_project_id_fkey'");
    expect(fk.rows).toEqual([{ confdeltype: "r" }]);
  });

  it("o papel da aplicação NÃO atualiza (nem uma coluna) nem apaga", async () => {
    const update = await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`update project_external_sources set external_team_id = 'outro' where org_id = ${ORG_1}`));
    expect(update).toMatch(/permission denied/i);
    const updateName = await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`update project_external_sources set external_team_name = 'x' where org_id = ${ORG_1}`));
    expect(updateName).toMatch(/permission denied/i);
    const del = await failure(() => asTenant(prisma, ORG_1, (tx) => tx.$executeRaw`delete from project_external_sources where org_id = ${ORG_1}`));
    expect(del).toMatch(/permission denied/i);
    const row = await owner.query("select external_team_id, external_team_name from project_external_sources where org_id = $1", [ORG_1]);
    expect(row.rows).toEqual([{ external_team_id: "team-1", external_team_name: "Engenharia" }]);
  });

  it("um projeto tem no máximo uma origem", async () => {
    expect(await failure(() => source(ORG_1, a.project, a.person, "team-2"))).toMatch(/duplicate key|unique/i);
  });

  it("o mesmo time não entra em dois projetos da organização, mas entra em outra organização", async () => {
    expect(await failure(() => source(ORG_1, secondProject, a.person, "team-1"))).toMatch(/duplicate key|unique/i);
    expect(await failure(() => source(ORG_2, b.project, b.person, "team-1"))).toBeNull();
  });

  it("RLS: outra organização não lê nem grava nesta", async () => {
    expect(await asTenant(prisma, ORG_2, (tx) => tx.projectExternalSource.findMany({ where: { orgId: ORG_1 } }))).toHaveLength(0);
    expect(await failure(() => source(ORG_2, a.project, a.person, "team-9")) ).not.toBeNull();
    const forged = await failure(() =>
      asTenant(prisma, ORG_2, (tx) =>
        tx.$executeRaw`insert into project_external_sources (org_id, project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id)
          values (${ORG_1}, ${secondProject}::uuid, 'linear', 'ws', 'W', 'team-forjado', 'K', 'N', ${a.person}::uuid)`,
      ),
    );
    expect(forged).toMatch(/row-level security/i);
  });

  it("recusa provedor fora da lista", async () => {
    const msg = await failure(() =>
      asTenant(prisma, ORG_1, (tx) =>
        tx.$executeRaw`insert into project_external_sources (org_id, project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id)
          values (${ORG_1}, ${secondProject}::uuid, 'jira', 'ws', 'W', 'team-j', 'K', 'N', ${a.person}::uuid)`,
      ),
    );
    expect(msg).toMatch(/check constraint/i);
  });
});
