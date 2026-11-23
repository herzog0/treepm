import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERF_ORG } from "../scripts/big-project/load.js";
import { createTestApp, ownerPoolWithCleanup } from "./helpers.js";
import { loadPerfWorld, perfClock, perfSession } from "./perf-support.js";
import type { PerfWorld } from "./perf-support.js";
import { recordQueries } from "./query-recorder.js";

// Um limite de profundidade só (TREEPM-253): subir ou descer por `parent_id` vai até `MAX_TREE_DEPTH` em TODAS as consultas. Antes
// a raiz de ideia parava em 1 000 e as outras em 10 000, então uma cadeia de 1 500 níveis dava ideia no detalhe e ... outra na lista.
const pool = ownerPoolWithCleanup();
let app: INestApplication;
let world: PerfWorld;
const get = (path: string) => request(app.getHttpServer()).get(path).set("x-test-session", perfSession);
const DEPTH = 1500;

type Chain = { ids: string[] };

/** Uma cadeia de `DEPTH` tickets, cada um filho do anterior; o primeiro é a raiz (de ideia, se `stage`). */
async function insertChain(firstNumber: number, stage: string | null): Promise<Chain> {
  const ids = Array.from({ length: DEPTH }, () => randomUUID());
  const person = (await pool.query<{ id: string }>("select id from people where org_id = $1 limit 1", [PERF_ORG])).rows[0]!.id;
  const parents: (string | null)[] = [null, ...ids.slice(0, -1)];
  await pool.query(
    `insert into tickets (org_id, id, project_id, number, parent_id, title, description, status, idea_stage, created_by_person_id)
     select $1, t.id, $2, $3::int + (t.i - 1)::int, t.parent, 'Nível ' || t.i, '', 'todo', case when t.i = 1 then $4 else null end, $5
     from unnest($6::uuid[], $7::uuid[]) with ordinality as t(id, parent, i)`,
    [PERF_ORG, world.plan.projectId, firstNumber, stage, person, ids, parents],
  );
  return { ids };
}

beforeAll(async () => {
  ({ app } = await createTestApp([], undefined, { clock: perfClock }));
  world = await loadPerfWorld(pool, 400);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("cadeia de 1 500 níveis: a mesma ideia no detalhe e na lista", () => {
  it("ideia no topo: o detalhe do fundo da cadeia aponta a mesma raiz que a lista", async () => {
    const chain = await insertChain(10_000, "ready");
    const list = (await get(`/api/projects/${world.plan.projectId}/tickets`)).body as { id: string; idea: unknown; progress: unknown }[];
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    const rootId = chain.ids[0]!;
    for (const index of [0, 1, 499, 999, 1000, 1001, 1498, 1499]) {
      const id = chain.ids[index]!;
      const detail = (await get(`/api/tickets/${id}`)).body as { idea: unknown; progress: unknown };
      const entry = byId.get(id)!;
      expect(detail.idea, `nível ${index + 1}`).toEqual(entry.idea);
      expect(detail.progress, `nível ${index + 1}`).toEqual(entry.progress);
      expect(detail.idea).toEqual(index === 0 ? { root: true, stage: "ready" } : { root: false, rootId, rootKey: "BG-10000" });
    }
  });

  it("ticket comum no fim da cadeia: nenhuma ideia em ambos, e o progresso do topo conta toda a cadeia", async () => {
    const chain = await insertChain(20_000, null);
    const list = (await get(`/api/projects/${world.plan.projectId}/tickets`)).body as { id: string; idea: unknown; progress: unknown }[];
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    const top = (await get(`/api/tickets/${chain.ids[0]}`)).body as { idea: unknown; progress: { done: number; total: number } };
    expect(top.idea).toBeNull();
    expect(top.progress).toEqual(byId.get(chain.ids[0]!)!.progress);
    expect(top.progress.total).toBe(DEPTH - 1);
    const leaf = (await get(`/api/tickets/${chain.ids[DEPTH - 1]}`)).body as { idea: unknown };
    expect(leaf.idea).toBeNull();
    expect(byId.get(chain.ids[DEPTH - 1]!)!.idea).toBeNull();
  });

  it("o detalhe lê progresso e ideia na MESMA consulta recursiva (um instantâneo só)", async () => {
    const f = world.plan.fixtures;
    const id = world.plan.tickets[f.shallow]!.id;
    const recorded = await recordQueries(async () => (await get(`/api/tickets/${id}`)).status);
    expect(recorded.result).toBe(200);
    const recursive = recorded.queries.filter((query) => /with recursive/i.test(query.text));
    expect(recursive).toHaveLength(1);
  });
});
