import { describe, expect, it } from "vitest";
import { HttpLinearClient, LINEAR_MAX_BODY_BYTES, LINEAR_NAME_MAX, LINEAR_TEAM_CEILING, LINEAR_TEAM_KEY_MAX, LINEAR_TEAM_MAX_PAGES, LinearError } from "../src/linear/linear-client.js";
import { linearFakeFetch, teamsBody, whoamiBody } from "./linear-fake-fetch.js";
import type { LinearReply } from "./linear-fake-fetch.js";

const KEY = "lin_api_SEGREDO_da_pessoa_9999";

const client = (replies: LinearReply[], timeoutMs?: number, totalTimeoutMs?: number) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl, ...(timeoutMs ? { timeoutMs } : {}), ...(totalTimeoutMs ? { listTimeoutMs: totalTimeoutMs } : {}) }) };
};

async function failureOf(run: () => Promise<unknown>): Promise<LinearError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(LinearError);
    return error as LinearError;
  }
  throw new Error("deveria falhar");
}

describe("HttpLinearClient.whoami", () => {
  it("POST no endpoint único, com a chave em Authorization SEM Bearer", async () => {
    const { client: c, fake } = client([{ body: whoamiBody() }]);
    const result = await c.whoami(KEY);
    expect(result).toEqual({ workspace: { id: "ws-1", name: "Acme", urlKey: "acme" }, viewer: { id: "viewer-1" } });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.linear.app/graphql");
    expect(call.headers["authorization"]).toBe(KEY);
    expect(call.headers["authorization"]).not.toMatch(/bearer/i);
    expect(call.query).toMatch(/viewer\s*\{\s*id\s*\}/);
    expect(call.query).toMatch(/organization\s*\{\s*id\s+name\s+urlKey\s*\}/);
  });

  it.each([
    ["HTTP 401", { status: 401, body: {} }],
    ["HTTP 403", { status: 403, body: {} }],
    ["HTTP 400 com código de autenticação", { status: 400, body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }],
    ["HTTP 200 com código de autenticação no corpo", { status: 200, body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }],
    ["HTTP 200 com FORBIDDEN no corpo", { status: 200, body: { errors: [{ message: "x", extensions: { code: "FORBIDDEN" } }] } }],
  ] as [string, LinearReply][])("%s → linear_key_invalid", async (_n, reply) => {
    const { client: c } = client([reply]);
    expect((await failureOf(() => c.whoami(KEY))).code).toBe("linear_key_invalid");
  });

  it("HTTP 429 → linear_rate_limited com retryAfterSeconds do cabeçalho", async () => {
    const { client: c } = client([{ status: 429, headers: { "Retry-After": "37" }, body: {} }]);
    const error = await failureOf(() => c.whoami(KEY));
    expect(error.code).toBe("linear_rate_limited");
    expect(error.retryAfterSeconds).toBe(37);
  });

  it("RATELIMITED no corpo, mesmo com HTTP 200 (ou 400), também é limite", async () => {
    for (const status of [200, 400]) {
      const { client: c } = client([{ status, headers: { "Retry-After": "5" }, body: { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] } }]);
      const error = await failureOf(() => c.whoami(KEY));
      expect(error.code).toBe("linear_rate_limited");
      expect(error.retryAfterSeconds).toBe(5);
    }
  });

  it("limite sem Retry-After usa um padrão positivo", async () => {
    const { client: c } = client([{ status: 429, body: {} }]);
    expect((await failureOf(() => c.whoami(KEY))).retryAfterSeconds).toBeGreaterThan(0);
  });

  it.each([
    ["HTTP 500", { status: 500, body: {} } as LinearReply],
    ["HTTP 503", { status: 503, body: {} } as LinearReply],
    ["rede", { throws: new Error("ECONNRESET") } as LinearReply],
    ["corpo que não é JSON", { status: 200, raw: "<html>" } as LinearReply],
    ["200 com erro de outro tipo no corpo", { status: 200, body: { errors: [{ message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } } as LinearReply],
    ["200 sem os dados esperados", { status: 200, body: { data: {} } } as LinearReply],
  ])("%s → linear_unavailable", async (_n, reply) => {
    const { client: c } = client([reply]);
    expect((await failureOf(() => c.whoami(KEY))).code).toBe("linear_unavailable");
  });

  it("estourar o tempo limite → linear_unavailable", async () => {
    const { client: c } = client([{ hang: true }], 30);
    expect((await failureOf(() => c.whoami(KEY))).code).toBe("linear_unavailable");
  });

  it("chave com caracteres que não cabem em cabeçalho vira chave inválida, sem chamar a rede", async () => {
    const { client: c, fake } = client([{ body: whoamiBody() }]);
    expect((await failureOf(() => c.whoami("chave com\nquebra"))).code).toBe("linear_key_invalid");
    expect((await failureOf(() => c.whoami("chave-é-acentuada"))).code).toBe("linear_key_invalid");
    expect(fake.calls).toHaveLength(0);
  });

  it("a chave NUNCA aparece no erro, nem serializado, em nenhum modo de falha", async () => {
    const replies: LinearReply[] = [
      { status: 401, body: { errors: [{ message: `chave ${KEY} inválida` }] } },
      { status: 429, body: { errors: [{ message: `chave ${KEY}`, extensions: { code: "RATELIMITED" } }] } },
      { status: 500, raw: `erro com ${KEY}` },
      { throws: new Error(`falha de rede com ${KEY}`) },
      { status: 200, body: { errors: [{ message: `dentro ${KEY}`, extensions: { code: "OTHER" } }] } },
    ];
    for (const reply of replies) {
      const { client: c } = client([reply]);
      const error = await failureOf(() => c.whoami(KEY));
      const text = `${error.message} ${error.stack ?? ""} ${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("SEGREDO");
    }
  });
});

describe("HttpLinearClient.listTeams", () => {
  it("lista os times, com a chave sem Bearer", async () => {
    const { client: c, fake } = client([{ body: teamsBody([{ id: "t1", key: "ENG", name: "Engenharia" }]) }]);
    expect(await c.listTeams(KEY)).toEqual([{ id: "t1", key: "ENG", name: "Engenharia" }]);
    expect(fake.calls[0]?.headers["authorization"]).toBe(KEY);
    expect(fake.calls[0]?.query).toMatch(/teams\(first:\s*100,\s*after:\s*\$after\)/);
    expect(fake.calls[0]?.query).toMatch(/pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
  });

  it("pagina por cursor até acabar", async () => {
    const { client: c, fake } = client([
      { body: teamsBody([{ id: "t1", key: "A", name: "A" }], true, "cur-1") },
      { body: teamsBody([{ id: "t2", key: "B", name: "B" }], false, null) },
    ]);
    expect((await c.listTeams(KEY)).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(fake.calls[0]?.variables["after"] ?? null).toBeNull();
    expect(fake.calls[1]?.variables["after"]).toBe("cur-1");
  });

  it("para no teto de 500 times", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `t${n}-${i}`, key: `K${n}${i}`, name: `N${n}${i}` }));
    const { client: c, fake } = client([1, 2, 3, 4, 5, 6, 7].map((n) => ({ body: teamsBody(page(n), true, `cur-${n}`) })));
    const teams = await c.listTeams(KEY);
    expect(teams).toHaveLength(LINEAR_TEAM_CEILING);
    expect(LINEAR_TEAM_CEILING).toBe(500);
    expect(fake.calls).toHaveLength(5);
  });

  it("erro numa página do meio propaga com o código mapeado", async () => {
    const { client: c } = client([{ body: teamsBody([{ id: "t1", key: "A", name: "A" }], true, "cur-1") }, { status: 429, headers: { "Retry-After": "9" }, body: {} }]);
    const error = await failureOf(() => c.listTeams(KEY));
    expect(error.code).toBe("linear_rate_limited");
    expect(error.retryAfterSeconds).toBe(9);
  });
});

describe("HttpLinearClient.listTeams: tetos de chamadas e de tempo", () => {
  it("no máximo 5 páginas, mesmo com páginas de 1 item", async () => {
    const { client: c, fake } = client([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ body: teamsBody([{ id: `t${n}`, key: `K${n}`, name: `N${n}` }], true, `cur-${n}`) })));
    const teams = await c.listTeams(KEY);
    expect(fake.calls).toHaveLength(LINEAR_TEAM_MAX_PAGES);
    expect(LINEAR_TEAM_MAX_PAGES).toBe(5);
    expect(teams.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("página vazia com hasNextPage conta como página e não gira para sempre", async () => {
    const { client: c, fake } = client([{ body: teamsBody([], true, "cur-x") }]);
    expect(await c.listTeams(KEY)).toEqual([]);
    expect(fake.calls).toHaveLength(LINEAR_TEAM_MAX_PAGES);
  });

  it("o prazo total estoura mesmo que cada página responda dentro do prazo da chamada", async () => {
    const slow = (n: number) => ({ body: teamsBody([{ id: `t${n}`, key: `K${n}`, name: `N${n}` }], true, `cur-${n}`) });
    const fake = linearFakeFetch([slow(1), slow(2), slow(3), slow(4), slow(5)]);
    const delayed = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve) => setTimeout(() => resolve(fake.impl(input, init)), 40))) as typeof fetch;
    const c = new HttpLinearClient({ fetch: delayed, listTimeoutMs: 100 });
    const error = await failureOf(() => c.listTeams(KEY));
    expect(error.code).toBe("linear_unavailable");
    expect(fake.calls.length).toBeLessThan(5);
  });
});

describe("HttpLinearClient.getTeam", () => {
  it("consulta o time pelo id, com a chave sem Bearer", async () => {
    const { client: c, fake } = client([{ body: { data: { team: { id: "t1", key: "ENG", name: "Engenharia" } } } }]);
    expect(await c.getTeam(KEY, "t1")).toEqual({ id: "t1", key: "ENG", name: "Engenharia" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.query).toMatch(/team\(id:\s*\$id\)\s*\{\s*id\s+key\s+name\s*\}/);
    expect(fake.calls[0]?.variables["id"]).toBe("t1");
    expect(fake.calls[0]?.headers["authorization"]).toBe(KEY);
  });

  it("time inexistente ou inacessível → null (null no corpo ou erro de entidade não encontrada)", async () => {
    expect(await client([{ body: { data: { team: null } } }]).client.getTeam(KEY, "t9")).toBeNull();
    const notFound = { status: 200, body: { data: null, errors: [{ message: "Entity not found: Team", extensions: { code: "INVALID_INPUT", type: "invalid input" } }] } };
    expect(await client([notFound]).client.getTeam(KEY, "t9")).toBeNull();
  });

  it("outros erros continuam erros", async () => {
    expect((await failureOf(() => client([{ status: 401, body: {} }]).client.getTeam(KEY, "t1"))).code).toBe("linear_key_invalid");
    expect((await failureOf(() => client([{ status: 500, body: {} }]).client.getTeam(KEY, "t1"))).code).toBe("linear_unavailable");
  });
});

describe("HttpLinearClient: o que vem do Linear tem teto", () => {
  it("corpo acima de 1 MB → linear_unavailable (por tamanho declarado e por tamanho lido)", async () => {
    const huge = JSON.stringify({ data: { pad: "x".repeat(LINEAR_MAX_BODY_BYTES + 10) } });
    expect((await failureOf(() => client([{ raw: huge }]).client.whoami(KEY))).code).toBe("linear_unavailable");
    expect((await failureOf(() => client([{ raw: huge, headers: { "content-length": String(huge.length) } }]).client.whoami(KEY))).code).toBe("linear_unavailable");
    expect(LINEAR_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it("corpo lento (cabeçalhos chegam, o corpo não) estoura o prazo da chamada", async () => {
    const { client: c } = client([{ slowBody: true }], 30);
    expect((await failureOf(() => c.whoami(KEY))).code).toBe("linear_unavailable");
  });

  it("nomes de workspace e de time são cortados em 200 caracteres e a chave do time em 20", async () => {
    const long = "n".repeat(500);
    const who = await client([{ body: whoamiBody({ id: "ws-1", name: long, urlKey: "acme" }) }]).client.whoami(KEY);
    expect(who.workspace.name).toHaveLength(LINEAR_NAME_MAX);
    const teams = await client([{ body: teamsBody([{ id: "t1", key: "K".repeat(60), name: long }]) }]).client.listTeams(KEY);
    expect(teams[0]?.name).toHaveLength(LINEAR_NAME_MAX);
    expect(teams[0]?.key).toHaveLength(LINEAR_TEAM_KEY_MAX);
    const one = await client([{ body: { data: { team: { id: "t1", key: "K".repeat(60), name: long } } } }]).client.getTeam(KEY, "t1");
    expect(one?.name).toHaveLength(200);
    expect(one?.key).toHaveLength(20);
  });

  it("nunca segue redirecionamento (redirect: \"error\")", async () => {
    const { client: c, fake } = client([{ body: whoamiBody() }]);
    await c.whoami(KEY);
    expect(fake.calls[0]?.redirect).toBe("error");
  });
});
