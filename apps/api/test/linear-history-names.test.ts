import { LINEAR_HISTORY_NAME_CASES, linearHistoryNameRefused } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeHistoryEntry, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Histórico do Linear (ADR 0061, fatia 4; TREEPM-482), revisão H1, item 1: o nome de autor que o CHECK da 0046 recusa nunca chega ao banco.
// O domínio decide e o banco é a rede de segurança; os dois usam o mesmo predicado, conferido aqui contra a mesma lista do teste do domínio.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const at = (day: number) => new Date(Date.UTC(2026, 3, day, 10, 0)).toISOString();

/** Uma sincronização inteira; todo passo tem de responder 200 (uma recusa do banco daria 500 e a rodada ficaria presa). */
async function sync(): Promise<RunBody> {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  for (let i = 0; i < 60; i += 1) {
    const res = await post(`/${run.body.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}

describe("nome de autor que o banco recusaria", () => {
  it("o CHECK de `external_actor_name` e `linearHistoryNameRefused` concordam em cada caso da lista compartilhada", async () => {
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: { projects: [], issues: [{ id: "a", identifier: "ENG-1", title: "A" }] } });
    await sync();
    const ref = (await q("select org_id, project_id, ticket_id from ticket_external_refs where external_id = 'a'"))[0]!;
    const client = await h.pool.connect();
    const refusedByDb = async (name: string, serial: number): Promise<boolean> => {
      await client.query("begin");
      try {
        await client.query("select set_config('app.org_id', $1, true)", [ref["org_id"]]);
        await client.query(
          "insert into external_history_entries (org_id, project_id, ticket_id, provider, external_id, occurred_at, external_actor_name) values ($1, $2, $3, 'linear', $4, now(), $5)",
          [ref["org_id"], ref["project_id"], ref["ticket_id"], `h-nome-${serial}`, name],
        );
        return false;
      } catch (error) {
        if ((error as { code?: string }).code !== "23514") throw error;
        return true;
      } finally {
        await client.query("rollback");
      }
    };
    try {
      const seen: { name: string; db: boolean; domain: boolean }[] = [];
      for (const [serial, { name }] of LINEAR_HISTORY_NAME_CASES.entries()) seen.push({ name, db: await refusedByDb(name, serial), domain: linearHistoryNameRefused(name) });
      // A lista tem dos dois lados (senão a concordância não prova nada).
      expect(seen.some((item) => item.db) && seen.some((item) => !item.db)).toBe(true);
      expect(seen.filter((item) => item.db !== item.domain)).toEqual([]);
      expect(seen.map((item) => item.db)).toEqual(LINEAR_HISTORY_NAME_CASES.map((item) => item.refused));
    } finally {
      client.release();
    }
  });

  it("os quatro nomes da revisão (autor, robô e responsável): a rodada chega a `done` e as entradas entram sem nome", async () => {
    const names = ["Ana @ Acme Inc.", "@joao.silva", "Suporte @ v2.0"];
    const history: FakeHistoryEntry[] = [
      ...names.map((name, i): FakeHistoryEntry => ({ id: `h-a${i}`, createdAt: at(i + 1), actor: { id: `u-${i}`, name, email: null }, updatedDescription: true })),
      { id: "h-bot", createdAt: at(5), bot: "Sentry @ app.io", updatedDescription: true },
      { id: "h-as", createdAt: at(6), fromAssignee: { id: "u-de", name: "Ana @ Acme Inc.", email: null }, toAssignee: { id: "u-para", name: "Sentry @ app.io", email: null } },
    ];
    const team: FakeTeamData = { projects: [], issues: [{ id: "a", identifier: "ENG-1", title: "A" }], history: { a: history } };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ historyCreated: 5 });
    const rows = await q("select external_id, actor_person_id, external_actor_name, changes from external_history_entries order by external_id");
    expect(rows.map((row) => [row["external_id"], row["actor_person_id"], row["external_actor_name"]])).toEqual([
      ["h-a0", null, null],
      ["h-a1", null, null],
      ["h-a2", null, null],
      ["h-as", null, null],
      ["h-bot", null, null],
    ]);
    expect(rows.find((row) => row["external_id"] === "h-as")!["changes"]).toEqual([{ field: "assignee", from: { name: null }, to: { name: null } }]);
  });
});
