import { describe, expect, it } from "vitest";
import { HttpLinearClient, LinearError, LINEAR_IMPORT_PAGE_SIZE } from "../src/linear/linear-client.js";
import { points } from "./linear-complexity.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";

// ADR 0061, seção 4: o que a rodada passa a pedir ao Linear (datas, criador, identificadores antigos; descrição, líder e prioridade do projeto).
const KEY = "lin_api_SEGREDO_da_pessoa_9999";
const client = (replies: LinearReply[] | ((call: LinearCall) => LinearReply)) => {
  const fake = linearFakeFetch(replies);
  return { fake, client: new HttpLinearClient({ fetch: fake.impl }) };
};
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
const issuesBody = (nodes: unknown[]) => ({ data: { team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
const projectsBody = (nodes: unknown[]) => ({ data: { team: { projects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });

describe("a consulta de issues", () => {
  it("pede datas, criador e identificadores antigos, com e-mail do criador nas mesmas condições do responsável", async () => {
    const { client: c, fake } = client([{ body: issuesBody([issue()]) }]);
    await c.listTeamIssues(KEY, "team-eng", null);
    const query = fake.calls[0]!.query;
    for (const field of ["createdAt", "startedAt", "completedAt", "canceledAt", "previousIdentifiers"]) expect(query, field).toMatch(new RegExp(`\\b${field}\\b`));
    expect(query).toMatch(/creator \{ id name email \}/);
    expect(query).toMatch(/assignee \{ id email \}/);
  });

  it("sem e-mail (permissão recusada), o cliente avisa e o passo repete sem o e-mail do criador e do responsável juntos", async () => {
    const denied = { body: { errors: [{ message: "x", path: ["team", "issues", "nodes", 0, "creator", "email"], extensions: { code: "FORBIDDEN" } }] } };
    const { client: c, fake } = client([denied, { body: issuesBody([issue({ creator: { id: "u-1", name: "Ana" } })]) }]);
    await expect(c.listTeamIssues(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_email_unavailable" });
    const page = await c.listTeamIssues(KEY, "team-eng", null, { withEmail: false });
    expect(fake.calls[1]!.query).toMatch(/creator \{ id name \}/);
    expect(fake.calls[1]!.query).not.toMatch(/email/);
    expect(page.nodes[0]!.creator).toEqual({ id: "u-1", name: "Ana", email: null });
  });

  it("devolve as datas, o criador e os identificadores antigos; nó sem os campos novos continua valendo", async () => {
    const full = issue({ id: "a", createdAt: "2026-03-03T10:00:00.000Z", startedAt: "2026-03-04T10:00:00.000Z", completedAt: null, canceledAt: null, previousIdentifiers: ["OPS-3"], creator: { id: "u-9", name: "Ana", email: "ana@acme.test" } });
    const old = issue({ id: "b" });
    const { client: c } = client([{ body: issuesBody([full, old]) }]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.nodes[0]).toMatchObject({ createdAt: "2026-03-03T10:00:00.000Z", startedAt: "2026-03-04T10:00:00.000Z", completedAt: null, canceledAt: null, previousIdentifiers: ["OPS-3"], creator: { id: "u-9", name: "Ana", email: "ana@acme.test" } });
    expect(page.nodes[1]).toMatchObject({ createdAt: null, startedAt: null, previousIdentifiers: [], creator: null });
  });

  it("criador sem nome ou nulo (usuário apagado) não derruba o nó", async () => {
    const { client: c } = client([{ body: issuesBody([issue({ id: "a", creator: null }), issue({ id: "b", creator: { id: "u-2", name: null } })]) }]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.nodes.map((node) => node.creator)).toEqual([null, { id: "u-2", name: "", email: null }]);
  });
});

describe("a consulta de projetos", () => {
  it("pede descrição, conteúdo, prioridade e líder (com e-mail)", async () => {
    const { client: c, fake } = client([{ body: projectsBody([{ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa" }]) }]);
    await c.listTeamProjects(KEY, "team-eng", null);
    const query = fake.calls[0]!.query;
    for (const field of ["description", "content", "priority"]) expect(query, field).toMatch(new RegExp(`\\b${field}\\b`));
    expect(query).toMatch(/lead \{ id email \}/);
  });

  it("devolve descrição, conteúdo, prioridade e líder; nó antigo sem esses campos continua valendo", async () => {
    const full = { id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa", status: { type: "started" }, description: "resumo", content: "conteúdo longo", priority: 2, lead: { id: "u-1", email: "lider@acme.test" } };
    const { client: c } = client([{ body: projectsBody([full, { id: "p2", name: "Beta", url: "https://linear.app/acme/project/beta" }]) }]);
    const page = await c.listTeamProjects(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.nodes[0]).toEqual({ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa", statusType: "started", description: "resumo", content: "conteúdo longo", priority: 2, lead: { id: "u-1", email: "lider@acme.test" }, dueDate: undefined });
    expect(page.nodes[1]).toEqual({ id: "p2", name: "Beta", url: "https://linear.app/acme/project/beta", statusType: null, description: null, content: null, priority: 0, lead: null, dueDate: undefined });
  });

  it("sem o conteúdo (corpo grande demais): a consulta sai sem `content`", async () => {
    const { client: c, fake } = client([{ body: projectsBody([]) }]);
    await c.listTeamProjects(KEY, "team-eng", null, { withContent: false });
    expect(fake.calls[0]!.query).not.toMatch(/\bcontent\b/);
    expect(fake.calls[0]!.query).toMatch(/\bdescription\b/);
  });

  it("e-mail do líder recusado: o cliente avisa (o passo repete sem o e-mail); outra falha não é engolida", async () => {
    const denied = { body: { errors: [{ message: "x", path: ["team", "projects", "nodes", 0, "lead", "email"], extensions: { code: "FORBIDDEN" } }] } };
    const { client: c, fake } = client([denied, { body: projectsBody([{ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa", lead: { id: "u-1" } }]) }]);
    await expect(c.listTeamProjects(KEY, "team-eng", null)).rejects.toMatchObject({ code: "linear_email_unavailable" });
    const page = await c.listTeamProjects(KEY, "team-eng", null, { withEmail: false });
    expect(fake.calls[1]!.query).toMatch(/lead \{ id \}/);
    expect(page.nodes[0]!.lead).toEqual({ id: "u-1", email: null });
    const down = client([{ status: 503, body: {} }]);
    await expect(down.client.listTeamProjects(KEY, "team-eng", null)).rejects.toBeInstanceOf(LinearError);
  });
});

describe("pontos de complexidade das consultas (teto de 5.000 por consulta)", () => {
  // As consultas de ANTES da fatia, para a conta de antes e depois ficar reproduzível.
  const issuesBefore = `query TeamIssues($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id identifier url title description priority updatedAt trashed state { type } parent { id } project { id } assignee { id email } } pageInfo { hasNextPage endCursor } } } }`;
  const projectsBefore = `query TeamProjects($id: String!, $after: String) { team(id: $id) { projects(first: 50, after: $after) { nodes { id name url status { type } } pageInfo { hasNextPage endCursor } } } }`;

  it("a conta no desenho: issues com 50 e com 250 por página, projetos com 50; tudo abaixo de 5.000", async () => {
    const issues = client([{ body: issuesBody([]) }]);
    await issues.client.listTeamIssues(KEY, "team-eng", null, { first: 250 });
    const projects = client([{ body: projectsBody([]) }]);
    await projects.client.listTeamProjects(KEY, "team-eng", null);
    const after = { issues50: points(issues.fake.calls[0]!.query, { first: 50 }), issues250: points(issues.fake.calls[0]!.query, { first: 250 }), projects50: points(projects.fake.calls[0]!.query, { first: 50 }) };
    const before = { issues50: points(issuesBefore, { first: 50 }), issues250: points(issuesBefore, { first: 250 }), projects50: points(projectsBefore, {}) };
    console.info(`pontos de complexidade (antes → depois): issues/50 ${before.issues50} → ${after.issues50}; issues/250 ${before.issues250} → ${after.issues250}; projetos/50 ${before.projects50} → ${after.projects50}`);
    // Desde as etiquetas (ADR 0065; 1.768,2 pontos com 50), a página de 250 passaria do teto: a importação nunca pede mais de 50 (`FULL_PAGE`).
    expect(after.issues50).toBeLessThan(2500);
    expect(after.projects50).toBeLessThan(5000);
    expect(after.issues250).toBeGreaterThan(before.issues250);
    expect(LINEAR_IMPORT_PAGE_SIZE).toBe(50);
  });
});

describe("campo novo malformado degrada para ausente, sem derrubar o nó (item 2 da S3)", () => {
  const project = (over: Record<string, unknown>) => ({ id: "p1", name: "Alfa", url: "https://linear.app/acme/project/alfa", status: { type: "started" }, description: "resumo", content: "longo", priority: 2, lead: { id: "u-1", email: "l@acme.test" }, ...over });
  const PROJECT_CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["lead vazio", { lead: {} }, { lead: null }],
    ["lead sem id (texto vazio)", { lead: { id: "" } }, { lead: null }],
    ["lead como texto", { lead: "u-1" }, { lead: null }],
    ["lead.email numérico (só o e-mail é ignorado)", { lead: { id: "u-1", email: 7 } }, { lead: { id: "u-1", email: null } }],
    ["priority como texto", { priority: "alta" }, { priority: 0 }],
    ["priority nula", { priority: null }, { priority: 0 }],
    ["content numérico", { content: 12 }, { content: null }],
    ["description numérica", { description: 3 }, { description: null }],
  ];
  it.each(PROJECT_CASES)("projeto: %s", async (_name, over, expected) => {
    const { client: c } = client([{ body: projectsBody([project(over), project({ id: "p2" })]) }]);
    const page = await c.listTeamProjects(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.nodes).toHaveLength(2);
    expect(page.nodes[0]).toMatchObject({ id: "p1", name: "Alfa", ...expected });
    expect(page.nodes[1]).toMatchObject({ id: "p2", lead: { id: "u-1" }, priority: 2 });
  });

  const ISSUE_CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["creator vazio", { creator: {} }, { creator: null }],
    ["creator sem id", { creator: { id: "" } }, { creator: null }],
    ["creator como texto", { creator: "ana" }, { creator: null }],
    ["creator.name numérico", { creator: { id: "u-1", name: 4 } }, { creator: { id: "u-1", name: "", email: null } }],
    ["previousIdentifiers com nulo", { previousIdentifiers: ["OPS-1", null] }, { previousIdentifiers: [] }],
    ["previousIdentifiers como texto", { previousIdentifiers: "OPS-1" }, { previousIdentifiers: [] }],
    ["createdAt numérico", { createdAt: 1700000000 }, { createdAt: null }],
    ["startedAt como objeto", { startedAt: {} }, { startedAt: null }],
    ["completedAt numérico", { completedAt: 5 }, { completedAt: null }],
    ["canceledAt booleano", { canceledAt: true }, { canceledAt: null }],
  ];
  it.each(ISSUE_CASES)("issue: %s", async (_name, over, expected) => {
    const { client: c } = client([{ body: issuesBody([issue({ id: "a", ...over }), issue({ id: "b" })]) }]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(page.nodes[0]).toMatchObject({ title: "Título", priority: 2, ...expected });
  });

  it("os campos ANTIGOS continuam estritos: priority de issue como texto ainda pula o nó", async () => {
    const { client: c } = client([{ body: issuesBody([issue({ id: "a", priority: "alta" }), issue({ id: "b", assignee: {} }), issue({ id: "c" })]) }]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(2);
    expect(page.nodes.map((node) => node.id)).toEqual(["c"]);
  });
});

describe("prazo (ADR 0064): dueDate da issue e targetDate do projeto", () => {
  // As consultas de ANTES do prazo, para a conta de antes e depois ficar reproduzível (com descrição, conteúdo e e-mail).
  const issuesBeforeDue = `query TeamIssues($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id identifier url title description priority updatedAt createdAt startedAt completedAt canceledAt previousIdentifiers trashed state { type } parent { id } project { id } assignee { id email } creator { id name email } } pageInfo { hasNextPage endCursor } } } }`;
  const projectsBeforeDue = `query TeamProjects($id: String!, $after: String, $first: Int!) { team(id: $id) { projects(first: $first, after: $after) { nodes { id name url description content priority status { type } lead { id email } } pageInfo { hasNextPage endCursor } } } }`;

  it("as duas consultas pedem o campo; o custo sobe só 0,1 ponto por item", async () => {
    const issues = client([{ body: issuesBody([]) }]);
    await issues.client.listTeamIssues(KEY, "team-eng", null, { first: 250 });
    const projects = client([{ body: projectsBody([]) }]);
    await projects.client.listTeamProjects(KEY, "team-eng", null);
    const issueQuery = issues.fake.calls[0]!.query;
    const projectQuery = projects.fake.calls[0]!.query;
    expect(issueQuery).toMatch(/\bdueDate\b/);
    expect(projectQuery).toMatch(/\btargetDate\b/);
    const sizes = { issues50: 50, issues250: 250, projects50: 50 };
    const before = { issues50: points(issuesBeforeDue, { first: 50 }), issues250: points(issuesBeforeDue, { first: 250 }), projects50: points(projectsBeforeDue, { first: 50 }) };
    const after = { issues50: points(issueQuery, { first: 50 }), issues250: points(issueQuery, { first: 250 }), projects50: points(projectQuery, { first: 50 }) };
    console.info(`prazo, pontos de complexidade (antes → depois): issues/50 ${before.issues50} → ${after.issues50}; issues/250 ${before.issues250} → ${after.issues250}; projetos/50 ${before.projects50} → ${after.projects50}`);
    for (const [name, size] of Object.entries(sizes)) {
      const key = name as keyof typeof sizes;
      // O prazo custa 0,1 por item; as etiquetas (ADR 0065) somam 27,1 por issue (`labelIds` 0,1 + 10 nós de 2,6 + a conexão 1).
      const labels = key === "projects50" ? 0 : size * 27.1;
      expect(Math.round((after[key] - before[key] - labels) * 10) / 10, name).toBe(Math.round(size * 0.1 * 10) / 10);
      if (key !== "issues250") expect(after[key]).toBeLessThan(5000);
    }
  });

  it("devolve o prazo; nulo vale nulo; ausente vale não lido sem contar; malformado ou fora da faixa não derruba o nó, vale como não lido e é contado", async () => {
    const BAD: unknown[] = ["2026-02-30", "1999-12-31", "2101-01-01", "2026-12-12T00:00:00.000Z", "12/12/2026", 20261212, {}, true];
    const nodes = [
      issue({ id: "ok", dueDate: "2026-12-12" }),
      issue({ id: "nulo", dueDate: null }),
      issue({ id: "sem" }),
      ...BAD.map((dueDate, index) => issue({ id: `ruim-${index}`, dueDate })),
    ];
    const { client: c } = client([{ body: issuesBody(nodes) }]);
    const page = await c.listTeamIssues(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.dueDatesInvalid).toBe(BAD.length);
    const byId = new Map(page.nodes.map((node) => [node.id, node]));
    expect(byId.get("ok")!.dueDate).toBe("2026-12-12");
    expect(byId.get("nulo")!.dueDate).toBeNull();
    expect(byId.get("sem")!.dueDate).toBeUndefined();
    for (let index = 0; index < BAD.length; index += 1) {
      const node = byId.get(`ruim-${index}`)!;
      expect(node.dueDate, String(BAD[index])).toBeUndefined();
      expect(node).toMatchObject({ title: "Título", priority: 2 });
    }
  });

  it("projeto: targetDate vira o prazo, com a mesma regra para o ausente e o malformado", async () => {
    const base = { name: "Alfa", url: "https://linear.app/acme/project/alfa" };
    const { client: c } = client([{ body: projectsBody([{ id: "p1", ...base, targetDate: "2027-01-31" }, { id: "p2", ...base, targetDate: null }, { id: "p3", ...base }, { id: "p4", ...base, targetDate: "2027-13-01" }, { id: "p5", ...base, targetDate: 5 }]) }]);
    const page = await c.listTeamProjects(KEY, "team-eng", null);
    expect(page.skippedInvalid).toBe(0);
    expect(page.dueDatesInvalid).toBe(2);
    expect(page.nodes.map((node) => node.dueDate)).toEqual(["2027-01-31", null, undefined, undefined, undefined]);
  });
});
