import { z } from "zod";
import { LinearError } from "./ports.js";
import type { LinearClient, LinearFailureCode, LinearIdentity, LinearIssuesOptions, LinearIssuesPage, LinearProjectsOptions, LinearProjectsPage, LinearTeam } from "./ports.js";

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
/** Teto do corpo das páginas da importação (issues e projetos): uma página de 50 issues com descrições longas passa de 1 MB. */
export const LINEAR_IMPORT_MAX_BODY_BYTES = 4 * 1_048_576;
export const LINEAR_NAME_MAX = 200;
export const LINEAR_TEAM_KEY_MAX = 20;
/** Itens por página da importação (issues e projetos). */
export const LINEAR_IMPORT_PAGE_SIZE = 50;
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

const COUNT_QUERY = "query TeamIssueCount($id: String!) { team(id: $id) { issueCount(includeArchived: false) } }";
/** Projetos: resumo, conteúdo longo (some na repetição por corpo grande), prioridade e líder (o e-mail só para casar a pessoa). */
const projectsQuery = (withContent: boolean, withEmail: boolean): string =>
  `query TeamProjects($id: String!, $after: String, $first: Int!) { team(id: $id) { projects(first: $first, after: $after) { nodes { id name url description ${withContent ? "content " : ""}priority status { type } lead { id${withEmail ? " email" : ""} } } pageInfo { hasNextPage endCursor } } } }`;
/** Mais novas primeiro (`createdAt`, o padrão do Linear, dito aqui para a repescagem poder confiar). Sem `children` nem `labels`. */
const issuesQuery = (withDescription: boolean, withEmail: boolean): string =>
  `query TeamIssues($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id identifier url title ${withDescription ? "description " : ""}priority updatedAt createdAt startedAt completedAt canceledAt previousIdentifiers trashed state { type } parent { id } project { id } assignee { id${withEmail ? " email" : ""} } creator { id name${withEmail ? " email" : ""} } } pageInfo { hasNextPage endCursor } } } }`;

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

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const countSchema = z.object({ data: z.object({ team: z.object({ issueCount: z.number().int().min(0) }) }) });
const projectNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  status: z.object({ type: z.string() }).nullable().optional(),
  // Os campos da sincronização (ADR 0061) NUNCA derrubam o nó: se vierem malformados, valem como ausentes (os antigos continuam estritos).
  description: z.string().nullable().optional().catch(null),
  content: z.string().nullable().optional().catch(null),
  priority: z.number().nullable().optional().catch(null),
  lead: z.object({ id: z.string().min(1), email: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
});
// Os nós são validados um a um (um nó ruim não derruba a página); só o envelope é exigido por inteiro.
const projectsSchema = z.object({ data: z.object({ team: z.object({ projects: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) }) });
const issueNodeSchema = z.object({
  id: z.string().min(1),
  identifier: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number(),
  updatedAt: z.string(),
  trashed: z.boolean().nullable().optional(),
  state: z.object({ type: z.string() }),
  parent: z.object({ id: z.string().min(1) }).nullable().optional(),
  project: z.object({ id: z.string().min(1) }).nullable().optional(),
  assignee: z.object({ id: z.string().min(1), email: z.string().nullable().optional() }).nullable().optional(),
  // Os campos da sincronização (ADR 0061) são opcionais: um nó de um servidor que não os traz continua valendo.
  // ...e, se vierem malformados, valem como ausentes: o nó entra sem eles.
  createdAt: z.string().nullable().optional().catch(null),
  startedAt: z.string().nullable().optional().catch(null),
  completedAt: z.string().nullable().optional().catch(null),
  canceledAt: z.string().nullable().optional().catch(null),
  previousIdentifiers: z.array(z.string()).nullable().optional().catch(null),
  creator: z.object({ id: z.string().min(1), name: z.string().nullable().optional().catch(null), email: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
});
const issuesSchema = z.object({ data: z.object({ team: z.object({ issues: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) }) });

/** Valida cada nó sozinho: devolve os válidos e quantos foram pulados. */
function validNodes<S extends z.ZodType>(schema: S, nodes: readonly unknown[]): { valid: z.output<S>[]; skipped: number } {
  const valid: z.output<S>[] = [];
  for (const node of nodes) {
    const parsed = schema.safeParse(node);
    if (parsed.success) valid.push(parsed.data);
  }
  return { valid, skipped: nodes.length - valid.length };
}

/** `hasNextPage` sem cursor é resposta defeituosa: falha em vez de parar no meio ou girar para sempre. */
function nextCursor(info: { hasNextPage: boolean; endCursor: string | null }): string | null {
  if (!info.hasNextPage) return null;
  if (info.endCursor === null) throw new LinearError("linear_unavailable");
  return info.endCursor;
}

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

/**
 * Todos os erros da resposta trazem um caminho que termina em `email`? Então o campo foi recusado (permissão da chave). Só vale com
 * caminho: mensagem sem caminho que cita "email" não prova nada. Só a consulta de issues pergunta isso.
 */
function emailFieldDenied(body: unknown): boolean {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((item) => {
    const path = (item as { path?: unknown } | null)?.path;
    return Array.isArray(path) && path[path.length - 1] === "email";
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
async function readBody(response: Response, signal: AbortSignal, maxBytes: number, tooLarge: LinearFailureCode, onTimeout: LinearFailureCode): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new LinearError(tooLarge);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new LinearError(onTimeout)), { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new LinearError(tooLarge);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof LinearError ? error : new LinearError(onTimeout);
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

  async countTeamIssues(apiKey: string, teamId: string): Promise<number> {
    const body = await this.request(apiKey, COUNT_QUERY, { id: teamId }, this.timeoutMs);
    const parsed = countSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    return parsed.data.data.team.issueCount;
  }

  async listTeamProjects(apiKey: string, teamId: string, after: string | null, options: LinearProjectsOptions = {}): Promise<LinearProjectsPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withContent = options.withContent !== false;
    let withEmail = options.withEmail !== false;
    let emailUnavailable = false;
    let body: unknown;
    for (;;) {
      try {
        body = await this.request(apiKey, projectsQuery(withContent, withEmail), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail);
        break;
      } catch (error) {
        // O Linear recusou o `email` do líder (permissão da chave): repete sem ele, uma vez, e avisa a importação.
        if (withEmail && error instanceof LinearError && error.code === "linear_email_unavailable") {
          withEmail = false;
          emailUnavailable = true;
          continue;
        }
        throw error;
      }
    }
    const parsed = projectsSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.projects;
    const { valid, skipped } = validNodes(projectNodeSchema, nodes);
    return {
      nodes: valid.map((node) => ({
        id: node.id,
        name: node.name,
        url: node.url,
        statusType: node.status?.type ?? null,
        description: node.description ?? null,
        content: node.content ?? null,
        priority: Math.round(node.priority ?? 0),
        lead: node.lead ? { id: node.lead.id, email: node.lead.email ?? null } : null,
      })),
      nextCursor: nextCursor(pageInfo),
      skippedInvalid: skipped,
      emailUnavailable,
    };
  }

  async listTeamIssues(apiKey: string, teamId: string, after: string | null, options: LinearIssuesOptions = {}): Promise<LinearIssuesPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withDescription = options.withDescription !== false;
    let withEmail = options.withEmail !== false;
    let emailUnavailable = false;
    let body: unknown;
    for (;;) {
      try {
        body = await this.request(apiKey, issuesQuery(withDescription, withEmail), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail);
        break;
      } catch (error) {
        // O Linear recusou o campo `email` (permissão da chave): repete sem ele, uma vez, e avisa a importação.
        if (withEmail && error instanceof LinearError && error.code === "linear_email_unavailable") {
          withEmail = false;
          emailUnavailable = true;
          continue;
        }
        throw error;
      }
    }
    const parsed = issuesSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.issues;
    const { valid, skipped } = validNodes(issueNodeSchema, nodes);
    return {
      nodes: valid.map((node) => ({
        id: node.id,
        identifier: node.identifier,
        url: node.url,
        title: node.title,
        description: node.description ?? null,
        priority: Math.round(node.priority),
        updatedAt: node.updatedAt,
        trashed: node.trashed === true,
        stateType: node.state.type,
        parentId: node.parent?.id ?? null,
        projectId: node.project?.id ?? null,
        assignee: node.assignee ? { id: node.assignee.id, email: node.assignee.email ?? null } : null,
        createdAt: node.createdAt ?? null,
        startedAt: node.startedAt ?? null,
        completedAt: node.completedAt ?? null,
        canceledAt: node.canceledAt ?? null,
        previousIdentifiers: node.previousIdentifiers ?? [],
        creator: node.creator ? { id: node.creator.id, name: node.creator.name ?? "", email: node.creator.email ?? null } : null,
      })),
      nextCursor: nextCursor(pageInfo),
      skippedInvalid: skipped,
      emailUnavailable,
    };
  }

  /** `notFoundIsNull`: um "Entity not found" do Linear devolve `null` em vez de erro (usado por `getTeam`). `detectEmail`: só a consulta de issues. */
  private async request(apiKey: string, query: string, variables: Record<string, unknown>, timeoutMs: number, notFoundIsNull = false, maxBytes = LINEAR_MAX_BODY_BYTES, detectEmail = false): Promise<unknown> {
    if (!HEADER_SAFE.test(apiKey)) throw new LinearError("linear_key_invalid");
    const importPage = maxBytes !== LINEAR_MAX_BODY_BYTES;
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
      // Nada da exceção original é guardado: ela pode citar o endereço ou a chave. Só nas páginas da importação o prazo estourado é
      // dito à parte (`linear_timeout`): a importação repete com página menor.
      throw new LinearError(importPage && signal.aborted ? "linear_timeout" : "linear_unavailable");
    }
    // Só as páginas da importação (teto maior) distinguem "grande demais" e "prazo" de "indisponível": a importação repete com página menor.
    const body = await readBody(response, signal, maxBytes, importPage ? "linear_response_too_large" : "linear_unavailable", importPage ? "linear_timeout" : "linear_unavailable");
    const codes = errorCodes(body);
    if (detectEmail && response.status < 500 && emailFieldDenied(body)) throw new LinearError("linear_email_unavailable");
    if (notFoundIsNull && response.status < 500 && entityNotFound(body)) return null;
    if (response.status === 429 || codes.includes("RATELIMITED")) throw new LinearError("linear_rate_limited", retryAfter(response));
    if (response.status === 401 || response.status === 403 || codes.some((code) => AUTH_CODES.has(code))) throw new LinearError("linear_key_invalid");
    if (!response.ok || body === null || codes.length > 0 || Array.isArray((body as { errors?: unknown }).errors)) throw new LinearError("linear_unavailable");
    return body;
  }
}
