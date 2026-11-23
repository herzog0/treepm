import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

// Migration 0029 (ADR 0052, fatia 2): a decisão guarda os tickets relacionados (ids e números), o duplicado e a regra do lugar.
const ORG = "org_DEC29";
let owner: pg.Pool;
let ids: Ids;

beforeAll(async () => {
  owner = ownerPool();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await owner.end();
});

const newConversation = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into ticket_conversations (org_id, project_id, author_person_id) values ($1,$2,$3) returning id", [ORG, ids.project, ids.person])).rows[0]?.id ?? "";

describe("placement_decisions 0029", () => {
  it("as colunas novas têm padrão: linhas da 0028 continuam válidas", async () => {
    const conversation = await newConversation();
    await owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain) values ($1,$2,$3,false)", [ORG, ids.project, conversation]);
    const row = (await owner.query("select related, duplicate_ticket_id, placement_rule from placement_decisions where conversation_id = $1", [conversation])).rows[0];
    expect(row).toEqual({ related: [], duplicate_ticket_id: null, placement_rule: null });
  });

  it("a regra do lugar só aceita os valores conhecidos e `related` precisa ser lista", async () => {
    const conversation = await newConversation();
    const insert = (rule: string | null, related: string) =>
      owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain, placement_rule, related) values ($1,$2,$3,false,$4,$5::jsonb)", [ORG, ids.project, conversation, rule, related]);
    await expect(insert("qualquer", "[]")).rejects.toThrow(/placement_rule_check/);
    await expect(insert("descent", "{}")).rejects.toThrow(/related_check/);
    await insert("related_choice", "[]");
  });
});
