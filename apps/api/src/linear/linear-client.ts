import { z } from "zod";
import { LinearError } from "./ports.js";
import type { LinearClient, LinearIdentity, LinearTeam } from "./ports.js";

export { LinearError } from "./ports.js";

/** Endpoint único do Linear (documentação lida em 2026-11-24). */
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Prazo de cada chamada, em milissegundos. */
export const LINEAR_TIMEOUT_MS = 10_000;
/** Times por página e teto de times lidos (5 páginas). */
export const LINEAR_TEAM_PAGE_SIZE = 100;
export const LINEAR_TEAM_CEILING = 500;
/** Teto de páginas por listagem e prazo total dela: uma página vazia com `hasNextPage` conta e não gira para sempre. */
export const LINEAR_TEAM_MAX_PAGES = 5;
export const LINEAR_LIST_TIMEOUT_MS = 30_000;
/** Teto do corpo de cada resposta (acima disso → `linear_unavailable`) e do que se guarda do que o Linear diz. */
export const LINEAR_MAX_BODY_BYTES = 1_048_576;
export const LINEAR_NAME_MAX = 200;
export const LINEAR_TEAM_KEY_MAX = 20;
/** Espera sugerida quando o Linear limita a taxa e não diz quanto. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export type HttpLinearClientOptions = {
  /** Prazo por chamada (ms); padrão 10 s. */
  timeoutMs?: number;
  /** Prazo total de uma listagem paginada (ms); padrão 30 s. */
  listTimeoutMs?: number;
  /** Só os testes trocam. */
  fetch?: typeof fetch;
};

const WHOAMI_QUERY = "query Whoami { viewer { id } organization { id name urlKey } }";
const TEAMS_QUERY = "query Teams($after: String) { teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }";

const TEAM_QUERY = "query Team($id: String!) { team(id: $id) { id key name } }";

const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

const identitySchema = z.object({
  data: z.object({
    viewer: z.object({ id: z.string().min(1) }),
    organization: z.object({ id: z.string().min(1), name: z.string(), urlKey: z.string() }),
  }),
});
const teamNodeSchema = z.object({ id: z.string().min(1), key: z.string(), name: z.string() });
const teamSchema = z.object({ data: z.object({ team: teamNodeSchema.nullable() }) });
const teamsSchema = z.object({
  data: z.object({
    teams: z.object({
      nodes: z.array(teamNodeSchema),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});

/** Códigos de erro do Linear (`errors[].extensions.code`) que significam "chave recusada". */
const AUTH_CODES = new Set(["AUTHENTICATION_ERROR", "AUTHENTICATION_REQUIRED", "FORBIDDEN", "UNAUTHENTICATED"]);

/** A chave vai num cabeçalho: só ASCII imprimível, sem espaço. O resto nunca chega à rede (e a exceção do fetch poderia citá-la). */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** Os códigos de `errors[]` de um corpo qualquer (nada mais do corpo é lido). */
function errorCodes(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => {
    const code = (item as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    return typeof code === "string" ? code : "";
  });
}

const toTeam = (node: { id: string; key: string; name: string }): LinearTeam => ({ id: node.id, key: cut(node.key, LINEAR_TEAM_KEY_MAX), name: cut(node.name, LINEAR_NAME_MAX) });

/** `INVALID_INPUT` com "Entity not found": é assim que o Linear diz que um id não existe ou não é visível. */
function entityNotFound(body: unknown): boolean {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((item) => {
      const e = item as { message?: unknown; extensions?: { code?: unknown; type?: unknown } } | null;
      return e?.extensions?.code === "INVALID_INPUT" && typeof e.message === "string" && /entity not found/i.test(e.message);
    })
  );
}

/** Lê o corpo até o teto, sob o mesmo prazo da chamada (um corpo lento não prende a requisição). */
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LINEAR_MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new LinearError("linear_unavailable");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new LinearError("linear_unavailable")), { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > LINEAR_MAX_BODY_BYTES) throw new LinearError("linear_unavailable");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof LinearError ? error : new LinearError("linear_unavailable");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Cliente GraphQL do Linear com `fetch` injetável (ADR 0060). A chave pessoal vai em `Authorization` SEM `Bearer`. Toda falha vira
 * `LinearError` com um código curto; uma resposta HTTP 200 com `errors` no corpo também é falha. Nem a chave, nem o corpo, nem a
 * exceção original entram no erro.
 */
export class HttpLinearClient implements LinearClient {
  private readonly timeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: HttpLinearClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? LINEAR_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? LINEAR_LIST_TIMEOUT_MS;
    this.doFetch = options.fetch ?? fetch;
  }

  async whoami(apiKey: string): Promise<LinearIdentity> {
    const body = await this.request(apiKey, WHOAMI_QUERY, {}, this.timeoutMs);
    const parsed = identitySchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { viewer, organization } = parsed.data.data;
    return { workspace: { id: organization.id, name: cut(organization.name, LINEAR_NAME_MAX), urlKey: organization.urlKey }, viewer: { id: viewer.id } };
  }

  async listTeams(apiKey: string): Promise<LinearTeam[]> {
    const teams: LinearTeam[] = [];
    const deadline = Date.now() + this.listTimeoutMs;
    let after: string | null = null;
    for (let page = 0; page < LINEAR_TEAM_MAX_PAGES && teams.length < LINEAR_TEAM_CEILING; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LinearError("linear_unavailable");
      const body = await this.request(apiKey, TEAMS_QUERY, { after }, Math.min(this.timeoutMs, remaining));
      const parsed = teamsSchema.safeParse(body);
      if (!parsed.success) throw new LinearError("linear_unavailable");
      const result = parsed.data.data.teams;
      for (const node of result.nodes) teams.push(toTeam(node));
      if (!result.pageInfo.hasNextPage || result.pageInfo.endCursor === null) break;
      after = result.pageInfo.endCursor;
    }
    return teams.slice(0, LINEAR_TEAM_CEILING);
  }

  async getTeam(apiKey: string, teamId: string): Promise<LinearTeam | null> {
    const body = await this.request(apiKey, TEAM_QUERY, { id: teamId }, this.timeoutMs, true);
    if (body === null) return null;
    const parsed = teamSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    return parsed.data.data.team ? toTeam(parsed.data.data.team) : null;
  }

  /** `notFoundIsNull`: um "Entity not found" do Linear devolve `null` em vez de erro (usado por `getTeam`). */
  private async request(apiKey: string, query: string, variables: Record<string, unknown>, timeoutMs: number, notFoundIsNull = false): Promise<unknown> {
    if (!HEADER_SAFE.test(apiKey)) throw new LinearError("linear_key_invalid");
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal,
        // Um redirecionamento reenviaria a chave a outro destino: recusado (vira `linear_unavailable`).
        redirect: "error",
      });
    } catch {
      // Nada da exceção original é guardado: ela pode citar o endereço ou a chave.
      throw new LinearError("linear_unavailable");
    }
    const body = await readBody(response, signal);
    const codes = errorCodes(body);
    if (notFoundIsNull && response.status < 500 && entityNotFound(body)) return null;
    if (response.status === 429 || codes.includes("RATELIMITED")) throw new LinearError("linear_rate_limited", retryAfter(response));
    if (response.status === 401 || response.status === 403 || codes.some((code) => AUTH_CODES.has(code))) throw new LinearError("linear_key_invalid");
    if (!response.ok || body === null || codes.length > 0 || Array.isArray((body as { errors?: unknown }).errors)) throw new LinearError("linear_unavailable");
    return body;
  }
}
