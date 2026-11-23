import { isIP } from "node:net";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpHttpHandler, McpServerFactory } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { RateLimiter } from "../access-tokens/rate-limiter.js";
import { parseToken } from "../access-tokens/token.js";
import { AccessTokenService } from "../access-tokens/access-token.service.js";
import type { ResolveResult } from "../access-tokens/access-token.service.js";
import type { Principal } from "../access/principal.js";
import { CONFIG, allowedOrigins } from "../config.js";
import type { AppConfig } from "../config.js";
import { TenantTransactions } from "../db/tenant-transactions.js";
import { AuthorizationService } from "../access/authorization.service.js";
import { ProjectQueryService } from "../query/project-query.service.js";
import { AgentWorkService } from "../tickets/agent-work.service.js";
import { TicketCommentsService } from "../tickets/ticket-comments.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { isConnectionWaitTimeout } from "../common/connection-wait.js";
import { createProjectServer } from "./mcp-server.js";
import type { RunInTenant } from "./mcp-tools.js";
import { WRITE_TOOL_NAMES } from "./mcp-write-tools.js";

/** Teto do corpo de uma requisição (uma mensagem JSON-RPC). */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Requisições por minuto por endereço IP, antes de qualquer outra conferência (ADR 0038). Em MEMÓRIA do processo:
 * a publicação prevê uma máquina só; com mais de uma, o limite efetivo passa a ser por máquina.
 */
export const IP_LIMIT_PER_MINUTE = 120;
/** Escritas por minuto por token (ADR 0043), contadas à parte das leituras. */
export const WRITE_LIMIT_PER_MINUTE = 20;
/** Somando todos os tokens da mesma pessoa na mesma organização (TREEPM-197). */
export const WRITE_LIMIT_PER_PERSON_PER_MINUTE = 40;
const IP_WINDOW_MS = 60_000;

/** Prazo total de uma requisição ao servidor MCP (inclui o corpo da resposta). */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Resoluções de token ao mesmo tempo (cada uma abre transação no banco, que é dividido com o resto da API) e fila de espera. */
export const MAX_CONCURRENT_RESOLVES = 4;
export const MAX_QUEUED_RESOLVES = 16;

const NO_STORE = "no-store";
/** Cabeçalhos que nunca seguem para o SDK: a credencial fica aqui. */
const DROPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "host", "content-length", "connection", "transfer-encoding"]);
const SAFE_LABEL = /^[A-Za-z0-9_./-]{1,64}$/;

/** O que o código das ferramentas recebe: identidade e projeto, nunca o token. */
type Resolved = Extract<ResolveResult, { ok: true }>;

/** Falha de HTTP com o formato de erro da API (`{ error: { code, message } }`). */
class HttpFailure {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
    readonly headers: Record<string, string> = {},
  ) {}
}

/**
 * Entrada HTTP do servidor MCP (ADR 0038): `POST /api/mcp/:projectKey`, fora da guarda de sessão (a autenticação é
 * só o token). Roda como middleware do Express, ANTES do leitor de corpo do Nest (ver `bootstrap.ts`), para o teto de
 * 64 KB e o limite por IP valerem antes de qualquer leitura de corpo.
 *
 * Ordem: limite por IP, método, `Origin`, corpo, token (`Authorization: Bearer`), resolução do token, e só então o
 * servidor MCP, que responde em JSON simples. Nada aqui grava o token, o cabeçalho, os argumentos ou os resultados em log.
 */
@Injectable()
export class McpGateway {
  private readonly logger = new Logger("Mcp");
  private readonly ipLimiter: RateLimiter;
  private readonly writeLimiter: RateLimiter;
  private readonly personWriteLimiter: RateLimiter;
  private readonly handler: McpHttpHandler;
  private readonly gate = new Gate(MAX_CONCURRENT_RESOLVES, MAX_QUEUED_RESOLVES);
  /** Prazo total por requisição; mutável só para os testes. */
  timeoutMs = REQUEST_TIMEOUT_MS;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ACCESS_TOKEN_CLOCK) clock: AccessTokenClock,
    @Inject(AccessTokenService) private readonly tokens: AccessTokenService,
    @Inject(TenantTransactions) private readonly tenants: TenantTransactions,
    @Inject(ProjectQueryService) private readonly query: ProjectQueryService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketCommentsService) private readonly comments: TicketCommentsService,
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {
    this.ipLimiter = new RateLimiter(clock, IP_LIMIT_PER_MINUTE, IP_WINDOW_MS);
    this.writeLimiter = new RateLimiter(clock, WRITE_LIMIT_PER_MINUTE, IP_WINDOW_MS);
    this.personWriteLimiter = new RateLimiter(clock, WRITE_LIMIT_PER_PERSON_PER_MINUTE, IP_WINDOW_MS);
    const run: RunInTenant = (principal, fn) => this.tenants.run({ orgId: principal.session.orgId, userId: principal.session.userId }, fn);
    const factory: McpServerFactory = (ctx) => {
      const resolved = ctx.authInfo?.extra?.["resolved"] as Resolved | undefined;
      if (!resolved) throw new Error("Requisição MCP sem identidade resolvida.");
      const base = { principal: resolved.principal as Principal, project: { id: resolved.project.id, key: resolved.project.key } };
      // As ferramentas de escrita só existem para token de escrita com a chave da organização ligada (ADR 0043).
      const canWrite = resolved.scope === "write" && resolved.writeEnabled;
      const services = { tickets: this.tickets, comments: this.comments, agentWork: this.agentWork, authorization: this.authorization };
      return createProjectServer(run, this.query, base, canWrite ? { services, context: { ...base, tokenId: resolved.tokenId, fresh: resolved.fresh } } : undefined);
    };
    this.handler = createMcpHandler(factory, {
      legacy: "stateless",
      responseMode: "json",
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (error) => this.logger.warn(`sdk: ${sanitizeForLog(error.message)}`),
    });
  }

  /** Esquece os limites guardados em memória (para testes: o relógio falso volta no tempo). */
  resetMemory(): void {
    this.ipLimiter.clear();
    this.writeLimiter.clear();
    this.personWriteLimiter.clear();
  }

  /** `rest` é o que vem depois de `/api/mcp`: deve ser `/<chave do projeto>`, com ou sem barra no fim. */
  async handle(req: Request, res: Response, rest: string): Promise<void> {
    const started = performance.now();
    const meta: { tokenId: string; method: string; tool: string } = { tokenId: "-", method: "-", tool: "-" };
    let bytes = 0;
    try {
      const reply = await this.process(req, res, rest, meta);
      bytes = this.send(res, reply);
    } catch (error) {
      bytes = this.sendFailure(res, error instanceof HttpFailure ? error : this.unexpected(error));
    }
    const ms = Math.round(performance.now() - started);
    this.logger.log(`token=${meta.tokenId} method=${meta.method} tool=${meta.tool} status=${res.statusCode} ${ms} ms ${bytes} bytes`);
  }

  /** Escrita: conta no limite do token e no da pessoa (a recusa devolve o maior `Retry-After` entre os dois). */
  private writeHit(tokenId: string, personKey: string): ReturnType<RateLimiter["hit"]> {
    // O que o limite do token já recusou não gasta a cota da pessoa.
    const byToken = this.writeLimiter.hit(tokenId);
    if (!byToken.allowed) return byToken;
    return this.personWriteLimiter.hit(personKey);
  }

  /** Balde do limite por IP: o cabeçalho configurado (se vier e for um IP válido) ou o IP da conexão. Nunca uma chave vazia. */
  private clientBucket(req: Request): string {
    const name = this.config.CLIENT_IP_HEADER;
    if (name !== undefined) {
      const header = req.headers[name.toLowerCase()];
      const bucket = typeof header === "string" ? ipBucket(header) : null;
      if (bucket !== null) return bucket;
    }
    const connection = req.ip ?? req.socket.remoteAddress ?? "";
    return ipBucket(connection) ?? (connection === "" ? "unknown" : connection);
  }

  private async process(req: Request, res: Response, rest: string, meta: { tokenId: string; method: string; tool: string }): Promise<Reply> {
    // 1. Limite por IP, antes de tudo.
    const hit = this.ipLimiter.hit(this.clientBucket(req));
    if (!hit.allowed) throw new HttpFailure(429, "rate_limited", "Too many requests.", { "Retry-After": String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))) });

    const projectKey = /^\/([^/]+)\/?$/.exec(rest)?.[1];
    if (projectKey === undefined) throw new HttpFailure(404, "not_found", "Not found.");

    // Só POST. Sem sessão e sem canal GET (a especificação permite 405).
    if (req.method !== "POST") throw new HttpFailure(405, "method_not_allowed", "Use POST.", { Allow: "POST" });

    // 2. Origin: se vier, tem que ser o do próprio site (APP_ORIGIN ou uma das extras).
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins(this.config).includes(origin)) throw new HttpFailure(403, "forbidden", "Origin not allowed.");

    // 3. Corpo, no máximo 64 KB, decodificado e interpretado UMA vez: o SDK recebe o valor já interpretado, então
    //    o gateway e o SDK nunca veem coisas diferentes. O BOM é tirado (vale para os dois). Só um objeto JSON vira
    //    mensagem: lote (array), número, texto e `null` são recusados aqui, antes do SDK.
    const message = parseMessage(await readBody(req));
    const labels = describe(message);
    meta.method = labels.method;
    meta.tool = labels.tool;

    // Sem canal de assinatura: `subscriptions/listen` abriria um fluxo SSE que não termina, fora do limite por token.
    if (labels.method === "subscriptions/listen") throw new HttpFailure(404, "not_found", "Subscriptions are not supported.");

    const isWrite = labels.method === "tools/call" && (WRITE_TOOL_NAMES as readonly string[]).includes(labels.tool);

    // 4. Token: só no cabeçalho, nunca na URL. Malformado é recusado antes de entrar na fila.
    const token = bearerToken(req.headers.authorization);
    if (token === null || !parseToken(token)) throw new HttpFailure(401, "unauthenticated", "Authentication required.", { "WWW-Authenticate": "Bearer" });

    // 5. Resolução do token, com no máximo 4 ao mesmo tempo (fila de 16).
    const release = await this.gate.enter();
    if (release === null) throw new HttpFailure(503, "service_unavailable", "Try again shortly.", { "Retry-After": "2" });
    let resolved: ResolveResult;
    try {
      // Escrita: a participação no Clerk é conferida de novo, sem a memória de 5 minutos da leitura (ADR 0043).
      // O pedido "fresco" só vale para token `write` com a chave ligada; o limite de escritas é contado antes de ir ao Clerk.
      resolved = await this.tokens.resolve(token, projectKey, { fresh: isWrite, onWriteAttempt: (tokenId, personKey) => this.writeHit(tokenId, personKey) });
    } catch (error) {
      if (isConnectionWaitTimeout(error)) {
        this.logger.warn("resolve: connection wait timed out (503 server_busy)");
        throw new HttpFailure(503, "server_busy", "The server is busy. Try again in a moment.", { "Retry-After": "1" });
      }
      this.logger.error(`resolve failed: ${errorClass(error)}`);
      throw new HttpFailure(503, "service_unavailable", "Try again shortly.", { "Retry-After": "5" });
    } finally {
      release();
    }
    if (!resolved.ok) {
      switch (resolved.reason) {
        case "invalid":
          throw new HttpFailure(401, "unauthenticated", "Authentication required.", { "WWW-Authenticate": "Bearer" });
        case "disabled":
          throw new HttpFailure(403, "forbidden", "MCP access is turned off for this organization.");
        case "not_found":
          throw new HttpFailure(404, "not_found", "Project not found.");
        case "rate_limited":
          throw new HttpFailure(429, "rate_limited", "Too many requests.", { "Retry-After": String(Math.max(1, resolved.retryAfterSeconds ?? 1)) });
      }
    }
    meta.tokenId = resolved.tokenId;
    // 6. Entrega ao servidor MCP, com prazo total e cancelamento se o cliente desconectar.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) abort.abort();
    };
    res.once("close", onClose);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new HttpFailure(504, "gateway_timeout", "The request took too long."));
      }, this.timeoutMs);
    });
    const work = (async (): Promise<Reply> => {
      const reply = await this.handler.fetch(toWebRequest(req, abort.signal), {
        parsedBody: message,
        // O SDK só repassa isto à fábrica: `token` aqui é o id do REGISTRO, não o segredo.
        authInfo: { token: resolved.tokenId, clientId: resolved.tokenId, scopes: [], extra: { resolved } },
      });
      const payload = Buffer.from(await reply.arrayBuffer());
      return { status: reply.status, headers: [...reply.headers.entries()], payload };
    })();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
    }
  }

  private unexpected(error: unknown): HttpFailure {
    if (isConnectionWaitTimeout(error)) {
      this.logger.warn("unexpected: connection wait timed out (503 server_busy)");
      return new HttpFailure(503, "server_busy", "The server is busy. Try again in a moment.", { "Retry-After": "1" });
    }
    this.logger.error(`unexpected: ${errorClass(error)}`);
    return new HttpFailure(500, "internal_error", "Internal error.");
  }

  private sendFailure(res: Response, failure: HttpFailure): number {
    const payload = JSON.stringify({ error: { code: failure.code, message: failure.message } });
    // O 413 fecha a conexão: o cabeçalho vai junto dos da falha, antes de a resposta terminar.
    const extra: Record<string, string> = failure.status === 413 ? { Connection: "close" } : {};
    res.status(failure.status).set({ ...failure.headers, ...extra, "Cache-Control": NO_STORE, "Content-Type": "application/json; charset=utf-8" }).end(payload);
    return Buffer.byteLength(payload);
  }

  private send(res: Response, reply: Reply): number {
    res.status(reply.status);
    for (const [name, value] of reply.headers) res.setHeader(name, value);
    res.setHeader("Cache-Control", NO_STORE);
    res.end(reply.payload);
    return reply.payload.length;
  }
}

type Reply = { status: number; headers: [string, string][]; payload: Buffer };

/** Decodifica (UTF-8 estrito, sem BOM) e interpreta o corpo; só um objeto JSON passa. */
function parseMessage(body: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HttpFailure(400, "validation_error", "Body must be one JSON object.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400, "validation_error", "Body must be one JSON object.");
  return value as Record<string, unknown>;
}

/** Texto vindo do cliente ou do SDK para o log: sem caracteres de controle (nenhuma linha forjada) e no máximo 200. */
export function sanitizeForLog(text: string): string {
  // eslint-disable-next-line no-control-regex -- é exatamente o que se quer tirar
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/** Só a classe do erro: a mensagem pode carregar argumentos de consulta. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** Fila simples: no máximo `limit` ao mesmo tempo e `queue` esperando; além disso, `null` (quem chama responde 503). */
class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly limit: number,
    private readonly queue: number,
  ) {}

  async enter(): Promise<(() => void) | null> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.queue) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    };
  }
}

/**
 * Chave do balde do limite por IP. IPv4 inteiro; IPv6 agrupado por /64 (IPv4 embutido em IPv6 vale como IPv4).
 * `null` quando não é um endereço IP válido.
 */
export function ipBucket(value: string): string | null {
  const text = value.trim();
  const kind = isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || "0", 16).toString(16)).join(":")}::/64`;
}

/** `Authorization: Bearer <token>`; qualquer outra forma é "sem token". */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** Lê o corpo até o teto; passou dele, 413 sem ler o resto. */
function readBody(req: Request): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(new HttpFailure(413, "payload_too_large", "Request body is too large (64 KB at most)."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        req.pause();
        reject(new HttpFailure(413, "payload_too_large", "Request body is too large (64 KB at most)."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Método e nome da ferramenta para o log: só rótulos curtos e seguros, nunca argumentos. */
function describe(message: Record<string, unknown>): { method: string; tool: string } {
  const method = typeof message["method"] === "string" && SAFE_LABEL.test(message["method"]) ? message["method"] : "other";
  const name = (message["params"] as { name?: unknown } | undefined)?.name;
  const tool = method === "tools/call" && typeof name === "string" && SAFE_LABEL.test(name) ? name : "-";
  return { method, tool };
}

/** Requisição web padrão para o SDK, sem a credencial e sem corpo (o SDK recebe o valor já interpretado). */
function toWebRequest(req: Request, signal: AbortSignal): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://localhost${req.path}`, { method: "POST", headers, signal });
}
