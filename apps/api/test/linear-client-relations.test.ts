import { describe, expect, it } from "vitest";
import { HttpLinearClient, LINEAR_RELATIONS_PER_ISSUE } from "../src/linear/linear-client.js";
import { points } from "./linear-complexity.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";

// ADR 0061, seção 7 (fatia 3; TREEPM-478): as relações vêm aninhadas na issue (a consulta de raiz `issueRelations` não aceita filtro).
// A fase `relations` relê as issues do time pedindo só o id e as relações (20 por issue); a issue com mais pede as outras à parte.
const KEY = "lin_api_SEGREDO_da_pessoa_9999";
const client = (replies: LinearReply[] | ((call: LinearCall) => LinearReply)) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl }) };
};
const rel = (id: string, type: string, related: string) => ({ id, type, relatedIssue: { id: related } });
const issue = (id: string, relations: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ id, relations: { nodes: relations, pageInfo: { hasNextPage, endCursor } } });
const body = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { team: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } } });

describe("a consulta das relações do time", () => {
  it("relê as issues do time (mesma ordem e filtro da fase issues) pedindo só o id e as relações de origem", async () => {
    const { client: c, fake } = client([{ body: body([issue("i-1", [rel("r-1", "blocks", "i-2")])]) }]);
    await c.listTeamRelations(KEY, "team-eng", null);
    const call = fake.calls[0]!;
    expect(call.query).toMatch(/^query TeamRelations\(\$id: String!, \$after: String, \$first: Int!\)/);
    expect(call.query).toMatch(/issues\(first: \$first, after: \$after, includeArchived: false, orderBy: createdAt\) \{ nodes \{ id relations\(first: 20\) \{ nodes \{ id type relatedIssue \{ id \} \} pageInfo \{ hasNextPage endCursor \} \} \}/);
    expect(call.query).not.toMatch(/inverseRelations|title|description|email/);
    expect(call.variables).toEqual({ id: "team-eng", after: null, first: 50 });
    expect(LINEAR_RELATIONS_PER_ISSUE).toBe(20);
  });

  it("custa menos de 5.000 pontos mesmo com 50 issues por página (o padrão do cliente; a fase `relations` pede 25)", async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamRelations(KEY, "team-eng", null);
    expect(points(fake.calls[0]!.query, { first: 50 })).toBeLessThan(5_000);
  });

  it("devolve as relações por issue, o cursor da issue que tem mais e os pulados por formato", async () => {
    const { client: c } = client([
      {
        body: body(
          [
            issue("i-1", [rel("r-1", "blocks", "i-2"), rel("r-2", "related", "i-3"), { id: "r-ruim", type: "blocks" }], true, "rc-1"),
            issue("i-2", []),
            { id: "i-ruim" },
          ],
          true,
          "cur-2",
        ),
      },
    ]);
    const page = await c.listTeamRelations(KEY, "team-eng", null);
    expect(page.nextCursor).toBe("cur-2");
    expect(page.skippedInvalid).toBe(2);
    expect(page.nodes).toEqual([
      { id: "i-1", relations: [{ id: "r-1", type: "blocks", relatedIssueId: "i-2" }, { id: "r-2", type: "related", relatedIssueId: "i-3" }], relationsNext: "rc-1" },
      { id: "i-2", relations: [], relationsNext: null },
    ]);
  });

  it("nó hostil (id com controle ou longo demais, tipo longo demais) é pulado e contado; o resto passa", async () => {
    const { client: c } = client([
      { body: body([issue("i-\u0000", []), issue("i-1", [rel("r-\nx", "blocks", "i-2"), rel("r-2", "x".repeat(60), "i-2"), rel("r-3", "blocks", "i".repeat(101)), rel("r-ok", "blocks", "i-2")])]) },
    ]);
    const page = await c.listTeamRelations(KEY, "team-eng", null);
    expect(page.nodes).toEqual([{ id: "i-1", relations: [{ id: "r-ok", type: "blocks", relatedIssueId: "i-2" }], relationsNext: null }]);
    expect(page.skippedInvalid).toBe(4);
  });

  it("página menor, corpo grande demais e limite de taxa: os erros de sempre", async () => {
    const small = client([{ body: body([]) }]);
    await small.client.listTeamRelations(KEY, "team-eng", "cur-1", { first: 12 });
    expect(small.fake.calls[0]!.variables).toEqual({ id: "team-eng", after: "cur-1", first: 12 });
    const big = client([{ status: 200, headers: { "content-length": String(5 * 1_048_576) }, raw: "{}" }]);
    await expect(big.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_response_too_large" });
    const rate = client([{ status: 429, headers: { "Retry-After": "30" }, body: {} }]);
    await expect(rate.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_rate_limited", retryAfterSeconds: 30 });
  });
});

describe("resposta 200 com `errors` na fase de relações (R2, item 1)", () => {
  const partial = { data: { team: { issues: { nodes: [issue("i-1", [rel("r-1", "blocks", "i-2")]), null], pageInfo: { hasNextPage: false, endCursor: null } } } }, errors: [{ message: "Entity not found: Issue", path: ["team", "issues", "nodes", 1, "relations", "nodes", 0, "relatedIssue"], extensions: { code: "INPUT_ERROR" } }] };
  const nulled = { data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } }] };

  it("`data` nulo, ou que não valida, com `errors` é erro redutível (`linear_partial_response`), na página do time e na extra", async () => {
    for (const reply of [nulled, { data: { team: null }, errors: nulled.errors }]) {
      const { client: c } = client([{ body: reply }]);
      await expect(c.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_partial_response" });
    }
    for (const reply of [{ data: null, errors: [{ message: "Cannot return null for non-nullable field", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }, { data: { issue: { relations: null } }, errors: nulled.errors }]) {
      const extra = client([{ body: reply }]);
      await expect(extra.client.listIssueRelations(KEY, "i-1", "rc-1")).rejects.toMatchObject({ code: "linear_partial_response" });
    }
  });

  it("`data` que valida com `errors` (R3, item 3): usa o `data`; o nó nulo conta como pulado", async () => {
    const { client: c } = client([{ body: partial }]);
    expect(await c.listTeamRelations(KEY, "team-eng", null)).toEqual({ nodes: [{ id: "i-1", relations: [{ id: "r-1", type: "blocks", relatedIssueId: "i-2" }], relationsNext: null }], nextCursor: null, skippedInvalid: 1 });
    // A relação nula dentro de uma issue também: as outras da issue entram.
    const inner = client([{ body: { ...body([issue("i-1", [rel("r-1", "blocks", "i-2"), null])]), errors: partial.errors } }]);
    expect((await inner.client.listTeamRelations(KEY, "team-eng", null)).skippedInvalid).toBe(1);
    const extra = client([{ body: { data: { issue: { relations: { nodes: [rel("r-9", "related", "i-3"), null], pageInfo: { hasNextPage: false, endCursor: null } } } }, errors: partial.errors } }]);
    expect(await extra.client.listIssueRelations(KEY, "i-1", "rc-1")).toEqual({ relations: [{ id: "r-9", type: "related", relatedIssueId: "i-3" }], nextCursor: null, skippedInvalid: 1 });
    // A releitura só com os ids, idem.
    const ids = client([{ body: { ...body([{ id: "i-1" }, null], true, "cur-1"), errors: partial.errors } }]);
    expect(await ids.client.listTeamRelations(KEY, "team-eng", null, { first: 2, withRelations: false })).toEqual({ nodes: [{ id: "i-1", relations: [], relationsNext: null }], nextCursor: "cur-1", skippedInvalid: 1 });
  });

  it("o texto dos `errors` não vai para o que o cliente devolve quando usa o `data`", async () => {
    const { client: c } = client([{ body: { ...body([issue("i-1", [])]), errors: [{ message: "SEGREDO do Linear", extensions: { code: "INPUT_ERROR", userPresentableMessage: "SEGREDO" } }] } }]);
    expect(JSON.stringify(await c.listTeamRelations(KEY, "team-eng", null))).not.toContain("SEGREDO");
  });

  it("o erro guarda só o código: nada do texto do Linear", async () => {
    const { client: c } = client([{ body: { data: null, errors: [{ message: "SEGREDO do Linear", extensions: { code: "INPUT_ERROR", userPresentableMessage: "SEGREDO" } }] } }]);
    const error = await c.listTeamRelations(KEY, "team-eng", null).catch((caught: unknown) => caught);
    expect(JSON.stringify(error)).not.toContain("SEGREDO");
    expect(String((error as Error).message)).not.toContain("SEGREDO");
  });

  it("limite de taxa, chave recusada e 5xx continuam como antes", async () => {
    const limited = client([{ body: { data: null, errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] } }]);
    await expect(limited.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_rate_limited" });
    const auth = client([{ body: { data: null, errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }]);
    await expect(auth.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_key_invalid" });
    const down = client([{ status: 500, body: { data: null, errors: [{ message: "x", extensions: { code: "INPUT_ERROR" } }] } }]);
    await expect(down.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_unavailable" });
    const invalid = client([{ status: 400, body: { errors: [{ message: "x", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } }]);
    await expect(invalid.client.listTeamRelations(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_unavailable" });
  });

  it("fora da fase de relações, `errors` continua sendo `linear_unavailable`", async () => {
    const { client: c } = client([{ body: nulled }]);
    await expect(c.listTeamIssues(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_unavailable" });
  });

  it("releitura só com os ids (para andar o cursor depois de uma issue envenenada): sem `relations`", async () => {
    const { client: c, fake } = client([{ body: body([{ id: "i-1" }], true, "cur-1") }]);
    const page = await c.listTeamRelations(KEY, "team-eng", "cur-0", { first: 1, withRelations: false });
    expect(fake.calls[0]!.query).toMatch(/^query TeamRelations\(/);
    expect(fake.calls[0]!.query).toMatch(/nodes \{ id \} pageInfo/);
    expect(fake.calls[0]!.query).not.toMatch(/relations\(first/);
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng", after: "cur-0", first: 1 });
    expect(page).toEqual({ nodes: [{ id: "i-1", relations: [], relationsNext: null }], nextCursor: "cur-1", skippedInvalid: 0 });
  });
});

describe("ids da fase de relações com no máximo 64 caracteres (R2, item 5)", () => {
  it("a chave composta da origem cabe no CHECK de 200: id de relação, de issue ou da outra ponta com 65 é pulado e contado", async () => {
    const ok = "a".repeat(64);
    const { client: c } = client([
      { body: body([issue("b".repeat(65), [rel("r-0", "blocks", "i-2")]), issue(ok, [rel("r".repeat(65), "blocks", "i-2"), rel("r-1", "blocks", "c".repeat(65)), rel("r".repeat(64), "blocks", ok)])]) },
    ]);
    const page = await c.listTeamRelations(KEY, "team-eng", null);
    expect(page.nodes).toEqual([{ id: ok, relations: [{ id: "r".repeat(64), type: "blocks", relatedIssueId: ok }], relationsNext: null }]);
    expect(page.skippedInvalid).toBe(3);
    const extra = client([{ body: { data: { issue: { relations: { nodes: [rel("r".repeat(65), "blocks", "i-2"), rel("r-2", "blocks", "d".repeat(65)), rel("r-3", "blocks", ok)], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]);
    expect(await extra.client.listIssueRelations(KEY, ok, "rc")).toEqual({ relations: [{ id: "r-3", type: "blocks", relatedIssueId: ok }], nextCursor: null, skippedInvalid: 2 });
  });
});

describe("as relações seguintes de uma issue (mais de 20)", () => {
  it("pede a próxima página da issue, 100 por vez, e custa pouco", async () => {
    const reply = { body: { data: { issue: { relations: { nodes: [rel("r-21", "blocks", "i-9")], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    const { client: c, fake } = client([reply]);
    const page = await c.listIssueRelations(KEY, "i-1", "rc-1");
    expect(fake.calls[0]!.query).toMatch(/^query IssueRelations\(\$id: String!, \$after: String\) \{ issue\(id: \$id\) \{ relations\(first: 100, after: \$after\) \{ nodes \{ id type relatedIssue \{ id \} \} pageInfo \{ hasNextPage endCursor \} \} \} \}$/);
    expect(fake.calls[0]!.variables).toEqual({ id: "i-1", after: "rc-1" });
    expect(points(fake.calls[0]!.query, {})).toBeLessThan(500);
    expect(page).toEqual({ relations: [{ id: "r-21", type: "blocks", relatedIssueId: "i-9" }], nextCursor: null, skippedInvalid: 0 });
  });

  it("issue que sumiu ou não é visível: nenhuma relação a mais (a issue fica como lida até ali)", async () => {
    const { client: c } = client([{ body: { data: { issue: null } } }]);
    expect(await c.listIssueRelations(KEY, "i-1", "rc-1")).toEqual({ relations: [], nextCursor: null, skippedInvalid: 1 });
  });
});
