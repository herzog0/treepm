import { TOKEN_HEADER } from "./app.js";
import type { HttpResult } from "./core.js";

export type ApiResponse = HttpResult;

/** Cliente HTTP da própria API em processo. Nunca imprime cabeçalhos nem corpos. */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { [TOKEN_HEADER]: this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed };
  }
}

/** Só o código do erro e o status, nunca texto de ticket. */
export function describeFailure(what: string, response: ApiResponse): string {
  const body = response.body as { code?: unknown; error?: { code?: unknown } } | null;
  const code = body?.error?.code ?? body?.code;
  return `${what}: resposta ${response.status}${typeof code === "string" ? ` (${code})` : ""}`;
}

export function expectOk<T>(what: string, response: ApiResponse): T {
  if (response.status < 200 || response.status >= 300) throw new Error(describeFailure(what, response));
  return response.body as T;
}
