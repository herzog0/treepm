import { describe, expect, it } from "vitest";
import { HttpLinearClient, LINEAR_IMPORT_MAX_BODY_BYTES, LINEAR_IMPORT_PAGE_SIZE, LINEAR_MAX_BODY_BYTES, LinearError } from "../src/linear/linear-client.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearReply } from "./linear-fake-fetch.js";

const KEY = "lin_api_SEGREDO_da_pessoa_9999";

const client = (replies: LinearReply[], timeoutMs?: number) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl, ...(timeoutMs ? { timeoutMs } : {}) }) };
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

const issue = (over: Record<string, unknown> = {}) => ({
  id: "iss-1",
  identifier: "ENG-1",
  url: "https://linear.app/acme/issue/ENG-1",
  title: "Título",
  description: "texto",
  priority: 2,
  updatedAt: "2026-11-01T10:00:00.000Z",
  trashed: false,
  state: { type: "started" },
  parent: null,
  project: null,
  assignee: null,
  ...over,
});
const issuesBody = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { team: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
const projectsBody = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { team: { projects: { nodes, pageInfo: { hasNextPage, endCursor } } } } });

describe("HttpLinearClient.countTeamIssues", () => {
  it("lê issueCount do time sem arquivadas, em uma chamada barata", async () => {
    const { client: c, fake } = client([{ body: { data: { team: { issueCount: 123 } } } }]);
    expect(await c.countTeamIssues(KEY, "team-eng")).toBe(123);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng" });
    expect(fake.calls[0]!.query).toMatch(/issueCount\(includeArchived:\s*false\)/);
    expect(fake.calls[0]!.headers["authorization"]).toBe(KEY);
  });

  it("time nulo ou formato estranho → linear_unavailable; limite → linear_rate_limited", async () => {
    expect((await failureOf(() => client([{ body: { data: { team: null } } }]).client.countTeamIssues(KEY, "t"))).code).toBe("linear_unavailable");
    expect((await failureOf(() => client([{ body: { data: { team: { issueCount: "muitas" } } } }]).client.countTeamIssues(KEY, "t"))).code).toBe("linear_unavailable");
    const error = await failureOf(() => client([{ status: 429, headers: { "Retry-After": "11" }, body: {} }]).client.countTeamIssues(KEY, "t"));
    expect(error).toMatchObject({ code: "linear_rate_limited", retryAfterSeconds: 11 });
  });
});

describe("HttpLinearClient.listTeamProjects", () => {
  it("uma página de 50 projetos do time, com o cursor da seguinte", async () => {
    const { client: c, fake } = client([{ body: projectsBody([{ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa" }], true, "cur-2") }]);
    const page = await c.listTeamProjects(KEY, "team-eng", null);
    expect(page).toEqual({ nodes: [{ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa", statusType: null, description: null, content: null, priority: 0, lead: null, dueDate: undefined }], nextCursor: "cur-2", skippedInvalid: 0, dueDatesInvalid: 0 });
    expect(LINEAR_IMPORT_PAGE_SIZE).toBe(50);
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng", after: null, first: 50 });
    expect(fake.calls[0]!.query).toMatch(/projects\(first:\s*\$first/);
    expect(fake.calls[0]!.query).toMatch(/status\s*\{\s*type\s*\}/);
    expect(fake.calls[0]!.query).not.toMatch(/includeArchived:\s*true/);
  });

  it("última página não tem cursor; cursor volta nos argumentos", async () => {
    const { client: c, fake } = client([{ body: projectsBody([], false, "ignorado") }]);
    expect(await c.listTeamProjects(KEY, "team-eng", "cur-2")).toEqual({ nodes: [], nextCursor: null, skippedInvalid: 0, dueDatesInvalid: 0 });
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng", after: "cur-2", first: 50 });
  });

  it("hasNextPage sem cursor não gira para sempre: vira linear_unavailable", async () => {
    expect((await failureOf(() => client([{ body: projectsBody([], true, null) }]).client.listTeamProjects(KEY, "t", null))).code).toBe("linear_unavailable");
  });
});

describe("HttpLinearClient.listTeamIssues", () => {
  it("pede só os campos combinados, sem arquivadas, sem children nem labels, 50 por página", async () => {
    const { client: c, fake } = client([{ body: issuesBody([issue()]) }]);
    await c.listTeamIssues(KEY, "team-eng", null);
    const query = fake.calls[0]!.query.replace(/\s+/g, " ");
    expect(query).toMatch(/issues\(first: \$first, after: \$after, includeArchived: false, orderBy: createdAt\)/);
    expect(fake.calls[0]!.variables).toEqual({ id: "team-eng", after: null, first: 50 });
    for (const field of ["id", "identifier", "url", "title", "description", "priority", "updatedAt", "trashed", "state { type }", "parent { id }", "project { id }", "assignee { id email }"]) {
      expect(query).toContain(field);
    }
    expect(query).not.toMatch(/children|labels/);
  });

  it("traduz a issue: estado, pai, projeto e responsável; prioridade e descrição nula", async () => {
    const node = issue({ description: null, priority: 0, state: { type: "completed" }, parent: { id: "iss-0" }, project: { id: "p1" }, assignee: { id: "u1", email: "Ana@Acme.io" } });
    const { client: c } = client([{ body: issuesBody([node, issue({ id: "iss-2", trashed: true })], true, "cur-2") }]);
    const page = await c.listTeamIssues(KEY, "team-eng", "cur-1");
    expect(page.nextCursor).toBe("cur-2");
    expect(page.nodes[0]).toEqual({
      id: "iss-1",
      identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
      title: "Título",
      description: null,
      priority: 0,
      updatedAt: "2026-11-01T10:00:00.000Z",
      trashed: false,
      stateType: "completed",
      parentId: "iss-0",
      projectId: "p1",
      assignee: { id: "u1", email: "Ana@Acme.io" },
      createdAt: null,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      previousIdentifiers: [],
      creator: null,
      dueDate: undefined, // a chave ausente na resposta vale "não lido" (ADR 0064)
    });
    expect(page.nodes[1]).toMatchObject({ id: "iss-2", trashed: true, assignee: null, parentId: null, projectId: null });
  });

  it("trashed ausente vale falso; prioridade fracionária é arredondada", async () => {
    const node = issue({ priority: 2.0 });
    delete (node as Record<string, unknown>)["trashed"];
    const { client: c } = client([{ body: issuesBody([node]) }]);
    expect((await c.listTeamIssues(KEY, "t", null)).nodes[0]).toMatchObject({ trashed: false, priority: 2 });
  });

  it("L7: issue malformada é pulada e contada; a página segue (e o envelope quebrado ainda falha sem expor o corpo)", async () => {
    const { client: c } = client([{ body: issuesBody([issue({ id: undefined }), issue({ id: "ok-1" }), issue({ id: "ok-2", state: null })], true, "c1") }]);
    const page = await c.listTeamIssues(KEY, "t", null);
    expect(page.nodes.map((node) => node.id)).toEqual(["ok-1"]);
    expect(page).toMatchObject({ skippedInvalid: 2, nextCursor: "c1" });
    const error = await failureOf(() => client([{ body: { data: { team: { issues: { nodes: "x", pageInfo: {} } } } } }]).client.listTeamIssues(KEY, "t", null));
    expect(error.code).toBe("linear_unavailable");
    expect(error.message).not.toContain("SEGREDO");
  });

  it("mesmo mapa de erros: chave recusada, limite com Retry-After, 5xx, rede, prazo e corpo acima de 1 MB", async () => {
    expect((await failureOf(() => client([{ status: 401, body: {} }]).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_key_invalid");
    expect(await failureOf(() => client([{ status: 429, headers: { "Retry-After": "9" }, body: {} }]).client.listTeamIssues(KEY, "t", null))).toMatchObject({ code: "linear_rate_limited", retryAfterSeconds: 9 });
    expect((await failureOf(() => client([{ status: 502, body: {} }]).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_unavailable");
    expect((await failureOf(() => client([{ throws: new Error(`falha com ${KEY}`) }]).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_unavailable");
    // L9: prazo estourado numa página de issues (e de projetos) é dito à parte, para a importação repetir com página menor.
    expect((await failureOf(() => client([{ hang: true }], 30).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_timeout");
    expect((await failureOf(() => client([{ slowBody: true }], 30).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_timeout");
    expect((await failureOf(() => client([{ raw: JSON.stringify({ data: { team: { issues: { nodes: [issue({ description: "x".repeat(LINEAR_IMPORT_MAX_BODY_BYTES + 10) })], pageInfo: { hasNextPage: false, endCursor: null } } } } }) }]).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_response_too_large");
  });

  it("L7: o corpo da página da importação vai até 4 MB; acima disso é linear_response_too_large (nas projetos também)", async () => {
    expect(LINEAR_IMPORT_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    const heavy = "x".repeat(LINEAR_MAX_BODY_BYTES + 1000);
    const { client: c } = client([{ raw: JSON.stringify(issuesBody([issue({ description: heavy })])) }]);
    expect((await c.listTeamIssues(KEY, "t", null)).nodes[0]?.description).toHaveLength(heavy.length);
    const huge = "x".repeat(LINEAR_IMPORT_MAX_BODY_BYTES + 10);
    expect((await failureOf(() => client([{ raw: JSON.stringify(projectsBody([{ id: "p", name: huge, url: "u" }])) }]).client.listTeamProjects(KEY, "t", null))).code).toBe("linear_response_too_large");
    // As outras chamadas seguem com o teto de 1 MB e o código de sempre.
    expect((await failureOf(() => client([{ raw: JSON.stringify({ data: { team: { issueCount: 1, lixo: heavy } } }) }]).client.countTeamIssues(KEY, "t"))).code).toBe("linear_unavailable");
  });

  it("L7: first, sem descrição e sem e-mail mudam a consulta", async () => {
    const { client: c, fake } = client([{ body: issuesBody([issue()]) }, { body: issuesBody([issue()]) }]);
    await c.listTeamIssues(KEY, "t", "cur", { first: 6 });
    expect(fake.calls[0]!.variables).toEqual({ id: "t", after: "cur", first: 6 });
    await c.listTeamIssues(KEY, "t", null, { first: 1, withDescription: false, withEmail: false });
    const query = fake.calls[1]!.query.replace(/\s+/g, " ");
    expect(query).not.toMatch(/\bdescription\b/);
    expect(query).toContain("assignee { id }");
    expect(query).not.toContain("email");
  });

  it("L7: erro de campo em `email` vira linear_email_unavailable (o passo repete sem e-mail); erro de outro campo não", async () => {
    const emailError = { errors: [{ message: "You do not have permission to see email", path: ["team", "issues", "nodes", 0, "assignee", "email"], extensions: { code: "FORBIDDEN" } }], data: null };
    const { client: c, fake } = client([{ body: emailError }, { body: issuesBody([issue({ assignee: { id: "u1" } })]) }]);
    await expect(c.listTeamIssues(KEY, "t", null)).rejects.toMatchObject({ code: "linear_email_unavailable" });
    const page = await c.listTeamIssues(KEY, "t", null, { withEmail: false });
    expect(page.nodes[0]?.assignee).toEqual({ id: "u1", email: null });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.query).toContain("assignee { id email }");
    expect(fake.calls[1]!.query).not.toContain("email");
    const other = { errors: [{ message: "x", path: ["team", "issues", "nodes", 0, "title"], extensions: { code: "FORBIDDEN" } }] };
    expect((await failureOf(() => client([{ body: other }]).client.listTeamIssues(KEY, "t", null))).code).toBe("linear_key_invalid");
    // E-mail nulo sem erro (campo escondido): aceito como "sem e-mail".
    const hidden = client([{ body: issuesBody([issue({ assignee: { id: "u2", email: null } })]) }]).client;
    expect((await hidden.listTeamIssues(KEY, "t", null)).nodes[0]?.assignee).toEqual({ id: "u2", email: null });
  });

  it("L9: e-mail ilegível só vale com caminho terminando em `email` e só na consulta de issues", async () => {
    // mensagem que cita e-mail, SEM caminho: não prova nada (aqui é um erro qualquer do Linear)
    const noPath = { errors: [{ message: "Cannot query field email", extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null };
    const first = client([{ body: noPath }]);
    expect((await failureOf(() => first.client.listTeamIssues(KEY, "t", null))).code).toBe("linear_unavailable");
    expect(first.fake.calls).toHaveLength(1); // não repetiu "sem e-mail"
    // outro erro qualquer com caminho em outro campo: também não vira "sem e-mail"
    const other = { errors: [{ message: "falha", path: ["team", "issues"], extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null };
    const second = client([{ body: other }]);
    expect((await failureOf(() => second.client.listTeamIssues(KEY, "t", null))).code).toBe("linear_unavailable");
    expect(second.fake.calls).toHaveLength(1);
    // consultas que não são de issues não olham o e-mail: um erro com caminho em `email` é só o erro de sempre
    const emailPath = { errors: [{ message: "x", path: ["viewer", "email"], extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null };
    expect((await failureOf(() => client([{ body: emailPath }]).client.whoami(KEY))).code).toBe("linear_unavailable");
    // A de projetos pede o e-mail do líder (ADR 0061): o caminho em `email` é a recusa, que o passo trata (C2, item 4).
    expect((await failureOf(() => client([{ body: emailPath }]).client.listTeamProjects(KEY, "t", null))).code).toBe("linear_email_unavailable");
    expect((await failureOf(() => client([{ body: emailPath }]).client.listTeamProjects(KEY, "t", null, { withEmail: false }))).code).toBe("linear_unavailable");
    expect((await failureOf(() => client([{ body: emailPath }]).client.listTeams(KEY))).code).toBe("linear_unavailable");
  });

  it("L7: projeto malformado é pulado e contado; a situação do projeto vem de status.type", async () => {
    const { client: c } = client([{ body: projectsBody([{ id: "p1", name: "A", url: "u", status: { type: "completed" } }, { id: "p2" }, { id: "p3", name: "C", url: "u" }]) }]);
    const page = await c.listTeamProjects(KEY, "t", null);
    expect(page.nodes.map((node) => [node.id, node.statusType])).toEqual([["p1", "completed"], ["p3", null]]);
    expect(page.skippedInvalid).toBe(1);
  });
});
