import type { AddressInfo } from "node:net";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildToken } from "../src/access-tokens/token.js";
import { TenantTransactions } from "../src/db/tenant-transactions.js";
import { McpGateway, sanitizeForLog } from "../src/mcp/mcp-gateway.js";
import { ProjectQueryService } from "../src/query/project-query.service.js";
import { MODERN, envelope, rpcBody, rpcHeaders, seedProject, useMcpHarness } from "./mcp-support.js";

const h = useMcpHarness();
const priv = () => h.world().projects.priv;

async function raw(token: string | null, body: string | Uint8Array, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const app = h.app();
  const server = app.getHttpServer();
  if (!server.listening) await app.listen(0, "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp/PRIV`, {
    method: "POST",
    body: body as BodyInit,
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, text: await res.text() };
}

const captured: string[] = [];
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  captured.length = 0;
  const grab = (...args: unknown[]): void => {
    captured.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    spies.push(vi.spyOn(Logger.prototype, method).mockImplementation(grab));
    spies.push(vi.spyOn(Logger, method).mockImplementation(grab));
  }
  for (const method of ["log", "warn", "error", "info", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(grab));
});
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
  h.app().get(McpGateway).timeoutMs = 30_000;
});

describe("1. só um objeto JSON vira mensagem (nada de lote)", () => {
  it.each([["array de chamadas"], ["array vazio"], ["número"], ["texto"], ["null"]])("%s: 400, sem buscar nada", async (name) => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    const { token } = await h.issue("contributor");
    const call = rpcBody("tools/call", { name: "search_tickets", arguments: { query: "filho" } });
    const bodies: Record<string, unknown> = {
      "array de chamadas": Array.from({ length: 100 }, (_, i) => ({ ...call, id: i + 1 })),
      "array vazio": [],
      número: 5,
      texto: "oi",
      null: null,
    };
    const search = vi.spyOn(ProjectQueryService.prototype, "search");
    const res = await raw(token, JSON.stringify(bodies[name]), rpcHeaders("tools/call", { name: "search_tickets" }));
    expect(res.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
    search.mockRestore();
  });

  it("um objeto de uma mensagem continua funcionando", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    const { token } = await h.issue("contributor");
    expect((await h.tool(token, "PRIV", "list_tickets")).isError).toBe(false);
  });
});

describe("2. um parse só, BOM e prazo", () => {
  it("BOM + subscriptions/listen é recusado como sem BOM (nada fica pendurado)", async () => {
    const { token } = await h.issue("contributor");
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(rpcBody("subscriptions/listen", { notifications: { toolsListChanged: true } })))]);
    const res = await raw(token, body, rpcHeaders("subscriptions/listen"));
    expect(res.status).toBe(404);
  });

  it("BOM + mensagem comum é lido (o BOM é tirado para os dois lados)", async () => {
    const { token } = await h.issue("contributor");
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(rpcBody("tools/list")))]);
    expect((await raw(token, body, rpcHeaders("tools/list"))).status).toBe(200);
  });

  it("UTF-8 inválido: 400", async () => {
    const { token } = await h.issue("contributor");
    expect((await raw(token, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), rpcHeaders("tools/list"))).status).toBe(400);
  });

  it("passou de 30 s (aqui 300 ms): 504 e a requisição termina", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    const { token } = await h.issue("contributor");
    h.app().get(McpGateway).timeoutMs = 300;
    const search = vi.spyOn(ProjectQueryService.prototype, "search").mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const res = await raw(token, JSON.stringify(rpcBody("tools/call", { name: "search_tickets", arguments: { query: "filho" } })), rpcHeaders("tools/call", { name: "search_tickets" }));
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5000);
    search.mockRestore();
  });
});

describe("3. no máximo 4 resoluções de token ao mesmo tempo, fila de 16", () => {
  it("30 requisições simultâneas com tokens bem formados e inexistentes nunca passam de 4 transações; o excesso leva 503 com Retry-After", async () => {
    const tenants = h.app().get(TenantTransactions, { strict: false });
    const original = tenants.run.bind(tenants);
    let open = 0;
    let peak = 0;
    const spy = vi.spyOn(tenants, "run").mockImplementation(async (context, fn) => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 80));
      try {
        return await original(context, fn);
      } finally {
        open -= 1;
      }
    });
    const fake = () => buildToken("org_A").token;
    const results = await Promise.all(Array.from({ length: 30 }, () => h.post(fake(), "PRIV", rpcBody("tools/list"), rpcHeaders("tools/list")).then((r) => ({ status: r.status, retry: r.headers["retry-after"] }))));
    spy.mockRestore();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
    const unavailable = results.filter((r) => r.status === 503);
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    for (const r of unavailable) expect(Number(r.retry)).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === 401).length + unavailable.length).toBe(30);
  });

  it("token malformado é recusado sem entrar na fila (nem abre transação)", async () => {
    const tenants = h.app().get(TenantTransactions, { strict: false });
    const spy = vi.spyOn(tenants, "run");
    const results = await Promise.all(Array.from({ length: 30 }, () => h.post("tpm_lixo", "PRIV", rpcBody("tools/list"), rpcHeaders("tools/list"))));
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("4. 413 responde e registra a linha de log", () => {
  it("não lança depois de responder e gera a linha com status=413", async () => {
    const big = rpcBody("tools/call", { name: "search_tickets", arguments: { query: "x".repeat(70 * 1024) } });
    const res = await h.post(null, "PRIV", big, rpcHeaders("tools/call", { name: "search_tickets" }));
    expect(res.status).toBe(413);
    expect(res.headers["connection"]).toBe("close");
    const log = captured.join("\n");
    expect(log).toMatch(/status=413/);
    expect(log).not.toMatch(/ERR_HTTP_HEADERS_SENT|Cannot set headers/);
  });
});

describe("5. log sem injeção de linha", () => {
  it("sanitizeForLog tira controles e corta em 200", () => {
    // eslint-disable-next-line no-control-regex -- é o que o teste procura
    expect(sanitizeForLog("a\r\nFORGED\u0000b\u2028c")).not.toMatch(/[\r\n\u0000\u2028]/);
    expect(sanitizeForLog("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it("um valor com quebra de linha vindo do cliente não forja linha no log", async () => {
    const { token } = await h.issue("contributor");
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...envelope(), "io.modelcontextprotocol/protocolVersion": "2026-07-28\nINFO [Mcp] token=forjado status=200" } } };
    await h.post(token, "PRIV", body, rpcHeaders("tools/list"));
    for (const line of captured) expect(line).not.toMatch(/[\r\n]/);
  });
});

describe("6. erros internos no log: só a classe", () => {
  it("falha de ferramenta registra a classe, não a mensagem", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    const { token } = await h.issue("contributor");
    const search = vi.spyOn(ProjectQueryService.prototype, "search").mockRejectedValue(new TypeError("SEGREDO-DA-CONSULTA arg=filho"));
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "filho" });
    search.mockRestore();
    expect(res.isError).toBe(true);
    const log = captured.join("\n");
    expect(log).toContain("TypeError");
    expect(log).not.toContain("SEGREDO-DA-CONSULTA");
  });
});

describe("7 e 8. entrada inválida sempre devolve frase de entrada inválida, curta (prova da troca de createToolError)", () => {
  it("chave desconhecida com texto não ASCII", async () => {
    const { token } = await h.issue("contributor");
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "a", "çãé": 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/invalid/i);
    expect(res.text).not.toMatch(/something went wrong|try again/i);
    expect(res.text).toMatch(/^[\x20-\x7e]+$/);
  });

  it("mensagem longa do SDK é encurtada (falha se a troca não for aplicada)", async () => {
    const { token } = await h.issue("contributor");
    const res = await h.tool(token, "PRIV", "search_tickets", { query: "a", ["k".repeat(600)]: 1 });
    expect(res.isError).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(200);
    expect(res.text).not.toContain("\n");
  });
});

describe("9. dois tokens de projetos diferentes em paralelo", () => {
  it("cada um só vê o seu", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,1,'SO-DO-ABERTO',$2)", [h.world().projects.org, h.world().people.admin]);
    const a = await h.issue("contributor");
    const b = await h.issue("admin", "org");
    const jobs = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? h.tool(a.token, "PRIV", "list_tickets") : h.tool(b.token, "OPEN", "list_tickets")));
    const out = await Promise.all(jobs);
    out.forEach((res, i) => {
      if (i % 2 === 0) {
        expect(res.text).toContain("Raiz do projeto");
        expect(res.text).not.toContain("SO-DO-ABERTO");
      } else {
        expect(res.text).toContain("SO-DO-ABERTO");
        expect(res.text).not.toContain("Raiz do projeto");
      }
    });
    expect(MODERN).toBeTruthy();
  });
});
