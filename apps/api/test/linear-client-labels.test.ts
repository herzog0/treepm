import { describe, expect, it } from "vitest";
import { HttpLinearClient } from "../src/linear/linear-client.js";
import { points } from "./linear-complexity.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearReply } from "./linear-fake-fetch.js";

// ADR 0065, seção 5 (TREEPM-466): a consulta das issues passa a pedir o conjunto completo `labelIds` (escalar) e os nós das 10 primeiras
// etiquetas (nome, cor, grupo). Sem fase nova: o custo continua abaixo da metade do teto com a página de 50.
const KEY = "lin_api_SEGREDO_da_pessoa_9999";
const client = (replies: LinearReply[]) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl }) };
};
const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  identifier: `ENG-${id}`,
  url: `https://linear.app/x/issue/${id}`,
  title: `Issue ${id}`,
  description: null,
  priority: 0,
  updatedAt: "2026-11-01T00:00:00.000Z",
  state: { type: "unstarted" },
  ...extra,
});
const body = (nodes: unknown[]) => ({ data: { team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
const label = (id: string, name: string, color = "#eb5757", parent: { id: string; name: string } | null = null) => ({ id, name, color, isGroup: false, parent });

describe("as etiquetas na consulta das issues", () => {
  it("pede `labelIds` e as 10 primeiras etiquetas com nome, cor e grupo", async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamIssues(KEY, "team-eng", null);
    expect(fake.calls[0]!.query).toContain("labelIds labels(first: 10) { nodes { id name color isGroup parent { id name } } }");
  });

  it("custa 1.768,2 pontos com a página de 50 (abaixo da metade do teto de 5.000, ADR 0061 §7)", async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamIssues(KEY, "team-eng", null);
    expect(points(fake.calls[0]!.query, { first: 50 })).toBeCloseTo(1768.2, 5);
    expect(points(fake.calls[0]!.query, { first: 50 })).toBeLessThan(2_500);
  });

  it("a maior página que o cliente manda pedir fica abaixo do teto de 5.000 (pedido de 250 vira 100)", async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamIssues(KEY, "team-eng", null, { first: 250 });
    const first = fake.calls[0]!.variables["first"] as number;
    expect(first).toBe(100);
    expect(points(fake.calls[0]!.query, { first })).toBeLessThan(5_000);
  });

  it("devolve `labelIds` e os nós lidos (grupo como `{ id, name }`)", async () => {
    const { client: c } = client([
      { body: body([base("i-1", { labelIds: ["l-1", "l-2"], labels: { nodes: [label("l-1", "Bug"), label("l-2", "Front", "#4ea7fc", { id: "g-1", name: "Área" })] } })]) },
    ]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.nodes[0]!.labelIds).toEqual(["l-1", "l-2"]);
    expect(page.nodes[0]!.labels).toEqual([
      { id: "l-1", name: "Bug", color: "#eb5757", parent: null },
      { id: "l-2", name: "Front", color: "#4ea7fc", parent: { id: "g-1", name: "Área" } },
    ]);
    expect(page.labelsInvalid ?? 0).toBe(0);
  });

  it("`labelIds` ausente ou malformado vale como não lido (`undefined`), sem derrubar a issue", async () => {
    const { client: c } = client([
      {
        body: body([
          base("i-1"),
          base("i-2", { labelIds: "l-1" }),
          base("i-3", { labelIds: ["l-1", "id com espaço"] }),
          base("i-4", { labelIds: ["l-1", 7] }),
          base("i-5", { labelIds: [] }),
        ]),
      },
    ]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.nodes.map((node) => node.labelIds)).toEqual([undefined, undefined, undefined, undefined, []]);
    expect(page.skippedInvalid).toBe(0);
  });

  it("nó de etiqueta malformado é pulado e contado; a issue e as outras etiquetas passam", async () => {
    const { client: c } = client([
      {
        body: body([
          base("i-1", {
            labelIds: ["l-1", "l-2", "l-3", "l-4"],
            labels: {
              nodes: [
                label("l-1", "Bug"),
                { id: "l\u0000x", name: "Nulo", color: "#000000" },
                { id: "l-3", color: "#000000" },
                label("l-4", "Grupo ruim", "#000000", { id: "g x", name: "G" }),
                { id: "l-5", name: "Sem cor", color: 12, parent: null },
                "lixo",
              ],
            },
          }),
          base("i-2", { labelIds: ["l-1"], labels: "não é conexão" }),
        ]),
      },
    ]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.nodes).toHaveLength(2);
    expect(page.nodes[0]!.labels).toEqual([
      { id: "l-1", name: "Bug", color: "#eb5757", parent: null },
      { id: "l-4", name: "Grupo ruim", color: "#000000", parent: null },
      { id: "l-5", name: "Sem cor", color: "", parent: null },
    ]);
    expect(page.nodes[1]!.labels).toEqual([]);
    expect(page.labelsInvalid).toBe(3);
  });

  it("nome hostil passa cru (quem grava limpa) e o grupo (`isGroup`) não vira etiqueta", async () => {
    const long = "a".repeat(100_000);
    const { client: c } = client([
      { body: body([base("i-1", { labelIds: ["l-1", "g-1"], labels: { nodes: [label("l-1", long), { id: "g-1", name: "Área", color: "#000000", isGroup: true, parent: null }] } })]) },
    ]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.nodes[0]!.labels).toEqual([{ id: "l-1", name: long, color: "#eb5757", parent: null }]);
    expect(page.nodes[0]!.labelIds).toEqual(["l-1", "g-1"]);
  });
});
