import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearImportService, STEP_MAX_CALLS } from "../src/linear/linear-import.service.js";
import { LinearError } from "../src/linear/ports.js";
import type { LinearClient } from "../src/linear/ports.js";

// L9 item 3: a ida ao Linear de um passo (prazo reduz a página como o corpo grande, teto de 6 chamadas e 25 s).
type Fetcher = (key: string, teamId: string, run: unknown, progress: { size: number }) => Promise<{ page: unknown; nextPageSize: number; withoutDescription: boolean }>;
const run = (pageSize = 50) => ({ cursor: null, pageSize, counts: {} });
function serviceWith(listTeamIssues: LinearClient["listTeamIssues"]) {
  const service = new LinearImportService({ listTeamIssues } as unknown as LinearClient, null as never, null as never, null as never, null as never);
  return (service as unknown as { fetchIssues: Fetcher }).fetchIssues.bind(service);
}
const okPage = { nodes: [], nextCursor: null, skippedInvalid: 0, emailUnavailable: false };

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
    expect(result.nextPageSize).toBe(6);
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
