import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

const ORG = "org_S1";
const CHECK = { code: "23514" };

let owner: pg.Pool;
let ids: Ids;
let counter = 100;

beforeAll(async () => {
  owner = ownerPool();
  ids = await seedOrg(owner, ORG);
});

afterAll(async () => {
  await owner.end();
});

/** Um ticket novo no projeto, para ter uma linha de resumo própria em cada caso. */
async function newTicket(): Promise<string> {
  counter += 1;
  const r = await owner.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, $3, 'T', $4) returning id",
    [ORG, ids.project, counter, ids.person],
  );
  return r.rows[0]?.id ?? "";
}

const insert = async (ticket: string, extra: string, params: unknown[] = []): Promise<void> => {
  await owner.query(
    `insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, ${extra.split("|")[0]}) values ($1, $2, $3, 's', 'm', ${extra.split("|")[1]})`,
    [ORG, ids.project, ticket, ...params],
  );
};

describe("migration 0008: origem do texto do agrupador", () => {
  it("a linha semeada como antes da migration (sem origem informada) fica 'assistant', com o modelo e sem autor", async () => {
    const r = await owner.query("select source, model, edited_by_person_id from branch_summaries where ticket_id = $1", [ids.ticket]);
    expect(r.rows[0]).toEqual({ source: "assistant", model: "claude-opus-5-5", edited_by_person_id: null });
  });

  it("a origem tem padrão 'assistant' quando não é informada", async () => {
    const ticket = await newTicket();
    await insert(ticket, "model|'claude-opus-5-5'");
    const r = await owner.query("select source from branch_summaries where ticket_id = $1", [ticket]);
    expect(r.rows[0]?.source).toBe("assistant");
  });

  it("a origem só aceita 'assistant' ou 'person'", async () => {
    const ticket = await newTicket();
    await expect(insert(ticket, "source, model|'robot', 'x'")).rejects.toMatchObject(CHECK);
    await expect(insert(ticket, "source, model|'', 'x'")).rejects.toMatchObject(CHECK);
  });

  it("modelo nulo se e só se a origem é 'person'", async () => {
    const t1 = await newTicket();
    await expect(insert(t1, "source, model|'person', 'x'")).rejects.toMatchObject(CHECK);
    await expect(insert(t1, "source, model|'assistant', null")).rejects.toMatchObject(CHECK);
    await expect(insert(t1, "model|null")).rejects.toMatchObject(CHECK); // padrão 'assistant' sem modelo
    await insert(t1, "source, model|'person', null");
    await insert(await newTicket(), "source, model|'assistant', 'claude-opus-5-5'");
  });

  it("trocar a origem para 'person' exige tirar o modelo na mesma instrução", async () => {
    const ticket = await newTicket();
    await insert(ticket, "model|'x'");
    await expect(owner.query("update branch_summaries set source = 'person' where ticket_id = $1", [ticket])).rejects.toMatchObject(CHECK);
    await owner.query("update branch_summaries set source = 'person', model = null, edited_by_person_id = $2 where ticket_id = $1", [ticket, ids.person]);
    const r = await owner.query("select source, model, edited_by_person_id from branch_summaries where ticket_id = $1", [ticket]);
    expect(r.rows[0]).toEqual({ source: "person", model: null, edited_by_person_id: ids.person });
  });

  it("remover a pessoa que editou só anula o autor: o texto e a origem ficam", async () => {
    const ticket = await newTicket();
    const person = (
      await owner.query<{ id: string }>(
        "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_edit', 'Quem editou', 'edit@x.io', 'member') returning id",
        [ORG],
      )
    ).rows[0]?.id;
    await owner.query(
      "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ($1, $2, $3, 'texto', 'm', 'person', null, $4)",
      [ORG, ids.project, ticket, person],
    );
    await owner.query("delete from people where id = $1", [person]);
    const r = await owner.query("select summary, source, edited_by_person_id from branch_summaries where ticket_id = $1", [ticket]);
    expect(r.rows[0]).toEqual({ summary: "texto", source: "person", edited_by_person_id: null });
  });
});
