import { describe, expect, it } from "vitest";
import { HttpLinearClient, LinearError } from "../src/linear/linear-client.js";
import { points } from "./linear-complexity.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";

// ADR 0061, seção 7 (fatia 2; TREEPM-477): a consulta de RAIZ `comments`, filtrada pelas issues do time, uma página por passo.
const KEY = "lin_api_SEGREDO_da_pessoa_9999";
const client = (replies: LinearReply[] | ((call: LinearCall) => LinearReply)) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl }) };
};
const node = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  body: "Texto",
  createdAt: "2026-03-03T10:00:00.000Z",
  editedAt: null,
  updatedAt: "2026-03-03T10:00:00.000Z",
  issue: { id: "iss-1" },
  parent: null,
  user: { id: "u-1", name: "Ana", email: "ana@exemplo.test" },
  externalUser: null,
  botActor: null,
  ...over,
});
const body = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { comments: { nodes, pageInfo: { hasNextPage, endCursor } } } });

describe("a consulta de comentários", () => {
  it("é a de raiz, filtrada pelo time com o tipo ID, com os campos pedidos e o e-mail do autor", async () => {
    const { client: c, fake } = client([{ body: body([node()]) }]);
    await c.listTeamComments(KEY, "team-eng", null);
    const call = fake.calls[0]!;
    expect(call.query).toMatch(/^query TeamComments\(\$id: ID!, \$after: String, \$first: Int!\)/);
    expect(call.query).toMatch(/comments\(first: \$first, after: \$after, filter: \{ issue: \{ team: \{ id: \{ eq: \$id \} \} \} \}\)/);
    for (const field of ["body", "createdAt", "editedAt", "updatedAt"]) expect(call.query, field).toMatch(new RegExp(`\\b${field}\\b`));
    expect(call.query).toMatch(/issue \{ id \}/);
    expect(call.query).toMatch(/parent \{ id body \}/);
    expect(call.query).toMatch(/user \{ id name email \}/);
    expect(call.query).toMatch(/externalUser \{ name \}/);
    expect(call.query).toMatch(/botActor \{ name \}/);
    expect(call.variables).toEqual({ id: "team-eng", after: null, first: 50 });
  });

  it(`custa bem abaixo do teto de desenho (5.000 pontos), mesmo com 250 por página`, async () => {
    const { client: c, fake } = client([{ body: body([]) }]);
    await c.listTeamComments(KEY, "team-eng", null);
    expect(points(fake.calls[0]!.query, { first: 50 })).toBeLessThan(500);
    expect(points(fake.calls[0]!.query, { first: 250 })).toBeLessThan(2_500);
  });

  it("devolve os nós mapeados, o cursor e os pulados por formato", async () => {
    const { client: c } = client([
      {
        body: body(
          [
            node({ editedAt: "2026-03-04T10:00:00.000Z", parent: { id: "c-0", body: "pai" } }),
            node({ id: "c-2", user: null, botActor: { name: "GitHub" } }),
            node({ id: "c-3", user: null, externalUser: { name: "Zé do Slack" } }),
            { id: "ruim" },
          ],
          true,
          "cur-2",
        ),
      },
    ]);
    const page = await c.listTeamComments(KEY, "team-eng", null);
    expect(page.nextCursor).toBe("cur-2");
    expect(page.skippedInvalid).toBe(1);
    expect(page.nodes[0]).toEqual({ id: "c-1", body: "Texto", createdAt: "2026-03-03T10:00:00.000Z", editedAt: "2026-03-04T10:00:00.000Z", updatedAt: "2026-03-03T10:00:00.000Z", issueId: "iss-1", parent: { id: "c-0", body: "pai" }, author: { kind: "user", id: "u-1", name: "Ana", email: "ana@exemplo.test" } });
    expect(page.nodes[1]?.author).toEqual({ kind: "bot", name: "GitHub" });
    expect(page.nodes[2]?.author).toEqual({ kind: "external", name: "Zé do Slack" });
  });

  it("nó sem issue (comentário de outra coisa) é pulado; autor ausente vale como apagado", async () => {
    const { client: c } = client([{ body: body([node({ issue: null }), node({ id: "c-9", user: null })]) }]);
    const page = await c.listTeamComments(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(1);
    expect(page.nodes.map((n) => [n.id, n.author])).toEqual([["c-9", null]]);
  });

  it("sem e-mail (permissão recusada): o cliente avisa com linear_email_unavailable, sem repetir (quem repete é o passo, contando a chamada)", async () => {
    const denied = { body: { errors: [{ message: "x", path: ["comments", "nodes", 0, "user", "email"], extensions: { code: "FORBIDDEN" } }] } };
    const { client: c, fake } = client([denied, { body: body([node({ user: { id: "u-1", name: "Ana" } })]) }]);
    await expect(c.listTeamComments(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_email_unavailable" });
    expect(fake.calls).toHaveLength(1);
    const page = await c.listTeamComments(KEY, "team-eng", null, { withEmail: false });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.query).toMatch(/user \{ id name \}/);
    expect(page.nodes[0]?.author).toEqual({ kind: "user", id: "u-1", name: "Ana", email: null });
  });

  it("sem o corpo do pai e sem o corpo, quando a leitura pede assim (página enorme)", async () => {
    const { client: c, fake } = client([{ body: body([node({ body: undefined, parent: { id: "c-0" } })]) }]);
    const page = await c.listTeamComments(KEY, "team-eng", null, { first: 1, withParentBody: false, withBody: false, withEmail: false });
    expect(fake.calls[0]!.query).toMatch(/parent \{ id \}/);
    expect(fake.calls[0]!.query).not.toMatch(/\bbody\b/);
    expect(fake.calls[0]!.query).toMatch(/user \{ id name \}/);
    expect(page.nodes[0]).toMatchObject({ id: "c-1", body: null, parent: { id: "c-0", body: null } });
  });

  it("corpo grande demais e limite de taxa viram os erros de sempre (sem o corpo da resposta)", async () => {
    const big = client([{ status: 200, headers: { "content-length": String(5 * 1_048_576) }, raw: "{}" }]);
    await expect(big.client.listTeamComments(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_response_too_large" });
    const rate = client([{ status: 429, headers: { "Retry-After": "30" }, body: {} }]);
    const error = await rate.client.listTeamComments(KEY, "team-eng", null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ code: "linear_rate_limited", retryAfterSeconds: 30 });
  });
});

describe("C2 item 5: nó hostil é pulado e contado, nunca derruba a página", () => {
  it("id longo demais, com caractere de controle, issue/usuário com id inválido → pulados; o resto passa", async () => {
    const nodes = [
      node({ id: "c".repeat(201) }),
      node({ id: "c-\u0000x" }),
      node({ id: "c-\nx" }),
      node({ id: "c-issue", issue: { id: "i\u0000" } }),
      node({ id: "c-user", user: { id: "u".repeat(300), name: "Ana" } }),
      node({ id: "c-ok" }),
      node({ id: "0190a0b0-0000-7000-8000-000000000001" }),
    ];
    const { client: c } = client([{ body: body(nodes) }]);
    const page = await c.listTeamComments(KEY, "team-eng", null);
    expect(page.nodes.map((n) => n.id)).toEqual(["c-ok", "0190a0b0-0000-7000-8000-000000000001"]);
    expect(page.skippedInvalid).toBe(5);
  });
  it("pai com id inválido vale como sem pai (a resposta perde só a citação)", async () => {
    const { client: c } = client([{ body: body([node({ id: "c-r", parent: { id: "p\u0000", body: "x" } })]) }]);
    const page = await c.listTeamComments(KEY, "team-eng", null);
    expect(page.nodes[0]?.parent).toBeNull();
  });
});
