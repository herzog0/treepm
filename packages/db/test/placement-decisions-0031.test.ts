import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";

// Migration 0031 (ADR 0053, fatia 2): a decisão guarda os números da triagem (palavras, vetor, diagnóstico do passo de vetor).
const ORG = "org_DEC31";
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

describe("placement_decisions 0031", () => {
  it("a coluna nova tem padrão objeto vazio: linhas anteriores continuam válidas", async () => {
    const conversation = await newConversation();
    await owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain) values ($1,$2,$3,false)", [ORG, ids.project, conversation]);
    const row = (await owner.query("select triage from placement_decisions where conversation_id = $1", [conversation])).rows[0];
    expect(row).toEqual({ triage: {} });
  });

  it("`triage` precisa ser objeto e guarda a triagem como veio", async () => {
    const conversation = await newConversation();
    const insert = (triage: string) =>
      owner.query("insert into placement_decisions (org_id, project_id, conversation_id, uncertain, triage) values ($1,$2,$3,false,$4::jsonb)", [ORG, ids.project, conversation, triage]);
    await expect(insert("[]")).rejects.toThrow(/triage_check/);
    await expect(insert("3")).rejects.toThrow(/triage_check/);
    const triage = { words: 4, vector: 30, both: 2, onlyVector: 7, sent: 30, semantic: { synced: 10, embedded: 1, pending: 0, syncMs: 5, queryMs: 9 } };
    await insert(JSON.stringify(triage));
    expect((await owner.query("select triage from placement_decisions where conversation_id = $1", [conversation])).rows[0]).toEqual({ triage });
  });
});
