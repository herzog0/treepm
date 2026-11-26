import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearImportService, STEP_MAX_CALLS } from "../src/linear/linear-import.service.js";
import { HttpLinearClient, LINEAR_IMPORT_MAX_BODY_BYTES } from "../src/linear/linear-client.js";
import { LinearError } from "../src/linear/ports.js";
import { linearFakeFetch } from "./linear-fake-fetch.js";
import type { LinearClient } from "../src/linear/ports.js";

// L9 item 3: a ida ao Linear de um passo (prazo reduz a página como o corpo grande, teto de 6 chamadas e 25 s).
type Fetcher = (key: string, teamId: string, run: unknown, progress: { size: number }) => Promise<{ page: unknown; nextPageSize: number; withoutDescription: boolean }>;
const run = (pageSize = 50) => ({ cursor: null, pageSize, counts: {} });
function serviceWith(listTeamIssues: LinearClient["listTeamIssues"]) {
  const service = new LinearImportService({ listTeamIssues } as unknown as LinearClient, null as never, null as never, null as never, null as never, null as never);
  return (service as unknown as { fetchIssues: Fetcher }).fetchIssues.bind(service);
}
const okPage = { nodes: [], nextCursor: null, skippedInvalid: 0 };

afterEach(() => vi.restoreAllMocks());

describe("fetchIssues", () => {
  it("prazo estourado reduz a página à metade, como o corpo grande demais", async () => {
    const asked: number[] = [];
    const fetchIssues = serviceWith(async (_k, _t, _a, options) => {
      asked.push(options?.first ?? 0);
      if ((options?.first ?? 0) > 6) throw new LinearError("linear_timeout");
      return okPage;
    });
    const progress = { size: 0 };
    const result = await fetchIssues("k", "t", run(), progress);
    expect(asked).toEqual([50, 25, 12, 6]);
    expect(progress.size).toBe(6);
    expect(result).toMatchObject({ reduced: true, usedSize: 6 });
  });

  it("no máximo 6 chamadas por passo: ao estourar termina em erro, com o tamanho alcançado em progress", async () => {
    let calls = 0;
    const fetchIssues = serviceWith(async () => {
      calls += 1;
      throw new LinearError("linear_response_too_large");
    });
    const progress = { size: 0 };
    await expect(fetchIssues("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_response_too_large" });
    expect(calls).toBe(STEP_MAX_CALLS);
    expect(progress.size).toBe(1);
  });

  it("no máximo 25 s por passo: com chamadas lentas para antes das 6 e guarda o tamanho", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchIssues = serviceWith(async () => {
      calls += 1;
      now += 10_000; // cada chamada gasta o prazo inteiro
      throw new LinearError("linear_timeout");
    });
    const progress = { size: 0 };
    await expect(fetchIssues("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_timeout" });
    expect(calls).toBe(2); // a 3ª só começaria com 20 s gastos: 20 + 10 > 25
    expect(progress.size).toBe(12); // 50 → 25 → 12 (a falha da 2ª chamada já reduziu)
  });

  it("outro erro (chave, queda) propaga na hora, mantendo a redução já feita", async () => {
    const fetchIssues = serviceWith(async (_k, _t, _a, options) => {
      if ((options?.first ?? 0) === 50) throw new LinearError("linear_timeout");
      throw new LinearError("linear_key_invalid");
    });
    const progress = { size: 0 };
    await expect(fetchIssues("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_key_invalid" });
    expect(progress.size).toBe(25);
  });
});

// Item 1 da S3: a página de projetos reduz como a de issues; só um projeto sozinho ainda estourando perde o conteúdo.
type ProjectFetcher = (key: string, teamId: string, run: unknown, progress: { size: number }) => Promise<{ page: { nodes: { id: string }[] }; reduced: boolean; usedSize: number; summaryOnly: string[] }>;
function projectsWith(listTeamProjects: LinearClient["listTeamProjects"]) {
  const service = new LinearImportService({ listTeamProjects } as unknown as LinearClient, null as never, null as never, null as never, null as never, null as never);
  return (service as unknown as { fetchProjects: ProjectFetcher }).fetchProjects.bind(service);
}
const projectsPage = (ids: string[]) => ({ nodes: ids.map((id) => ({ id })), nextCursor: null, skippedInvalid: 0 });

describe("fetchProjects", () => {
  it("estouro do corpo reduz a página à metade até caber, mantendo o conteúdo", async () => {
    const asked: { first: number; withContent: boolean }[] = [];
    const fetchProjects = projectsWith((async (_k, _t, _a, options) => {
      asked.push({ first: options?.first ?? 0, withContent: options?.withContent !== false });
      if ((options?.first ?? 0) > 12) throw new LinearError("linear_response_too_large");
      return projectsPage(["p"]);
    }) as LinearClient["listTeamProjects"]);
    const progress = { size: 0 };
    const result = await fetchProjects("k", "t", run(), progress);
    expect(asked).toEqual([
      { first: 50, withContent: true },
      { first: 25, withContent: true },
      { first: 12, withContent: true },
    ]);
    expect(progress.size).toBe(12);
    expect(result).toMatchObject({ reduced: true, usedSize: 12, summaryOnly: [] });
  });

  it("com 1 projeto ainda estourando, dispensa o conteúdo SÓ dele (no passo seguinte, já com a página em 1)", async () => {
    const fetchProjects = projectsWith((async (_k, _t, _a, options) => {
      if (options?.withContent !== false) throw new LinearError("linear_timeout");
      return projectsPage(["gigante"]);
    }) as LinearClient["listTeamProjects"]);
    const result = await fetchProjects("k", "t", run(1), { size: 0 });
    expect(result).toMatchObject({ summaryOnly: ["gigante"], usedSize: 1 });
  });

  it("no máximo 6 chamadas por passo: de 50 a 1 são 6; a sem conteúdo fica para o passo seguinte, com o tamanho guardado", async () => {
    let calls = 0;
    const fetchProjects = projectsWith((async () => {
      calls += 1;
      throw new LinearError("linear_response_too_large");
    }) as LinearClient["listTeamProjects"]);
    const progress = { size: 0 };
    await expect(fetchProjects("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_response_too_large" });
    expect(calls).toBe(STEP_MAX_CALLS);
    expect(progress.size).toBe(1);
  });

  it("no máximo 25 s por passo", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchProjects = projectsWith((async () => {
      calls += 1;
      now += 10_000;
      throw new LinearError("linear_timeout");
    }) as LinearClient["listTeamProjects"]);
    const progress = { size: 0 };
    await expect(fetchProjects("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_timeout" });
    expect(calls).toBe(2);
    expect(progress.size).toBe(12);
  });

  it("outro erro propaga na hora, mantendo a redução já feita", async () => {
    const fetchProjects = projectsWith((async (_k, _t, _a, options) => {
      if ((options?.first ?? 0) === 50) throw new LinearError("linear_timeout");
      throw new LinearError("linear_rate_limited", 5);
    }) as LinearClient["listTeamProjects"]);
    const progress = { size: 0 };
    await expect(fetchProjects("k", "t", run(), progress)).rejects.toMatchObject({ code: "linear_rate_limited" });
    expect(progress.size).toBe(25);
  });
});

// M8 item 7 (TREEPM-496): o prazo do passo conduzido pelo MCP vale para as páginas de projetos e de issues.
describe("prazo do passo pelo MCP (deadline)", () => {
  it("nenhuma página começa se o prazo inteiro dela não cabe; depois de uma falha, para com a falha anterior guardada", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchProjects = projectsWith(async () => {
      calls += 1;
      throw new Error("não devia chamar");
    });
    const bound = fetchProjects as unknown as (k: string, t: string, r: unknown, p: { size: number }, emailRefused?: () => Promise<void>, alreadyUsed?: number, deadline?: number) => Promise<unknown>;
    await expect(bound("k", "t", run(), { size: 0 }, undefined, 0, now + 9_999)).rejects.toMatchObject({ name: "StepOutOfTime", lastError: null });
    expect(calls).toBe(0);
    const fetchIssues = serviceWith(async () => {
      calls += 1;
      now += 4_000;
      throw new LinearError("linear_timeout");
    }) as unknown as (k: string, t: string, r: unknown, p: { size: number }, emailRefused?: () => Promise<void>, alreadyUsed?: number, deadline?: number) => Promise<unknown>;
    const progress = { size: 0 };
    await expect(fetchIssues("k", "t", run(), progress, undefined, 0, now + 15_000)).rejects.toMatchObject({ name: "StepOutOfTime", lastError: { code: "linear_timeout" } });
    expect(calls).toBe(2); // 0 → 4 s → 8 s; a 3ª começaria em 8 s e só terminaria em 18 s > 15 s
    expect(progress.size).toBe(12);
  });
});

// C2, item 4: o pior caso (resposta grande demais E e-mail recusado) cabe no orçamento do passo, contando TODA chamada ao Linear, e a
// recusa do e-mail é gravada assim que acontece (o passo termina em erro sem nenhuma página boa).
describe("orçamento do passo com e-mail recusado e resposta grande demais (fetch de verdade contado)", () => {
  const denied = (path: readonly (string | number)[]) => ({ body: { errors: [{ message: "x", path, extensions: { code: "FORBIDDEN" } }] } });
  const huge = { raw: JSON.stringify({ data: { pad: "x".repeat(LINEAR_IMPORT_MAX_BODY_BYTES + 10) } }) };
  const cases = [
    { phase: "fetchProjects", path: ["team", "projects", "nodes", 0, "lead", "email"] },
    { phase: "fetchIssues", path: ["team", "issues", "nodes", 0, "assignee", "email"] },
    { phase: "fetchComments", path: ["comments", "nodes", 0, "user", "email"] },
  ] as const;
  for (const { phase, path } of cases) {
    it(`${phase}: no máximo ${STEP_MAX_CALLS} fetch; a recusa é gravada na hora, uma vez`, async () => {
      const fake = linearFakeFetch((call) => (/\bemail\b/.test(call.query) ? denied(path) : huge));
      const client = new HttpLinearClient({ fetch: fake.impl });
      const service = new LinearImportService(client, null as never, null as never, null as never, null as never, null as never);
      const fetcher = (service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[phase]!.bind(service);
      const refused: number[] = [];
      const progress = { size: 0 };
      await expect(fetcher("lin_api_x", "t", run(), progress, async () => void refused.push(fake.calls.length))).rejects.toMatchObject({ code: "linear_response_too_large" });
      expect(fake.calls.length).toBeLessThanOrEqual(STEP_MAX_CALLS);
      expect(fake.calls.length).toBe(STEP_MAX_CALLS);
      expect(refused).toEqual([1]);
      expect(fake.calls.slice(1).every((call) => !/\bemail\b/.test(call.query))).toBe(true);
    });
    it(`${phase}: com a recusa já gravada na rodada, nem pede o e-mail`, async () => {
      const fake = linearFakeFetch((call) => (/\bemail\b/.test(call.query) ? denied(path) : huge));
      const service = new LinearImportService(new HttpLinearClient({ fetch: fake.impl }), null as never, null as never, null as never, null as never, null as never);
      const fetcher = (service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[phase]!.bind(service);
      await expect(fetcher("lin_api_x", "t", { cursor: null, pageSize: 50, counts: { assigneeEmailUnavailable: true } }, { size: 0 }, async () => undefined)).rejects.toBeDefined();
      expect(fake.calls.every((call) => !/\bemail\b/.test(call.query))).toBe(true);
    });
  }
});

// ADR 0061, fatia 3: a página de relações e as páginas extras das issues com mais relações dividem o orçamento do passo.
describe("fetchRelations", () => {
  type RelFetcher = (key: string, teamId: string, run: unknown, progress: { size: number }, alreadyUsed?: number, deadline?: number) => Promise<{ page: { nodes: { id: string; relations: unknown[]; relationsNext: string | null }[] }; truncated: number; usedSize: number }>;
  function relationsWith(client: Partial<LinearClient>): RelFetcher {
    const service = new LinearImportService(client as LinearClient, null as never, null as never, null as never, null as never, null as never);
    return (service as unknown as { fetchRelations: RelFetcher }).fetchRelations.bind(service);
  }
  const rel = (id: string) => ({ id, type: "related", relatedIssueId: "z" });
  const issue = (id: string) => ({ id, relations: [rel(`${id}-0`)], relationsNext: "c1" });
  const mainPage = { nodes: [issue("a"), issue("b"), issue("c")], nextCursor: null, skippedInvalid: 0 };

  it("páginas extras que não cabem no orçamento ficam truncadas, sem passar de 6 chamadas (contando a conferência de acesso)", async () => {
    let calls = 1; // a conferência de acesso
    const fetcher = relationsWith({
      listTeamRelations: vi.fn(async () => ((calls += 1), mainPage)),
      // Cada issue tem sempre mais uma página: nenhuma termina.
      listIssueRelations: vi.fn(async (_key: string, issueId: string, after: string) => ((calls += 1), { relations: [rel(`${issueId}-${after}`)], nextCursor: `${after}x`, skippedInvalid: 0 })),
    });
    const fetched = await fetcher("k", "t", run(), { size: 0 }, 1);
    expect(calls).toBe(STEP_MAX_CALLS);
    expect(fetched.truncated).toBe(3);
    expect(fetched.page.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(fetched.page.nodes[0]!.relations.length).toBe(1 + (STEP_MAX_CALLS - 2));
  });

  it("uma issue termina dentro do orçamento; erro numa página extra para as extras e não derruba a página", async () => {
    const fetcher = relationsWith({
      listTeamRelations: vi.fn(async () => mainPage),
      listIssueRelations: vi.fn(async (_key: string, issueId: string) => {
        if (issueId === "b") throw new LinearError("linear_timeout");
        return { relations: [rel(`${issueId}-1`)], nextCursor: null, skippedInvalid: 0 };
      }),
    });
    const fetched = await fetcher("k", "t", run(), { size: 0 }, 1);
    expect(fetched.page.nodes.map((node) => [node.id, node.relations.length, node.relationsNext])).toEqual([["a", 2, null], ["b", 1, "c1"], ["c", 1, "c1"]]);
    expect(fetched.truncated).toBe(2);
  });

  it("página principal grande demais reduz à metade, no mesmo teto de chamadas", async () => {
    const sizes: number[] = [];
    const fetcher = relationsWith({
      listTeamRelations: vi.fn(async (_key: string, _team: string, _after: string | null, options?: { first?: number }) => {
        sizes.push(options?.first ?? 0);
        throw new LinearError("linear_response_too_large");
      }),
    });
    const progress = { size: 0 };
    await expect(fetcher("k", "t", run(), progress, 1)).rejects.toMatchObject({ code: "linear_response_too_large" });
    // A fase de relações começa em 25 issues (R2: medido, o passo passava de 5 s com 50); com orçamento sobrando, chega a 1 e falha.
    expect(sizes).toEqual([25, 12, 6, 3, 1]);
    expect(progress.size).toBe(1);
  });
});
