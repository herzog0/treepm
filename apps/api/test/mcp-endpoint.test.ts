/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona corpos JSON-RPC */
import { Logger } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "./access-token-support.js";
import { TEST_CONFIG } from "./helpers.js";
import { BAD_ORIGIN, MODERN, SITE_ORIGIN, rpcBody, rpcHeaders, seedProject, useMcpHarness } from "./mcp-support.js";
import { OTHER_ORG, as } from "./world.js";

const h = useMcpHarness();
const errorOf = (res: { body: any }): string | undefined => res.body?.error?.code;

describe("descoberta e lista de ferramentas (revisão 2026-07-28)", () => {
  it("responde tools/list em JSON simples, com as cinco ferramentas só de leitura", async () => {
    const { token } = await h.issue("contributor");
    const res = await h.rpc(token, "PRIV", "tools/list");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const tools = res.body.result.tools as any[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_project_overview", "get_ticket", "get_work_queue", "list_tickets", "search_tickets"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBeFalsy();
      expect(tool.description).toMatch(/[a-z]/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema.type).toBe("object");
    }
  });

  it("responde server/discover com a revisão atual", async () => {
    const { token } = await h.issue("contributor");
    const res = await h.rpc(token, "PRIV", "server/discover");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(MODERN);
  });

  it("não abre canal de assinatura (subscriptions/listen): nada fica pendurado", async () => {
    const { token } = await h.issue("contributor");
    const res = await h.rpc(token, "PRIV", "subscriptions/listen", { notifications: { toolsListChanged: true } }).timeout(5000);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"] ?? "").not.toMatch(/event-stream/);
  });
});

describe("cada falha do token vira um código HTTP, sem dizer o motivo no 401", () => {
  const bearer = (res: { headers: Record<string, any> }) => res.headers["www-authenticate"];

  it("sem cabeçalho Authorization: 401 com WWW-Authenticate: Bearer", async () => {
    const res = await h.rpc(null, "PRIV", "tools/list");
    expect(res.status).toBe(401);
    expect(bearer(res)).toMatch(/^Bearer/);
    expect(errorOf(res)).toBe("unauthenticated");
  });

  it.each([
    ["esquema errado", "Basic dXNlcjpwYXNz"],
    ["sem valor", "Bearer"],
    ["lixo", "Bearer tpm_lixo"],
    ["token de outro formato", "Bearer sk-qualquer-coisa"],
    ["dois valores", "Bearer a b"],
  ])("cabeçalho malformado (%s): 401 com WWW-Authenticate", async (_name, value) => {
    const res = await h.post(null, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), authorization: value });
    expect(res.status).toBe(401);
    expect(bearer(res)).toMatch(/^Bearer/);
  });

  it("token bem formado mas desconhecido, revogado ou vencido: o mesmo 401, com o mesmo corpo", async () => {
    const { token, id } = await h.issue("contributor");
    const unknown = (await h.rpc(token.slice(0, -2) + "AA", "PRIV", "tools/list")) as any;
    expect(unknown.status).toBe(401);
    expect(bearer(unknown)).toMatch(/^Bearer/);
    await h.call("DELETE", `/api/access-tokens/${id}`, as("contributor"));
    const revoked = await h.rpc(token, "PRIV", "tools/list");
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual(unknown.body);
    const second = await h.issue("contributor");
    h.clock.advance(91 * 24 * 60 * MINUTE);
    const expired = await h.rpc(second.token, "PRIV", "tools/list");
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(unknown.body);
    expect(JSON.stringify(expired.body)).not.toMatch(/revog|venc|expir|revoked/i);
  });

  it("chave da organização desligada: 403", async () => {
    const { token } = await h.issue("contributor");
    await h.enableMcp("org_A", false);
    const res = await h.rpc(token, "PRIV", "tools/list");
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe("forbidden");
  });

  it("projeto do endereço que não é o do token, ou que não existe: 404", async () => {
    const { token } = await h.issue("contributor");
    expect((await h.rpc(token, "OPEN", "tools/list")).status).toBe(404);
    expect((await h.rpc(token, "NADA", "tools/list")).status).toBe(404);
    expect((await h.rpc(token, "priv", "tools/list")).status).toBe(404);
    expect(errorOf(await h.rpc(token, "OPEN", "tools/list"))).toBe("not_found");
  });

  it("mais de 60 requisições por minuto no token: 429 com Retry-After", async () => {
    const { token } = await h.issue("contributor");
    // O limite por IP é maior (120): não interfere nas 61 requisições.
    for (let i = 0; i < 60; i++) expect((await h.rpc(token, "PRIV", "tools/list")).status).toBe(200);
    const res = await h.rpc(token, "PRIV", "tools/list");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(errorOf(res)).toBe("rate_limited");
  });

  it("o token na URL não autentica (nem ?token=, nem ?access_token=, nem no caminho)", async () => {
    const { token } = await h.issue("contributor");
    const body = rpcBody("tools/list");
    const headers = rpcHeaders("tools/list");
    for (const url of [`/api/mcp/PRIV?token=${token}`, `/api/mcp/PRIV?access_token=${token}`, `/api/mcp/PRIV?Authorization=Bearer%20${token}`]) {
      let req = request(h.app().getHttpServer()).post(url);
      for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
      const res = await req.send(body);
      expect(res.status).toBe(401);
      expect(bearer(res)).toMatch(/^Bearer/);
    }
    const inPath = await request(h.app().getHttpServer()).post(`/api/mcp/PRIV/${token}`).set(headers).send(body);
    expect(inPath.status).toBe(404);
    expect((await request(h.app().getHttpServer()).post("/api/mcp").send({})).status).toBe(404);
    expect(JSON.stringify(inPath.body)).not.toContain(token);
  });

  it("a sessão do Clerk não substitui o token: é a única autenticação aceita aqui", async () => {
    await h.issue("contributor");
    const res = await h.post(null, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), "x-test-session": as("admin") });
    expect(res.status).toBe(401);
  });
});

describe("Origin, métodos, tamanho do corpo e limite por IP", () => {
  it("Origin de outro site: 403, mesmo com token válido e antes de olhar o token", async () => {
    const { token } = await h.issue("contributor");
    const withToken = await h.post(token, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin: BAD_ORIGIN });
    expect(withToken.status).toBe(403);
    expect(errorOf(withToken)).toBe("forbidden");
    const withoutToken = await h.post(null, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin: BAD_ORIGIN });
    expect(withoutToken.status).toBe(403);
    expect(withoutToken.headers["www-authenticate"]).toBeUndefined();
  });

  it("Origin do próprio site e ausência de Origin passam", async () => {
    const { token } = await h.issue("contributor");
    expect((await h.post(token, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin: SITE_ORIGIN })).status).toBe(200);
    expect((await h.rpc(token, "PRIV", "tools/list")).status).toBe(200);
  });

  it("GET e DELETE: 405 com Allow: POST, com ou sem token", async () => {
    const { token } = await h.issue("contributor");
    for (const verb of ["get", "delete"] as const) {
      for (const auth of [undefined, `Bearer ${token}`]) {
        let req = request(h.app().getHttpServer())[verb]("/api/mcp/PRIV");
        if (auth) req = req.set("authorization", auth);
        const res = await req;
        expect(res.status).toBe(405);
        expect(res.headers["allow"]).toBe("POST");
      }
    }
  });

  it("corpo com mais de 64 KB: 413, antes de olhar o token", async () => {
    const { token } = await h.issue("contributor");
    const big = { ...rpcBody("tools/call", { name: "search_tickets", arguments: { query: "x".repeat(70 * 1024) } }) };
    const withToken = await h.post(token, "PRIV", big, rpcHeaders("tools/call", { name: "search_tickets" }));
    expect(withToken.status).toBe(413);
    const withoutToken = await h.post(null, "PRIV", big, rpcHeaders("tools/call", { name: "search_tickets" }));
    expect(withoutToken.status).toBe(413);
    // Logo abaixo do teto ainda é lido (a ferramenta recusa a entrada, mas a requisição chega).
    const near = rpcBody("tools/call", { name: "search_tickets", arguments: { query: "x".repeat(60 * 1024) } });
    expect((await h.post(token, "PRIV", near, rpcHeaders("tools/call", { name: "search_tickets" }))).status).toBe(200);
  });

  it("mais de 120 requisições por minuto no mesmo IP: 429 com Retry-After, até para quem não tem token", async () => {
    for (let i = 0; i < 120; i++) expect((await h.rpc(null, "PRIV", "tools/list")).status).toBe(401);
    const res = await h.rpc(null, "PRIV", "tools/list");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    // O limite vem antes de tudo: nem o Origin errado é visto.
    const evil = await h.post(null, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin: BAD_ORIGIN });
    expect(evil.status).toBe(429);
    h.clock.advance(MINUTE + 1);
    expect((await h.rpc(null, "PRIV", "tools/list")).status).toBe(401);
  });
});

describe("isolamento", () => {
  it("o token de uma organização nunca lê a outra, mesmo com a mesma chave de projeto", async () => {
    await seedProject(h.pool, h.world().projects.priv, h.world().people.manager, h.world().people.contributor);
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,1,'SEGREDO-DE-B',$3)",
      [OTHER_ORG, h.world().other.project, h.world().other.person],
    );
    await h.pool.query("update projects set next_ticket_number = 2 where id = $1", [h.world().other.project]);
    const a = await h.issue("contributor");
    const b = await h.issueOther();
    const fromA = await h.tool(a.token, "PRIV", "list_tickets");
    expect(fromA.text).toContain("Raiz do projeto");
    expect(fromA.text).not.toContain("SEGREDO-DE-B");
    const fromB = await h.tool(b.token, "PRIV", "list_tickets");
    expect(fromB.text).toContain("SEGREDO-DE-B");
    expect(fromB.text).not.toContain("Raiz do projeto");
    // O token de B em um projeto que só existe em A: 404.
    expect((await h.rpc(b.token, "OPEN", "tools/list")).status).toBe(404);
  });

  it("o token de um projeto nunca lê outro projeto da mesma organização", async () => {
    await seedProject(h.pool, h.world().projects.priv, h.world().people.manager, h.world().people.contributor);
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,1,'SEGREDO-DO-ABERTO',$3)", [
      "org_A",
      h.world().projects.org,
      h.world().people.admin,
    ]);
    const { token } = await h.issue("contributor");
    expect((await h.rpc(token, "OPEN", "tools/list")).status).toBe(404);
    const own = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(own.isError).toBe(false);
    const foreign = await h.tool(token, "PRIV", "get_ticket", { key: "OPEN-1" });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).not.toContain("SEGREDO-DO-ABERTO");
    const search = await h.tool(token, "PRIV", "search_tickets", { query: "SEGREDO-DO-ABERTO" });
    expect(search.json?.["tickets"]).toEqual([]);
  });
});

describe("nada é gravado além de last_used_at", () => {
  it("uma sequência de chamadas não muda tickets, ligações, atividade, pessoas nem tokens (fora o último uso)", async () => {
    await seedProject(h.pool, h.world().projects.priv, h.world().people.manager, h.world().people.contributor);
    const { token } = await h.issue("contributor");
    const dump = async (): Promise<Record<string, unknown>> => ({
      tickets: await h.rows("select * from tickets order by org_id, id"),
      relations: await h.rows("select * from ticket_relations order by org_id, id"),
      assignees: await h.rows("select * from ticket_assignees order by org_id, ticket_id, person_id"),
      activity: await h.rows("select * from activity_events order by org_id, id"),
      people: await h.rows("select * from people order by org_id, id"),
      projects: await h.rows("select * from projects order by org_id, id"),
      organizations: await h.rows("select * from organizations order by org_id"),
      tokens: await h.rows("select id, org_id, person_id, project_id, name, token_prefix, token_hash, expires_at, revoked_at, created_at from access_tokens order by id"),
    });
    const before = await dump();
    await h.rpc(token, "PRIV", "tools/list");
    for (const [name, args] of [
      ["search_tickets", { query: "filho" }],
      ["get_ticket", { key: "PRIV-1" }],
      ["list_tickets", {}],
      ["get_project_overview", {}],
      ["get_ticket", { key: "PRIV-999" }],
    ] as const) {
      await h.tool(token, "PRIV", name, args);
    }
    expect(await dump()).toEqual(before);
    const used = await h.rows("select last_used_at from access_tokens");
    expect(used[0]?.["last_used_at"]).not.toBeNull();
  });
});

describe("log", () => {
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
  });

  it("leva o id do token, o método, a ferramenta, o tempo e o tamanho; nunca o token, o cabeçalho, os argumentos nem os resultados", async () => {
    await seedProject(h.pool, h.world().projects.priv, h.world().people.manager, h.world().people.contributor);
    await h.pool.query("update tickets set title = 'TITULO-QUE-NAO-PODE-NO-LOG' where project_id = $1 and number = 4", [h.world().projects.priv]);
    const { token, id } = await h.issue("contributor");
    const secret = token.split("_").at(-1) ?? "";
    await h.tool(token, "PRIV", "search_tickets", { query: "ARGUMENTO-QUE-NAO-PODE-NO-LOG" });
    await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" });
    await h.rpc(token, "PRIV", "tools/list");
    await h.rpc("tpm_invalido", "PRIV", "tools/list");
    const log = captured.join("\n");
    expect(log).toContain(id);
    expect(log).toContain("tools/call");
    expect(log).toContain("search_tickets");
    expect(log).toContain("get_ticket");
    expect(log).toContain("tools/list");
    expect(log).toMatch(/\d+ ?ms/);
    expect(log).toMatch(/\d+ ?(bytes|B)\b/);
    expect(log).not.toContain(token);
    expect(log).not.toContain(secret);
    expect(log.toLowerCase()).not.toContain("bearer");
    expect(log).not.toContain("authorization");
    expect(log).not.toContain("ARGUMENTO-QUE-NAO-PODE-NO-LOG");
    expect(log).not.toContain("TITULO-QUE-NAO-PODE-NO-LOG");
  });
});

describe("Origin com APP_EXTRA_ORIGINS", () => {
  const EXTRA_ORIGIN = "https://dev.tailnet.ts.net";
  const x = useMcpHarness({ ...TEST_CONFIG, APP_EXTRA_ORIGINS: [EXTRA_ORIGIN] });

  it("aceita a principal e a extra; recusa a não listada (403, antes do token)", async () => {
    const h = x;
    const { token } = await h.issue("contributor");
    for (const origin of [SITE_ORIGIN, EXTRA_ORIGIN]) {
      expect((await h.post(token, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin })).status).toBe(200);
    }
    const bad = await h.post(null, "PRIV", rpcBody("tools/list"), { ...rpcHeaders("tools/list"), origin: BAD_ORIGIN });
    expect(bad.status).toBe(403);
  });
});
