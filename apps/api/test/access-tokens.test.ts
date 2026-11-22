import { describe, expect, it } from "vitest";
import { parseToken, hashToken } from "../src/access-tokens/token.js";
import { DAY, useTokenHarness } from "./access-token-support.js";
import { OTHER_ORG, as } from "./world.js";

const h = useTokenHarness();

type Row = Record<string, unknown>;

async function dbRows(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await h.pool.query(sql, params)).rows as Row[];
}

describe("PATCH /api/organization (chave do MCP)", () => {
  it("nasce desligada e o /api/me informa mcp.enabled", async () => {
    const me = await h.call("GET", "/api/me", as("plain"));
    expect(me.status).toBe(200);
    expect(me.body.mcp).toEqual({ enabled: false });
  });

  it("só o administrador da organização liga e desliga; devolve o estado", async () => {
    const on = await h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ mcp: { enabled: true } });
    expect((await h.call("GET", "/api/me", as("plain"))).body.mcp).toEqual({ enabled: true });
    const off = await h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: false });
    expect(off.body).toEqual({ mcp: { enabled: false } });
  });

  it.each(["teamAdmin", "manager", "contributor", "reader", "plain"] as const)("%s recebe 403", async (who) => {
    const res = await h.call("PATCH", "/api/organization", as(who), { mcpEnabled: true });
    expect(res.status).toBe(403);
    expect((await dbRows("select mcp_enabled from organizations where org_id = 'org_A'"))[0]).toEqual({ mcp_enabled: false });
  });

  it("recusa corpo inválido e campos extras com 400, e não mexe na outra organização", async () => {
    for (const body of [{}, { mcpEnabled: "sim" }, { mcpEnabled: true, extra: 1 }]) {
      expect((await h.call("PATCH", "/api/organization", as("admin"), body)).status).toBe(400);
    }
    await h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: true });
    expect((await dbRows("select mcp_enabled from organizations where org_id = $1", [OTHER_ORG]))[0]).toEqual({ mcp_enabled: false });
  });

  it("grava evento de atividade da mudança", async () => {
    await h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: true });
    const events = await dbRows("select kind, subject_type, payload from activity_events where kind like 'organization.mcp%'");
    expect(events).toEqual([{ kind: "organization.mcp_changed", subject_type: "organization", payload: { enabled: true } }]);
  });
});

describe("POST /api/access-tokens", () => {
  it("com a chave desligada: 403 com código próprio", async () => {
    const res = await h.create("contributor", h.world().projects.priv);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("mcp_disabled");
    expect(await dbRows("select 1 from access_tokens")).toHaveLength(0);
  });

  it("cria, devolve o token inteiro uma única vez e guarda só o resumo e o começo", async () => {
    await h.enableMcp();
    const res = await h.create("contributor", h.world().projects.priv, { name: "Notebook", expiresInDays: 30 });
    expect(res.status).toBe(201);
    const { token, ...data } = res.body as { token: string } & Row;
    expect(Object.keys(data).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "project", "revokedAt", "tokenPrefix"].sort(),
    );
    expect(data).toMatchObject({ name: "Notebook", project: { id: h.world().projects.priv, key: "PRIV" }, lastUsedAt: null, revokedAt: null });
    const parsed = parseToken(token);
    expect(parsed?.orgId).toBe("org_A");
    expect(data["tokenPrefix"]).toBe(parsed?.secret.slice(0, 8));
    const days = (Date.parse(data["expiresAt"] as string) - Date.parse(data["createdAt"] as string)) / DAY;
    expect(days).toBeCloseTo(30, 3);

    const rows = await dbRows("select * from access_tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_hash: hashToken(token), token_prefix: parsed?.secret.slice(0, 8), name: "Notebook" });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(parsed?.secret);
  });

  it("validade padrão de 90 dias; aceita 30, 90 e 365 e recusa outros valores", async () => {
    await h.enableMcp();
    const noDays = await h.call("POST", "/api/access-tokens", as("contributor"), { projectId: h.world().projects.priv, name: "x" });
    expect(noDays.status).toBe(201);
    const span = (r: { body: Row }) => (Date.parse(r.body["expiresAt"] as string) - Date.parse(r.body["createdAt"] as string)) / DAY;
    expect(span(noDays)).toBeCloseTo(90, 3);
    expect(span(await h.create("contributor", h.world().projects.priv, { expiresInDays: 365 }))).toBeCloseTo(365, 3);
    for (const bad of [0, 7, 91, -30, "90", 30.5, null]) {
      expect((await h.create("contributor", h.world().projects.priv, { expiresInDays: bad })).status, String(bad)).toBe(400);
    }
  });

  it("valida nome (1 a 80 caracteres), projeto e campos extras", async () => {
    await h.enableMcp();
    const p = h.world().projects.priv;
    expect((await h.create("contributor", p, { name: "" })).status).toBe(400);
    expect((await h.create("contributor", p, { name: "   " })).status).toBe(400);
    expect((await h.create("contributor", p, { name: "x".repeat(81) })).status).toBe(400);
    expect((await h.create("contributor", p, { name: "x".repeat(80) })).status).toBe(201);
    expect((await h.create("contributor", p, { projectId: "nao-e-uuid" })).status).toBe(400);
    expect((await h.create("contributor", p, { extra: true })).status).toBe(400);
    expect((await h.call("POST", "/api/access-tokens", as("contributor"), { name: "x" })).status).toBe(400);
  });

  it("404 para projeto que a pessoa não enxerga, inexistente ou de outra organização", async () => {
    await h.enableMcp();
    expect((await h.create("plain", h.world().projects.priv)).status).toBe(404);
    expect((await h.create("contributor", "00000000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await h.create("admin", h.world().other.project)).status).toBe(404);
    expect(await dbRows("select 1 from access_tokens")).toHaveLength(0);
  });

  it("projeto aberto da organização serve a qualquer membro; administrador enxerga o privado", async () => {
    await h.enableMcp();
    expect((await h.create("plain", h.world().projects.org)).status).toBe(201);
    expect((await h.create("admin", h.world().projects.priv)).status).toBe(201);
  });

  it("limite: o décimo primeiro token ativo é recusado com 409; revogados e vencidos não contam", async () => {
    await h.enableMcp();
    const p = h.world().projects.priv;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await h.create("contributor", p, { name: `t${i}` })).body.id as string);
    const eleventh = await h.create("contributor", p);
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe("access_token_limit");
    // Outra pessoa tem a própria cota.
    expect((await h.create("manager", p)).status).toBe(201);
    // Revogar abre uma vaga.
    expect((await h.call("DELETE", `/api/access-tokens/${ids[0]}`, as("contributor"))).status).toBe(204);
    expect((await h.create("contributor", p)).status).toBe(201);
    // Vencer abre outra.
    expect((await h.create("contributor", p)).status).toBe(409);
    await h.pool.query("update access_tokens set expires_at = now() - interval '1 day' where id = $1", [ids[1]]);
    expect((await h.create("contributor", p)).status).toBe(201);
  });

  it("criações simultâneas não furam o limite", async () => {
    await h.enableMcp();
    const p = h.world().projects.priv;
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => h.create("contributor", p, { name: `c${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await dbRows("select 1 from access_tokens")).toHaveLength(10);
  });

  it("grava evento de atividade sem o token nem o resumo", async () => {
    await h.enableMcp();
    const res = await h.create("contributor", h.world().projects.priv, { name: "Notebook" });
    const events = await dbRows("select kind, subject_type, subject_id, payload from activity_events where kind like 'access_token.%'");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "access_token.created", subject_type: "project", subject_id: h.world().projects.priv });
    expect(events[0]?.["payload"]).toEqual({ tokenId: res.body.id, name: "Notebook", projectKey: "PRIV", tokenPrefix: res.body.tokenPrefix });
    expect(JSON.stringify(events)).not.toContain(res.body.token);
    expect(JSON.stringify(events)).not.toContain(hashToken(res.body.token));
  });
});

describe("listagens", () => {
  it("GET /api/access-tokens lista só os próprios, sem token nem resumo", async () => {
    await h.enableMcp();
    const mine = await h.create("contributor", h.world().projects.priv, { name: "meu" });
    await h.create("manager", h.world().projects.priv, { name: "dele" });
    const res = await h.call("GET", "/api/access-tokens", as("contributor"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({
      id: mine.body.id,
      name: "meu",
      project: { id: h.world().projects.priv, key: "PRIV" },
      tokenPrefix: mine.body.tokenPrefix,
      createdAt: mine.body.createdAt,
      lastUsedAt: null,
      expiresAt: mine.body.expiresAt,
      revokedAt: null,
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(mine.body.token);
    expect(text).not.toContain(hashToken(mine.body.token));
    expect(text).not.toMatch(/"token"|hash/i);
  });

  it("a lista própria mostra também os revogados, com a data da revogação", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv);
    await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("contributor"));
    const res = await h.call("GET", "/api/access-tokens", as("contributor"));
    expect(res.body).toHaveLength(1);
    expect(typeof res.body[0].revokedAt).toBe("string");
  });

  it("GET /api/access-tokens/organization: só administrador; traz a pessoa; não traz outra organização", async () => {
    await h.enableMcp();
    await h.create("contributor", h.world().projects.priv, { name: "a" });
    await h.create("manager", h.world().projects.priv, { name: "b" });
    for (const who of ["teamAdmin", "manager", "contributor", "reader", "plain"] as const) {
      expect((await h.call("GET", "/api/access-tokens/organization", as(who))).status, who).toBe(403);
    }
    const res = await h.call("GET", "/api/access-tokens/organization", as("admin"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const people = (res.body as { person: { id: string; displayName: string } }[]).map((row) => row.person.id).sort();
    expect(people).toEqual([h.world().people.contributor, h.world().people.manager].sort());
    expect(res.body[0].person).toEqual({ id: expect.any(String), displayName: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/"token"|hash/i);

    await h.enableMcp(OTHER_ORG);
    const other = await h.call("GET", "/api/access-tokens/organization", as("admin", OTHER_ORG));
    expect(other.status).toBe(200);
    expect(other.body).toEqual([]);
  });
});

describe("DELETE /api/access-tokens/:id", () => {
  it("a pessoa revoga o próprio: marca revoked_at, não apaga, e grava evento", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv, { name: "Notebook" });
    const res = await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("contributor"));
    expect(res.status).toBe(204);
    const rows = await dbRows("select revoked_at from access_tokens where id = $1", [t.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["revoked_at"]).toBeInstanceOf(Date);
    const events = await dbRows("select payload from activity_events where kind = 'access_token.revoked'");
    expect(events).toEqual([{ payload: { tokenId: t.body.id, name: "Notebook", projectKey: "PRIV", tokenPrefix: t.body.tokenPrefix } }]);
  });

  it("outra pessoa (não administradora) recebe 404 e nada muda", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv);
    expect((await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("manager"))).status).toBe(404);
    expect((await dbRows("select revoked_at from access_tokens"))[0]).toEqual({ revoked_at: null });
  });

  it("o administrador revoga o de qualquer pessoa da organização, mas não o de outra organização", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv);
    expect((await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("admin"))).status).toBe(204);
    expect((await dbRows("select revoked_at from access_tokens"))[0]?.["revoked_at"]).toBeInstanceOf(Date);
    await h.enableMcp(OTHER_ORG);
    const foreign = await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("admin", OTHER_ORG));
    expect(foreign.status).toBe(404);
  });

  it("revogar de novo é sucesso sem efeito: mesma data e nenhum evento novo", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv);
    await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("contributor"));
    const first = (await dbRows("select revoked_at, updated_at from access_tokens"))[0];
    expect((await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("contributor"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("admin"))).status).toBe(204);
    expect((await dbRows("select revoked_at, updated_at from access_tokens"))[0]).toEqual(first);
    expect(await dbRows("select 1 from activity_events where kind = 'access_token.revoked'")).toHaveLength(1);
  });

  it("id inválido: 400; inexistente: 404", async () => {
    expect((await h.call("DELETE", "/api/access-tokens/abc", as("contributor"))).status).toBe(400);
    expect((await h.call("DELETE", "/api/access-tokens/00000000-0000-7000-8000-000000000000", as("contributor"))).status).toBe(404);
  });

  it("revogar funciona mesmo com a chave da organização desligada", async () => {
    await h.enableMcp();
    const t = await h.create("contributor", h.world().projects.priv);
    await h.enableMcp("org_A", false);
    expect((await h.call("DELETE", `/api/access-tokens/${t.body.id}`, as("contributor"))).status).toBe(204);
  });
});
