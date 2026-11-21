import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, ORG_B, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

let owner: pg.Pool;
let a: Ids;
let group: string;
let b: Ids;

beforeAll(async () => {
  owner = ownerPool();
  await owner.query("truncate organizations cascade");
  a = await seedOrg(owner, ORG_A);
  b = await seedOrg(owner, ORG_B);
  // Um ticket para os testes que precisam de um pai (qualquer ticket pode ter filhos, ADR 0034).
  const grouped = await owner.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1000, 'Pai', $3) returning id",
    [ORG_A, a.project, a.person],
  );
  group = grouped.rows[0]?.id ?? "";
});

afterAll(async () => {
  await owner.end();
});

async function insertTicket(
  orgId: string,
  projectId: string,
  number: number,
  createdBy: string,
  parentId: string | null = null,
  extra = "",
): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id${extra ? ", " + extra.split("=")[0] : ""})
     values ($1, $2, $3, $4, 'T', $5${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
    [orgId, projectId, number, parentId, createdBy],
  );
  return r.rows[0]?.id ?? "";
}

describe("tickets: estrutura e restrições do banco", () => {
  it("projects ganha next_ticket_number com padrão 1", async () => {
    const r = await owner.query<{ next_ticket_number: number }>(
      "select next_ticket_number from projects where org_id = $1 and id = $2",
      [ORG_A, a.project],
    );
    expect(r.rows[0]?.next_ticket_number).toBe(1);
  });

  it("situação padrão é todo e UUID v7 é gerado", async () => {
    const r = await owner.query<{ status: string; id: string; description: string }>(
      "select status, id, description from tickets where org_id = $1 and id = $2",
      [ORG_A, a.ticket],
    );
    expect(r.rows[0]?.status).toBe("todo");
    expect(r.rows[0]?.description).toBe("");
    expect(r.rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("recusa pai de outro projeto da mesma organização (23503)", async () => {
    const other = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Outro', 'OUT') returning id",
      [ORG_A],
    );
    const otherProject = other.rows[0]?.id ?? "";
    await expect(insertTicket(ORG_A, otherProject, 1, a.person, group)).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("aceita pai do mesmo projeto", async () => {
    const child = await insertTicket(ORG_A, a.project, 2, a.person, group);
    expect(child).toBeTruthy();
  });

  it("recusa remover pai com filho (on delete restrict)", async () => {
    await expect(
      owner.query("delete from tickets where org_id = $1 and id = $2", [ORG_A, group]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("recusa número duplicado no projeto (23505)", async () => {
    await expect(insertTicket(ORG_A, a.project, 1, a.person)).rejects.toMatchObject({ code: "23505" });
  });

  it("recusa situação fora da lista (23514)", async () => {
    await expect(insertTicket(ORG_A, a.project, 50, a.person, null, "status='blocked'")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("recusa título vazio, só espaços ou acima de 200 caracteres (23514)", async () => {
    for (const title of ["", "   ", "x".repeat(201)]) {
      await expect(
        owner.query(
          "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 60, $3, $4)",
          [ORG_A, a.project, title, a.person],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await owner.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 61, $3, $4)",
      [ORG_A, a.project, "x".repeat(200), a.person],
    );
  });

  it("recusa descrição acima de 20.000 caracteres (23514)", async () => {
    await expect(
      owner.query(
        "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ($1, $2, 70, 'T', $3, $4)",
        [ORG_A, a.project, "d".repeat(20001), a.person],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await owner.query(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ($1, $2, 71, 'T', $3, $4)",
      [ORG_A, a.project, "d".repeat(20000), a.person],
    );
  });

  it("o mesmo número pode existir em outro projeto e em outra organização", async () => {
    expect(b.ticket).toBeTruthy();
    const other = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Outro2', 'OUT2') returning id",
      [ORG_A],
    );
    await insertTicket(ORG_A, other.rows[0]?.id ?? "", 1, a.person);
  });

  it("recusa ticket de uma organização em projeto de outra (23503), mesmo para o papel dono", async () => {
    await expect(insertTicket(ORG_A, b.project, 5, a.person)).rejects.toMatchObject({ code: "23503" });
  });

  it("recusa atribuir pessoa de outra organização (23503) e par duplicado (23505)", async () => {
    await expect(
      owner.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ($1, $2, $3)", [
        ORG_A,
        a.ticket,
        b.person,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ($1, $2, $3)", [
        ORG_A,
        a.ticket,
        a.person,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("remover o projeto remove seus tickets e atribuições em cascata, folhas e raízes juntos", async () => {
    const p = await owner.query<{ id: string }>(
      "insert into projects (org_id, name, key) values ($1, 'Cascata', 'CAS') returning id",
      [ORG_A],
    );
    const pid = p.rows[0]?.id ?? "";
    const root = await insertTicket(ORG_A, pid, 1, a.person);
    await insertTicket(ORG_A, pid, 2, a.person, root);
    await owner.query("delete from projects where org_id = $1 and id = $2", [ORG_A, pid]);
    const left = await owner.query("select 1 from tickets where project_id = $1", [pid]);
    expect(left.rowCount).toBe(0);
  });
});
