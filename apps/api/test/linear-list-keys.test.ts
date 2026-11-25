import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 1 (ADR 0061, seção 4): a lista de tickets da tela traz, só para os tickets com origem, as chaves do Linear
// (a de hoje e as antigas) para a barra de busca achar `ENG-45`. Esse campo é só da lista da tela (TREEPM-501).
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const list = () => h.call("GET", `/api/projects/${open()}/tickets`, as("admin"));
const version = async () => Number((await q("select tickets_version v from projects where id = $1", [open()]))[0]?.["v"]);

async function finish(run: RunBody): Promise<RunBody> {
  for (let i = 0; i < 400; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
const sync = async (): Promise<RunBody> => {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return finish(run.body);
};
const importWith = async (issues: FakeIssue[]): Promise<FakeTeamData> => {
  const data: FakeTeamData = { projects: [], issues };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: data });
  await sync();
  return data;
};
type Item = { key: string; title: string; externalKeys?: string[] };
const items = async (): Promise<Item[]> => {
  const res = await list();
  expect(res.status).toBe(200);
  return res.body as Item[];
};
const byTitle = (all: Item[], title: string): Item => all.find((item) => item.title === title)!;

describe("a lista de tickets traz as chaves do Linear (só dos tickets com origem)", () => {
  it("a chave de hoje primeiro e as antigas depois; ticket sem origem não tem o campo", async () => {
    await importWith([
      { id: "a", identifier: "ENG-1", title: "Sem chave antiga" },
      { id: "z", identifier: "ENG-2", title: "Com chaves antigas", previousIdentifiers: ["OPS-3", "OPS-1"] },
    ]);
    await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title: "Criado aqui" });
    const all = await items();
    expect(byTitle(all, "Sem chave antiga").externalKeys).toEqual(["ENG-1"]);
    expect(byTitle(all, "Com chaves antigas").externalKeys).toEqual(["ENG-2", "OPS-3", "OPS-1"]);
    expect(Object.keys(byTitle(all, "Criado aqui"))).not.toContain("externalKeys");
  });

  it("a chave só muda no Linear: a sincronização muda a versão do projeto (o mapa velho não fica com a busca velha) e a lista", async () => {
    const data = await importWith([{ id: "a", identifier: "ENG-1", title: "Mudou de time" }]);
    const before = await version();
    const etag = (await list()).headers["etag"];
    Object.assign(data.issues[0] as FakeIssue, { identifier: "OPS-9", previousIdentifiers: ["ENG-1"] });
    await sync();
    expect(await version()).toBeGreaterThan(before);
    const after = await h.call("GET", `/api/projects/${open()}/tickets`, as("admin"), undefined, { "if-none-match": String(etag) });
    expect(after.status).toBe(200);
    expect(byTitle(after.body as Item[], "Mudou de time").externalKeys).toEqual(["OPS-9", "ENG-1"]);
  });
});

describe("custo do campo (2.000 tickets importados)", () => {
  // Três tamanhos de descrição: o corpo da lista leva o trecho da descrição (até 600 caracteres), então o peso relativo do campo depende dele.
  // O limite de 5% vale para o caso do meio (a descrição de uns 270 caracteres, o de uma issue comum); os outros ficam no relatório.
  it.each([[0, null], [270, 0.05], [600, 0.05]] as const)("descrição de %i caracteres: o aumento do corpo da lista", async (size, limit) => {
    const issues: FakeIssue[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `i${i}`,
      identifier: `ENG-${i + 1}`,
      title: `Ajustar o fluxo de ${["cobrança", "convite", "importação", "relatório", "login"][i % 5]} para o caso número ${i}`,
      description: size === 0 ? null : `Contexto do problema ${i}. `.repeat(Math.ceil(size / 26)).slice(0, size),
      ...(i % 10 === 0 ? { previousIdentifiers: [`OPS-${i + 1}`] } : {}),
    }));
    await importWith(issues);
    const res = await list();
    const withKeys = JSON.stringify(res.body);
    const without = JSON.stringify((res.body as Item[]).map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => name !== "externalKeys"))));
    const gz = (text: string) => gzipSync(text).length;
    const rise = (withKeys.length - without.length) / without.length;
    console.info(`MEDIDA descrição ${size}: sem o campo ${without.length} B (gzip ${gz(without)}), com ${withKeys.length} B (gzip ${gz(withKeys)}); +${(rise * 100).toFixed(2)}% bruto, +${(((gz(withKeys) - gz(without)) / gz(without)) * 100).toFixed(2)}% gzip`);
    expect((res.body as Item[]).length).toBe(2000);
    if (limit !== null) expect(rise).toBeLessThan(limit);
  }, 120_000);
});
