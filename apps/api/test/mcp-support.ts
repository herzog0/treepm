/* eslint-disable @typescript-eslint/no-explicit-any -- corpos JSON-RPC */
import type pg from "pg";
import request from "supertest";
import { beforeEach } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { INestApplication } from "@nestjs/common";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { McpGateway } from "../src/mcp/mcp-gateway.js";
import { useTokenHarness } from "./access-token-support.js";
import type { TokenHarness } from "./access-token-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

/**
 * Tetos pequenos para os testes que provam o bloqueio: os de produção são 5000 por minuto, e chegar a eles chamada a chamada
 * deixaria a suíte lenta. `resetMemory` (no `beforeEach` dos harnesses) volta aos de produção.
 */
export const SMALL_LIMITS = { ip: 120, write: 20, person: 40, token: 60 } as const;
export function useSmallLimits(app: INestApplication): void {
  app.get(McpGateway).setLimits({ ip: SMALL_LIMITS.ip, write: SMALL_LIMITS.write, person: SMALL_LIMITS.person });
  app.get(AccessTokenService).setRateLimit(SMALL_LIMITS.token);
}

/** Revisão atual do protocolo (a que o SDK 2.x serve sem sessão). */
export const MODERN = "2026-07-28";
export const BAD_ORIGIN = "https://evil.example";
export const SITE_ORIGIN = "http://localhost:5173";

export type McpHarness = TokenHarness & {
  /** Liga a chave, cria um token pela API e devolve o token inteiro e o id. */
  issue: (who: Who, project?: "priv" | "org") => Promise<{ token: string; id: string }>;
  /** Token do projeto PRIV da organização B (criado como o administrador de lá). */
  issueOther: () => Promise<{ token: string; id: string }>;
  /** POST ao endereço, com o token em `Authorization: Bearer` (ou sem cabeçalho, se `token` for nulo). */
  post: (token: string | null, projectKey: string, body: unknown, headers?: Record<string, string>) => request.Test;
  /** Uma chamada JSON-RPC da revisão atual (cabeçalhos de metadados e envelope `_meta`). */
  rpc: (token: string | null, projectKey: string, method: string, params?: Record<string, unknown>, id?: number) => request.Test;
  /** `tools/call` da revisão atual. */
  tool: (token: string, projectKey: string, name: string, args?: Record<string, unknown>) => Promise<ToolResponse>;
  rows: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

export type ToolResponse = {
  status: number;
  text: string;
  isError: boolean;
  /** `structuredContent`, quando houve. */
  data: Record<string, any> | undefined;
  /** O texto interpretado como JSON (quando é JSON). */
  json: Record<string, any> | undefined;
  raw: Record<string, any>;
};

export const envelope = (): Record<string, unknown> => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "teste", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

export function rpcBody(method: string, params: Record<string, unknown> = {}, id = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope() } };
}

export function rpcHeaders(method: string, params: Record<string, unknown> = {}): Record<string, string> {
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

export function useMcpHarness(config?: AppConfig): McpHarness {
  const h = useTokenHarness(config);
  beforeEach(() => {
    h.app().get(McpGateway).resetMemory();
  });

  const post: McpHarness["post"] = (token, key, body, headers = {}) => {
    let req = request(h.app().getHttpServer()).post(`/api/mcp/${key}`).set("accept", "application/json, text/event-stream");
    if (token !== null) req = req.set("authorization", `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return req.send(body as object);
  };
  const rpc: McpHarness["rpc"] = (token, key, method, params = {}, id = 1) =>
    post(token, key, rpcBody(method, params, id), rpcHeaders(method, params));
  const tool: McpHarness["tool"] = async (token, key, name, args = {}) => {
    const res = await rpc(token, key, "tools/call", { name, arguments: args });
    const result = (res.body?.result ?? {}) as Record<string, any>;
    const content = Array.isArray(result["content"]) ? (result["content"] as { text?: string }[]) : [];
    const text = content[0]?.text ?? "";
    let json: Record<string, any> | undefined;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, isError: result["isError"] === true, data: result["structuredContent"], json, raw: res.body as Record<string, any> };
  };
  const rows = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await h.pool.query(sql, params)).rows;

  const issue: McpHarness["issue"] = async (who, project = "priv") => {
    await h.enableMcp();
    const res = await h.create(who, h.world().projects[project]);
    if (res.status !== 201) throw new Error(`token não criado: ${res.status}`);
    return { token: res.body.token as string, id: res.body.id as string };
  };
  const issueOther: McpHarness["issueOther"] = async () => {
    await h.enableMcp(OTHER_ORG);
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'manager')", [OTHER_ORG, h.world().other.project, h.world().other.person]);
    const res = await h.call("POST", "/api/access-tokens", as("outsider", OTHER_ORG), { projectId: h.world().other.project, name: "De B", expiresInDays: 90 });
    if (res.status !== 201) throw new Error(`token de B não criado: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.token as string, id: res.body.id as string };
  };
  return { ...h, issue, issueOther, post, rpc, tool, rows };
}

/** Semeia tickets do PRIV: 1 Raiz (filhos 2 e 3), 4 Solto, com ligações e responsáveis com nome e e-mail reconhecíveis. */
export async function seedProject(pool: pg.Pool, projectId: string, createdBy: string, assignee: string): Promise<void> {
  const add = async (number: number, title: string, description: string, parent: number | null, status = "todo"): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, status, created_by_person_id) values ($1,$2,$3,(select id from tickets where project_id = $2 and number = $4),$5,$6,$7,$8) returning id",
      [ORG, projectId, number, parent, title, description, status, createdBy],
    );
    return r.rows[0]?.id ?? "";
  };
  const root = await add(1, "Raiz do projeto", "Descrição inteira da raiz. Ver PRIV-4.", null, "in_progress");
  const a = await add(2, "Filho A", "Primeiro filho", 1, "done");
  await add(3, "Filho B", "Segundo filho sobre relatórios", 1, "todo");
  const solto = await add(4, "Solto", "Depende de PRIV-2", null, "todo");
  await pool.query("update projects set next_ticket_number = 5 where id = $1", [projectId]);
  const rel = (from: string, to: string, kind: string) =>
    pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1,$2,$3,$4,$5)", [ORG, projectId, from, to, kind]);
  await rel(solto, a, "depends_on");
  await rel(root, solto, "mentions");
  for (const ticket of [root, solto]) {
    await pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ($1,$2,$3)", [ORG, ticket, assignee]);
  }
}
