import { describe, expect, it } from "vitest";
import { HttpLinearClient, LINEAR_HISTORY_EXTRA_PAGE, LINEAR_HISTORY_PAGE_SIZE, LINEAR_HISTORY_PER_ISSUE } from "../src/linear/linear-client.js";
import { points } from "./linear-complexity.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";

// ADR 0061, "Decisão da fatia 4" (TREEPM-482): o histórico vem aninhado na issue. A fase `history` relê as issues do time (opcionalmente
// só as alteradas depois da marca d'água) pedindo só o id e as 20 entradas mais recentes; a issue com mais pede as outras à parte.
const KEY = "lin_api_SEGREDO_da_pessoa_9999";
const client = (replies: LinearReply[] | ((call: LinearCall) => LinearReply)) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl }) };
};
const user = (id: string, name: string, email: string | null = `${id}@empresa.com`) => ({ id, name, email });
const entry = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  createdAt: "2025-01-02T03:04:05.000Z",
  actor: user("u-ana", "Ana"),
  botActor: null,
  fromStateId: "s-1",
  toStateId: "s-2",
  fromState: { name: "Todo", type: "unstarted" },
  toState: { name: "Doing", type: "started" },
  fromAssigneeId: null,
  toAssigneeId: null,
  fromAssignee: null,
  toAssignee: null,
  fromPriority: null,
  toPriority: null,
  fromTitle: null,
  toTitle: null,
  fromParentId: null,
  toParentId: null,
  fromProjectId: null,
  toProjectId: null,
  updatedDescription: null,
  ...patch,
});
const issue = (id: string, history: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ id, history: { nodes: history, pageInfo: { hasNextPage, endCursor } } });
const body = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { team: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
const extraBody = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { issue: { history: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
const FIELDS =
  "nodes { id createdAt actor { id name email } botActor { name } fromStateId toStateId fromState { name type } toState { name type } fromAssigneeId toAssigneeId fromAssignee { id name email } toAssignee { id name email } fromPriority toPriority fromTitle toTitle fromParentId toParentId fromProjectId toProjectId updatedDescription } pageInfo { hasNextPage endCursor }";

describe("a consulta do histórico do time", () => {
  it("relê as issues do time pedindo só o id e as 20 entradas mais recentes, com só os campos usados", async () => {
    const { client: c, fake } = client([{ body: body([issue("i-1", [entry("h-1")])]) }]);
    await c.listTeamHistory(KEY, "team-eng", null);
    const call = fake.calls[0]!;
    expect(call.query).toBe(
      `query TeamHistory($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id history(first: 20, orderBy: createdAt) { ${FIELDS} } } pageInfo { hasNextPage endCursor } } } }`,
    );
    expect(call.query).not.toMatch(/description |identifier|url|comments|relations/);
    expect(call.variables).toEqual({ id: "team-eng", after: null, first: LINEAR_HISTORY_PAGE_SIZE });
    expect([LINEAR_HISTORY_PAGE_SIZE, LINEAR_HISTORY_PER_ISSUE, LINEAR_HISTORY_EXTRA_PAGE]).toEqual([10, 20, 180]);
  });

  it("filtro incremental: só as issues alteradas depois da marca (`updatedAt: { gt }`)", async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamHistory(KEY, "team-eng", "cur-1", { updatedSince: "2025-03-01T00:00:00.000Z", first: 4 });
    expect(fake.calls[0]!.query).toMatch(/^query TeamHistory\(\$id: String!, \$after: String, \$first: Int!, \$since: DateTimeOrDuration!\)/);
    expect(fake.calls[0]!.query).toContain("issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt, filter: { updatedAt: { gt: $since } })");
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng", after: "cur-1", first: 4, since: "2025-03-01T00:00:00.000Z" });
  });

  it("sem e-mail (campo recusado) e só ids (para andar depois de uma issue ilegível)", async () => {
    const noEmail = client([{ body: body([]) }]);
    await noEmail.client.listTeamHistory(KEY, "team-eng", null, { withEmail: false });
    expect(noEmail.fake.calls[0]!.query).not.toContain("email");
    expect(noEmail.fake.calls[0]!.query).toContain("actor { id name } botActor { name }");
    const idsOnly = client([{ body: body([{ id: "i-1" }, { id: "i-2" }], true, "c2") }]);
    const page = await idsOnly.client.listTeamHistory(KEY, "team-eng", null, { withHistory: false });
    expect(idsOnly.fake.calls[0]!.query).not.toContain("history(");
    expect(page).toEqual({ nodes: [{ id: "i-1", history: [], historyNext: null }, { id: "i-2", history: [], historyNext: null }], nextCursor: "c2", skippedInvalid: 0, historyErrors: 0 });
  });

  it(`custa no máximo 5.000 pontos com ${10} issues por página (a conta exata fica no PROGRESSO)`, async () => {
    const { client: c, fake } = client([{ body: body([]) }, { body: body([]) }]);
    await c.listTeamHistory(KEY, "team-eng", null);
    await c.listTeamHistory(KEY, "team-eng", null, { updatedSince: "2025-03-01T00:00:00.000Z" });
    const plain = points(fake.calls[0]!.query, { first: 10 });
    const filtered = points(fake.calls[1]!.query, { first: 10 });
    expect(plain).toBeLessThanOrEqual(5_000);
    expect(filtered).toBeLessThanOrEqual(5_000);
    expect({ plain, filtered }).toEqual({ plain: 2016.2, filtered: 2016.2 });
  });

  it("devolve as entradas por issue, o cursor da issue que tem mais e os pulados por formato; e-mail só para o casamento", async () => {
    const { client: c } = client([
      {
        body: body(
          [
            issue("i-1", [entry("h-1", { toAssigneeId: "u-bia", toAssignee: user("u-bia", "Bia"), fromPriority: 0, toPriority: 2.0 }), { id: "h-ruim" }, entry("h-2", { actor: null, botActor: { name: "GitHub" } })], true, "hc-1"),
            issue("i-2", []),
            { id: "i-ruim" },
          ],
          true,
          "cur-2",
        ),
      },
    ]);
    const page = await c.listTeamHistory(KEY, "team-eng", null);
    expect(page.nextCursor).toBe("cur-2");
    expect(page.skippedInvalid).toBe(2);
    expect(page.nodes.map((node) => [node.id, node.history.map((h) => h.id), node.historyNext])).toEqual([
      ["i-1", ["h-1", "h-2"], "hc-1"],
      ["i-2", [], null],
    ]);
    const [h1, h2] = page.nodes[0]!.history;
    expect(h1).toMatchObject({ actor: { id: "u-ana", name: "Ana", email: "u-ana@empresa.com" }, botActor: null, toAssignee: { id: "u-bia", name: "Bia", email: "u-bia@empresa.com" }, fromPriority: 0, toPriority: 2, fromStateId: "s-1" });
    expect(h2).toMatchObject({ actor: null, botActor: { name: "GitHub" } });
  });

  it("campos opcionais malformados valem como ausentes; id hostil pula a entrada", async () => {
    const { client: c } = client([
      { body: body([issue("i-1", [entry("h\u0000x"), entry("h-1", { fromTitle: 42, toPriority: "alta", fromState: "x", updatedDescription: "sim", toAssignee: { name: "sem id" } })])]) },
    ]);
    const page = await c.listTeamHistory(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(1);
    expect(page.nodes[0]!.history).toEqual([
      expect.objectContaining({ id: "h-1", fromTitle: null, toPriority: null, fromState: null, updatedDescription: null, toAssignee: null }),
    ]);
  });
});

describe("erros na leitura do histórico", () => {
  it("`errors` com `data` válido: o nó do histórico apontado pelo `path` não vem (nem o resto da issue apontada), o resto da página vem", async () => {
    const at = (...path: (string | number)[]) => ({ message: `Internal error ${KEY}`, path, extensions: { code: "INTERNAL_SERVER_ERROR" } });
    const reply = {
      // Os índices do `path` são os da resposta crua: o nó fora do formato (`{ id: "h-ruim" }`) e a issue ruim contam.
      ...body([issue("i-1", [{ id: "h-ruim" }, entry("h-1", { toState: null }), entry("h-2")]), { id: "i-ruim" }, issue("i-2", [entry("h-3")]), issue("i-3", [entry("h-4")], true, "hc-3")]),
      errors: [at("team", "issues", "nodes", 0, "history", "nodes", 1, "toState"), at("team", "issues", "nodes", 3, "history", "pageInfo", "endCursor")],
    };
    const { client: c } = client([{ body: reply }]);
    const page = await c.listTeamHistory(KEY, "team-eng", null);
    expect(page.nodes.map((node) => [node.id, node.history.map((h) => h.id), node.historyNext])).toEqual([
      ["i-1", ["h-2"], null],
      ["i-2", ["h-3"], null],
    ]);
    // i-1 (um nó com erro) e i-3 (a issue inteira): duas issues lidas pela metade por erro; os dois fora do formato, pulados.
    expect(page).toMatchObject({ historyErrors: 2, skippedInvalid: 2 });
  });

  it("`errors` sem `path` que aponte uma issue da página: `linear_partial_response` (a página é relida menor); o texto do erro não sai", async () => {
    for (const path of [undefined, ["team"], ["team", "issues", "pageInfo"], ["team", "issues", "nodes", 9, "history"], ["outro"]]) {
      const reply = { ...body([issue("i-1", [entry("h-1")])]), errors: [{ message: `Internal error ${KEY}`, ...(path ? { path } : {}), extensions: { code: "INTERNAL_SERVER_ERROR" } }] };
      const { client: c } = client([{ body: reply }]);
      const error = await c.listTeamHistory(KEY, "team-eng", null).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(path)).toMatchObject({ code: "linear_partial_response" });
      expect(String((error as Error).message)).not.toContain("SEGREDO");
    }
  });

  it("`data` nulo ou inválido com `errors`: `linear_partial_response`, na página do time e na extra", async () => {
    const errors = [{ message: "Entity not found", extensions: { code: "INPUT_ERROR" } }];
    for (const reply of [{ data: null, errors }, { data: { team: null }, errors }]) {
      const { client: c } = client([{ body: reply }]);
      await expect(c.listTeamHistory(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_partial_response" });
    }
    const extra = client([{ body: { data: { issue: { history: null } }, errors } }]);
    await expect(extra.client.listIssueHistory(KEY, "i-1", "hc-1")).rejects.toMatchObject({ code: "linear_partial_response" });
    // Na extra, `data` válido com `errors` que não apontam um nó do histórico: também.
    const pathless = client([{ body: { ...extraBody([entry("h-21")]), errors } }]);
    await expect(pathless.client.listIssueHistory(KEY, "i-1", "hc-1")).rejects.toMatchObject({ code: "linear_partial_response" });
  });

  it("qualquer erro com caminho terminando em `email` → `linear_email_unavailable` (mesmo junto de outros erros)", async () => {
    const errors = [
      { message: "Forbidden", path: ["team", "issues", "nodes", 0, "history", "nodes", 0, "fromAssignee", "email"], extensions: { code: "FORBIDDEN" } },
      { message: "Entity not found", path: ["team", "issues", "nodes", 0, "history", "nodes", 0, "toState"], extensions: { code: "INPUT_ERROR" } },
    ];
    const { client: c } = client([{ body: { ...body([issue("i-1", [entry("h-1", { actor: null })])]), errors } }]);
    await expect(c.listTeamHistory(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_email_unavailable" });
    const extra = client([{ body: { ...extraBody([]), errors } }]);
    await expect(extra.client.listIssueHistory(KEY, "i-1", "hc-1")).rejects.toMatchObject({ code: "linear_email_unavailable" });
    // Sem pedir o e-mail, o mesmo erro não é confundido com recusa de e-mail.
    const plainErrors = [{ message: "Field not accessible", path: ["team", "issues", "nodes", 0, "history", "nodes", 0, "fromAssignee", "email"] }];
    const noEmail = client([{ body: { data: null, errors: plainErrors } }]);
    await expect(noEmail.client.listTeamHistory(KEY, "team-eng", null, { withEmail: false })).rejects.toMatchObject({ code: "linear_partial_response" });
  });

  it("limite de taxa, chave inválida e indisponível como nas outras fases; nada da chave nem e-mail na mensagem", async () => {
    const limited = client([{ status: 429, headers: { "retry-after": "30" }, body: { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] } }]);
    await expect(limited.client.listTeamHistory(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_rate_limited" });
    const invalid = client([{ status: 401, body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }]);
    await expect(invalid.client.listTeamHistory(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_key_invalid" });
    const down = client([{ status: 500, body: { message: "u-ana@empresa.com" } }]);
    const error = await down.client.listTeamHistory(KEY, "team-eng", null).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "linear_unavailable" });
    expect(String((error as Error).message)).not.toMatch(/SEGREDO|empresa\.com/);
  });
});

describe("as entradas seguintes de uma issue (mais de 20)", () => {
  it(`pede a próxima página da issue, ${180} por vez, na mesma ordem e com os mesmos campos`, async () => {
    const { client: c, fake } = client([{ body: extraBody([entry("h-21"), { id: "ruim" }], true, "hc-2") }]);
    const page = await c.listIssueHistory(KEY, "i-1", "hc-1");
    expect(fake.calls[0]!.query).toBe(`query IssueHistory($id: String!, $after: String, $first: Int!) { issue(id: $id) { history(first: $first, after: $after, orderBy: createdAt) { ${FIELDS} } } }`);
    expect(fake.calls[0]!.variables).toEqual({ id: "i-1", after: "hc-1", first: 180 });
    const cost = points(fake.calls[0]!.query, { first: 180 });
    expect(cost).toBeLessThanOrEqual(5_000);
    expect(cost).toBe(1785.2);
    expect(page.history.map((h) => h.id)).toEqual(["h-21"]);
    expect(page).toMatchObject({ nextCursor: "hc-2", skippedInvalid: 1, incomplete: false });
  });

  it("página menor quando pedida (a importação reduz a extra que estoura), entre 1 e 180", async () => {
    const { client: c, fake } = client(() => ({ body: extraBody([]) }));
    await c.listIssueHistory(KEY, "i-1", "hc-1", { first: 90 });
    await c.listIssueHistory(KEY, "i-1", "hc-1", { first: 999 });
    await c.listIssueHistory(KEY, "i-1", "hc-1", { first: 0 });
    expect(fake.calls.map((call) => call.variables["first"])).toEqual([90, 180, 1]);
  });

  it("sem e-mail; issue que sumiu ou não é visível: nada a mais, e a leitura fica incompleta (segura a marca)", async () => {
    const noEmail = client([{ body: extraBody([]) }]);
    await noEmail.client.listIssueHistory(KEY, "i-1", "hc-1", { withEmail: false });
    expect(noEmail.fake.calls[0]!.query).not.toContain("email");
    const { client: c } = client([{ body: { data: { issue: null } } }]);
    expect(await c.listIssueHistory(KEY, "i-1", "hc-1")).toEqual({ history: [], nextCursor: null, skippedInvalid: 0, incomplete: true });
    const missing = client([{ body: { data: null, errors: [{ message: "Entity not found", path: ["issue"], extensions: { code: "INVALID_INPUT" } }] } }]);
    expect(await missing.client.listIssueHistory(KEY, "i-1", "hc-1")).toEqual({ history: [], nextCursor: null, skippedInvalid: 0, incomplete: true });
  });

  it("`errors` apontando um nó do histórico: só ele não vem, e a leitura fica incompleta", async () => {
    const errors = [{ message: "Internal error", path: ["issue", "history", "nodes", 0, "toState"], extensions: { code: "INTERNAL_SERVER_ERROR" } }];
    const { client: c } = client([{ body: { ...extraBody([entry("h-21", { toState: null }), entry("h-22")], true, "hc-2"), errors } }]);
    const page = await c.listIssueHistory(KEY, "i-1", "hc-1");
    expect(page.history.map((h) => h.id)).toEqual(["h-22"]);
    expect(page).toMatchObject({ nextCursor: "hc-2", skippedInvalid: 0, incomplete: true });
  });
});
