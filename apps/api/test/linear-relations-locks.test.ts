import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeTeamData } from "./linear-support.js";
import { seedRelated } from "./related-support.js";
import { ORG, as } from "./world.js";

// Relações do Linear (ADR 0061, fatia 3; TREEPM-478), correção R3 item 5: a remoção à mão (`removeDependency`, `removeRelated`) e a fase
// `relations` da importação pegam a MESMA trava de dependências do projeto, a importação antes de ler as origens. Sem isso, um passo
// que leu a origem antes da remoção recriaria a ligação que a pessoa acabou de tirar.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
const open = () => h.world().projects.org;
const ticket = async (title: string): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as Row)["id"] as string;
};

/** Segura a trava de dependências do projeto numa conexão à parte enquanto `during` corre: diz se `during` esperou por ela. */
async function whileHoldingDependencyLock<T>(during: () => Promise<T>): Promise<{ waited: boolean; result: T }> {
  const client = await h.pool.connect();
  let held = false;
  try {
    await client.query("begin");
    held = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-dependencies:${open()}`]);
    let settled = false;
    const pending = Promise.resolve(during()).finally(() => void (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const waited = !settled;
    await client.query("commit");
    held = false;
    return { waited, result: await pending };
  } finally {
    if (held) await client.query("rollback");
    client.release();
  }
}

describe("a trava de dependências nas remoções à mão", () => {
  it("removeDependency espera a trava", async () => {
    const [a, b] = [await ticket("a"), await ticket("b")];
    expect((await h.call("POST", `/api/tickets/${a}/dependencies`, as("admin"), { ticketId: b })).status).toBe(200);
    const { waited, result } = await whileHoldingDependencyLock(() => h.call("DELETE", `/api/tickets/${a}/dependencies/${b}`, as("admin")));
    expect(waited).toBe(true);
    expect(result.status).toBeLessThan(300);
  });

  it("removeRelated espera a trava", async () => {
    const [x, y] = [await ticket("x"), await ticket("y")];
    await seedRelated(h.pool, ORG, open(), x, y);
    const { waited, result } = await whileHoldingDependencyLock(() => h.call("DELETE", `/api/tickets/${x}/related/${y}`, as("admin")));
    expect(waited).toBe(true);
    expect(result.status).toBe(204);
  });
});

describe("a fase relations da importação", () => {
  it("pega a trava antes de ler as origens, mesmo numa página sem nada a criar", async () => {
    const team: FakeTeamData = { projects: [], issues: [{ id: "a", identifier: "ENG-1", title: "A" }, { id: "b", identifier: "ENG-2", title: "B" }], relations: [{ id: "r-1", type: "blocks", from: "a", to: "b" }] };
    await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
    const post = (path: string) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), {});
    const runOnce = async (): Promise<string> => {
      const started = await post("");
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      let body = started.body as Row;
      for (let i = 0; i < 40 && body["phase"] !== "relations"; i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as Row;
      expect(body["phase"]).toBe("relations");
      return String(started.body.id);
    };
    // Primeira rodada até o fim: a ligação já existe; a segunda só vai VER a relação (nada a criar).
    const first = await runOnce();
    for (let i = 0; i < 10; i += 1) if (((await post(`/${first}/step`)).body as Row)["done"] === true) break;
    const second = await runOnce();
    const { waited, result } = await whileHoldingDependencyLock(() => post(`/${second}/step`));
    expect(waited).toBe(true);
    expect(result.status).toBe(200);
  });
});
