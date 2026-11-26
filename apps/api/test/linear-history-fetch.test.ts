import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearImportService, STEP_MAX_CALLS } from "../src/linear/linear-import.service.js";
import { LinearError } from "../src/linear/ports.js";
import type { LinearClient, LinearHistoryNode } from "../src/linear/ports.js";

// ADR 0061, fatia 4 (TREEPM-482): a página de histórico e as páginas extras das issues com mais de 20 entradas dividem o orçamento do
// passo. O que não cabe não é gravado pela metade: o passo pede uma página menor ("chame de novo"); só com uma issue por página e ainda sem
// caber a issue fica truncada (e a marca d'água não avança).
type HistoryFetched = { page: { nodes: { id: string; history: unknown[]; historyNext: string | null }[] }; truncated: number; capped: number; unreadable: number; usedSize: number; reduced: boolean; withEmail: boolean };
type HistoryFetcher = (key: string, teamId: string, run: unknown, progress: { size: number }, emailRefused?: () => Promise<void>, alreadyUsed?: number, deadline?: number) => Promise<HistoryFetched>;
const run = (pageSize = 10, counts: Record<string, unknown> = {}) => ({ cursor: null, pageSize, counts, historySince: null });
function historyWith(client: Partial<LinearClient>): HistoryFetcher {
  const service = new LinearImportService(client as LinearClient, null as never, null as never, null as never, null as never, null as never);
  return (service as unknown as { fetchHistory: HistoryFetcher }).fetchHistory.bind(service);
}
const entry = (id: string): LinearHistoryNode => ({
  id,
  createdAt: "2026-04-01T10:00:00.000Z",
  actor: null,
  botActor: null,
  fromStateId: null,
  toStateId: null,
  fromState: null,
  toState: null,
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
  updatedDescription: true,
});
const issue = (id: string, more: boolean) => ({ id, history: [entry(`${id}-0`)], historyNext: more ? "c20" : null });
const page = (ids: string[], more: (id: string) => boolean) => ({ nodes: ids.map((id) => issue(id, more(id))), nextCursor: null, skippedInvalid: 0, historyErrors: 0 });
const TEN = "abcdefghij".split("");

afterEach(() => vi.restoreAllMocks());

describe("fetchHistory: orçamento das páginas extras", () => {
  it("extras que não cabem nas chamadas: nenhuma extra é gasta, e o passo pede a página até a issue que não coube", async () => {
    const extra = vi.fn();
    const fetcher = historyWith({ listTeamHistory: vi.fn(async () => page(TEN, () => true)), listIssueHistory: extra });
    // Acesso (1) + página (1) = 2; sobram 4 chamadas: as issues a..d cabem, e (índice 4) não.
    await expect(fetcher("k", "t", run(), { size: 0 }, undefined, 1)).rejects.toMatchObject({ name: "StepOutOfTime", shrinkTo: 4 });
    expect(extra).not.toHaveBeenCalled();
  });

  it("com as extras cabendo: uma chamada por issue completa as 200; a que ainda tem mais conta como teto (não é erro)", async () => {
    let calls = 1;
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async () => ((calls += 1), page(["a", "b", "c", "d"], (id) => id !== "d"))),
      listIssueHistory: vi.fn(async (_k: string, issueId: string) => ((calls += 1), { history: [entry(`${issueId}-20`)], nextCursor: issueId === "b" ? "c200" : null, skippedInvalid: 0, incomplete: false })),
    });
    const fetched = await fetcher("k", "t", run(), { size: 0 }, undefined, 1);
    expect(calls).toBe(5);
    expect(calls).toBeLessThanOrEqual(STEP_MAX_CALLS);
    expect(fetched.page.nodes.map((node) => [node.id, node.history.length])).toEqual([["a", 2], ["b", 2], ["c", 2], ["d", 1]]);
    expect(fetched).toMatchObject({ capped: 1, truncated: 0, unreadable: 0 });
  });

  it("prazo do MCP: a extra da primeira issue não cabe e a página já é de 1 → a issue fica truncada (erro), e a página é gravada", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const extra = vi.fn();
    const fetcher = historyWith({ listTeamHistory: vi.fn(async () => ((now += 6_000), page(["a"], () => true))), listIssueHistory: extra });
    const fetched = await fetcher("k", "t", run(1), { size: 0 }, undefined, 1, now + 15_000);
    expect(extra).not.toHaveBeenCalled();
    expect(fetched).toMatchObject({ truncated: 1, capped: 0 });
  });

  it("prazo do MCP com página maior: a primeira issue não cabe → página de 1 (chame de novo), nunca 0", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = historyWith({ listTeamHistory: vi.fn(async () => ((now += 6_000), page(TEN, (id) => id === "a"))), listIssueHistory: vi.fn() });
    await expect(fetcher("k", "t", run(), { size: 0 }, undefined, 1, now + 15_000)).rejects.toMatchObject({ name: "StepOutOfTime", shrinkTo: 1 });
  });

  it("limite de taxa numa página extra: o erro sobe (a rodada espera) e nada da página é usado", async () => {
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async () => page(["a", "b"], () => true)),
      listIssueHistory: vi.fn(async (_k: string, issueId: string) => {
        if (issueId === "b") throw new LinearError("linear_rate_limited", 30);
        return { history: [], nextCursor: null, skippedInvalid: 0, incomplete: false };
      }),
    });
    await expect(fetcher("k", "t", run(), { size: 0 }, undefined, 1)).rejects.toMatchObject({ code: "linear_rate_limited" });
  });

  it("erro numa página extra: o que não se reduz trunca só aquela issue; o que se reduz (`errors`, prazo, corpo grande) é pedido pela metade", async () => {
    const sizes: [string, number | undefined][] = [];
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async () => page(["a", "b", "c"], () => true)),
      listIssueHistory: vi.fn(async (_k: string, issueId: string, _after: string, options?: { first?: number }) => {
        sizes.push([issueId, options?.first]);
        if (issueId === "a") throw new LinearError("linear_unavailable");
        if (issueId === "b" && (options?.first ?? 180) > 90) throw new LinearError("linear_timeout");
        return { history: [entry(`${issueId}-20`)], nextCursor: null, skippedInvalid: 0, incomplete: false };
      }),
    });
    const fetched = await fetcher("k", "t", run(), { size: 0 }, undefined, 1);
    expect(fetched.page.nodes.map((node) => [node.id, node.history.length])).toEqual([["a", 1], ["b", 2], ["c", 2]]);
    expect(fetched).toMatchObject({ truncated: 1, capped: 0 });
    expect(sizes).toEqual([["a", 180], ["b", 180], ["b", 90], ["c", 180]]);
  });

  it("página extra que se reduz e não cabe no passo: a página encolhe (nada gravado); na página de 1, a issue fica truncada", async () => {
    const always = vi.fn(async () => {
      throw new LinearError("linear_partial_response");
    });
    const many = historyWith({ listTeamHistory: vi.fn(async () => page(["a", "b"], () => true)), listIssueHistory: always });
    await expect(many("k", "t", run(), { size: 0 }, undefined, 1)).rejects.toMatchObject({ name: "StepOutOfTime" });
    const one = historyWith({ listTeamHistory: vi.fn(async () => page(["a"], () => true)), listIssueHistory: always });
    const fetched = await one("k", "t", run(1), { size: 0 }, undefined, 1);
    expect(fetched).toMatchObject({ truncated: 1, capped: 0 });
    expect(fetched.page.nodes.map((node) => [node.id, node.history.length])).toEqual([["a", 1]]);
  });

  it("e-mail recusado numa página extra: a recusa é gravada, a extra é repetida sem e-mail e a página inteira vale como sem e-mail", async () => {
    const asked: (boolean | undefined)[] = [];
    const refused: number[] = [];
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async () => page(["a"], () => true)),
      listIssueHistory: vi.fn(async (_k: string, _id: string, _after: string, options?: { withEmail?: boolean }) => {
        asked.push(options?.withEmail);
        if (options?.withEmail !== false) throw new LinearError("linear_email_unavailable");
        return { history: [entry("a-20")], nextCursor: null, skippedInvalid: 0, incomplete: false };
      }),
    });
    const fetched = await fetcher("k", "t", run(), { size: 0 }, async () => void refused.push(1), 1);
    expect(asked).toEqual([true, false]);
    expect(refused).toEqual([1]);
    expect(fetched).toMatchObject({ withEmail: false, truncated: 0 });
    expect(fetched.page.nodes[0]!.history).toHaveLength(2);
  });

  it("e-mail recusado na página principal: repete sem e-mail no mesmo orçamento; com a recusa já gravada, nem pede", async () => {
    const asked: (boolean | undefined)[] = [];
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async (_k: string, _t: string, _a: string | null, options?: { withEmail?: boolean }) => {
        asked.push(options?.withEmail);
        if (options?.withEmail !== false) throw new LinearError("linear_email_unavailable");
        return page(["a"], () => false);
      }),
    });
    expect(await fetcher("k", "t", run(), { size: 0 }, async () => undefined, 1)).toMatchObject({ withEmail: false });
    expect(asked).toEqual([true, false]);
    asked.length = 0;
    await fetcher("k", "t", run(10, { assigneeEmailUnavailable: true }), { size: 0 }, async () => undefined, 1);
    expect(asked).toEqual([false]);
  });

  it("página principal grande demais, lenta ou com `errors` sem `data`: reduz à metade (10, 5, 2, 1); com 1 e `errors`, relê só os ids", async () => {
    const asked: { first: number; withHistory: boolean | undefined }[] = [];
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async (_k: string, _t: string, _a: string | null, options?: { first?: number; withHistory?: boolean }) => {
        asked.push({ first: options?.first ?? 0, withHistory: options?.withHistory });
        if (options?.withHistory === false) return { nodes: [{ id: "a", history: [], historyNext: null }], nextCursor: "1", skippedInvalid: 0, historyErrors: 0 };
        throw new LinearError(asked.length === 1 ? "linear_response_too_large" : asked.length === 2 ? "linear_timeout" : "linear_partial_response");
      }),
    });
    const progress = { size: 0 };
    const fetched = await fetcher("k", "t", run(), progress, undefined, 0);
    expect(asked.map((ask) => ask.first)).toEqual([10, 5, 2, 1, 1]);
    expect(asked.at(-1)!.withHistory).toBe(false);
    expect(fetched).toMatchObject({ unreadable: 1, truncated: 1, usedSize: 1, reduced: true });
    expect(progress.size).toBe(1);
  });

  it("o filtro incremental da rodada vai em toda consulta da página (também na releitura só dos ids)", async () => {
    const since: (string | null | undefined)[] = [];
    const fetcher = historyWith({
      listTeamHistory: vi.fn(async (_k: string, _t: string, _a: string | null, options?: { updatedSince?: string | null }) => (since.push(options?.updatedSince), page([], () => false))),
    });
    await fetcher("k", "t", { ...run(), historySince: new Date("2026-11-20T10:00:00.000Z") }, { size: 0 }, undefined, 1);
    await fetcher("k", "t", { ...run(), cursor: "^0.i|5", historySince: new Date("2026-11-20T10:00:00.000Z") }, { size: 0 }, undefined, 1);
    await fetcher("k", "t", run(), { size: 0 }, undefined, 1);
    expect(since).toEqual(["2026-11-20T10:00:00.000Z", "2026-11-20T10:00:00.000Z", null]);
  });
});
