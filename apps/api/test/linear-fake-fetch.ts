// Fetch falso do Linear: nenhuma chamada sai da máquina; as respostas são montadas à mão pelo teste.
export type LinearCall = { method: string; url: string; headers: Record<string, string>; query: string; variables: Record<string, unknown>; redirect: string | undefined };
export type LinearReply =
  | { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string }
  | { throws: Error }
  | { hang: true }
  /** Cabeçalhos chegam, o corpo nunca termina (some só quando o pedido é abortado). */
  | { slowBody: true };

/** Respostas em fila: cada chamada consome a próxima (a última se repete). `handler` decide pela consulta, se preferir. */
export function linearFakeFetch(replies: LinearReply[] | ((call: LinearCall) => LinearReply)) {
  const calls: LinearCall[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as { query?: string; variables?: Record<string, unknown> }) : {};
    const call: LinearCall = { method: (init?.method ?? "GET").toUpperCase(), url, headers, query: parsed.query ?? "", variables: parsed.variables ?? {}, redirect: init?.redirect };
    calls.push(call);
    const reply = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : (replies as (c: LinearCall) => LinearReply)(call);
    if (!reply) return Promise.reject(new Error("sem resposta prevista"));
    if ("throws" in reply) return Promise.reject(reply.throws);
    if ("hang" in reply) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("abortado")));
      });
    }
    if ("slowBody" in reply) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason ?? new Error("abortado")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    }
    const status = reply.status ?? 200;
    const response = new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
    return Promise.resolve(response);
  };
  return { impl: impl as typeof fetch, calls };
}

export const whoamiBody = (workspace = { id: "ws-1", name: "Acme", urlKey: "acme" }, viewerId = "viewer-1") => ({ data: { viewer: { id: viewerId }, organization: workspace } });

export const teamsBody = (nodes: { id: string; key: string; name: string }[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { teams: { nodes, pageInfo: { hasNextPage, endCursor } } },
});

/**
 * O `fetch` que a aplicação de teste recebe no lugar do real: sem resposta programada, falha o teste (nada sai da máquina).
 * `use(replies | função)` programa as próximas respostas; `calls` registra tudo desde o último `reset()`.
 */
export class LinearFetchSwitch {
  calls: LinearCall[] = [];
  private current: ReturnType<typeof linearFakeFetch> | null = null;
  /** Gancho que o teste usa para mexer no mundo (banco, outra chamada) ENTRE o pedido e a resposta. */
  beforeReply: ((call: LinearCall) => Promise<void> | void) | null = null;
  readonly impl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!this.current) throw new Error("chamada ao Linear sem resposta programada no teste");
    const before = this.current.calls.length;
    const pending = this.current.impl(input, init);
    const recorded = this.current.calls.slice(before);
    this.calls.push(...recorded);
    if (this.beforeReply) for (const call of recorded) await this.beforeReply(call);
    return pending;
  }) as typeof fetch;
  use(replies: LinearReply[] | ((call: LinearCall) => LinearReply)): void {
    this.current = linearFakeFetch(replies);
  }
  reset(): void {
    this.current = null;
    this.calls = [];
    this.beforeReply = null;
  }
}
