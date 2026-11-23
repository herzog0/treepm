/** Estatística pura da medição de escritas concorrentes: percentis, contagem por código e vazão. */

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))] as number;
}

export interface Sample { readonly ms: number; readonly code: string }
/** Códigos: `2xx`, `409 structure_busy`, `409 concurrent_update`, `409 <outro código>`, `429`, `4xx`, `500 <código>`, `503 server_busy`, `5xx`, `erro de rede`. */
export function codeOf(status: number, body: string): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 409) {
    const m = /"code"\s*:\s*"([a-z_]+)"/.exec(body);
    return `409 ${m?.[1] ?? "?"}`;
  }
  if (status === 429) return "429";
  if (status >= 500) {
    const m = /"code"\s*:\s*"([a-z_]+)"/.exec(body);
    if (status === 500 && m !== null) return `500 ${m[1]}`;
    if (status === 503 && m?.[1] === "server_busy") return "503 server_busy";
    return "5xx";
  }
  if (status >= 400) return `${status}`;
  return `${status}`;
}

export interface Summary {
  readonly count: number;
  readonly okCount: number;
  readonly throughput: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly codes: Record<string, number>;
}

export function summarize(samples: readonly Sample[], seconds: number, okOnly = false): Summary {
  const codes: Record<string, number> = {};
  for (const s of samples) codes[s.code] = (codes[s.code] ?? 0) + 1;
  const okCount = codes["2xx"] ?? 0;
  const considered = okOnly ? samples.filter((s) => s.code === "2xx") : samples;
  const times = considered.map((s) => s.ms).sort((a, b) => a - b);
  const r = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
  return {
    count: samples.length,
    okCount,
    throughput: seconds > 0 ? Math.round((okCount / seconds) * 10) / 10 : 0,
    p50: r(percentile(times, 50)),
    p95: r(percentile(times, 95)),
    p99: r(percentile(times, 99)),
    max: r(times.length ? (times[times.length - 1] as number) : null),
    codes,
  };
}
