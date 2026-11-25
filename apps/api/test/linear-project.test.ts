import { withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { describe, expect, it } from "vitest";
import { PrincipalService } from "../src/access/principal.service.js";
import { PRISMA } from "../src/db/prisma.provider.js";
import type { TenantRunner } from "../src/db/own-transactions.js";
import { LinearService, linkConflict } from "../src/linear/linear.service.js";
import { KEY, KEY_B, TEAM_ENG, TEAM_OPS, WORKSPACE, linearWorld, useLinearHarness } from "./linear-support.js";
import type { LinearWorld } from "./linear-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await h.pool.query(sql, params)).rows as Row[];

const OTHER_WS = { id: "ws-2", name: "Beta", urlKey: "beta" };
const KEY_C = "lin_api_SEGREDO_C_3333cccc";
const world = (extra: LinearWorld = {}): void =>
  h.linear().use(linearWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] }, [KEY_B]: { workspace: OTHER_WS, teams: [TEAM_ENG] }, [KEY_C]: { workspace: WORKSPACE, teams: [TEAM_OPS] }, ...extra }));

const link = (who: Who, projectId: string, body: Record<string, unknown> = { teamId: TEAM_ENG.id, confirmTeamKey: "ENG" }) =>
  h.call("POST", `/api/projects/${projectId}/linear`, as(who), body);
const priv = () => h.world().projects.priv;
const open = () => h.world().projects.org;

/** Liga o projeto como administrador, com a chave KEY (conecta antes). */
async function linked(projectId = priv(), team = TEAM_ENG): Promise<void> {
  world();
  await put("admin");
  const res = await link("admin", projectId, { teamId: team.id, confirmTeamKey: team.key });
  expect(res.status).toBe(201);
}

describe("GET /api/linear/teams", () => {
  it("409 linear_not_connected sem credencial", async () => {
    const res = await h.call("GET", "/api/linear/teams", as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_connected");
  });

  it("lista os times que a chave enxerga agora, sem ligação", async () => {
    world();
    await put("admin");
    const res = await h.call("GET", "/api/linear/teams", as("admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { ...TEAM_ENG, linkedProject: null, linkedElsewhere: false, lastImportedAt: null },
      { ...TEAM_OPS, linkedProject: null, linkedElsewhere: false, lastImportedAt: null },
    ]);
  });

  it("mostra o projeto a que o time já está ligado, se a pessoa o enxerga; senão só linkedElsewhere, sem nome", async () => {
    await linked(priv());
    await put("plain", KEY); // não enxerga o projeto privado
    await put("contributor", KEY);
    const seen = await h.call("GET", "/api/linear/teams", as("contributor"));
    expect(seen.body[0]).toEqual({ ...TEAM_ENG, linkedProject: { id: priv(), name: "Privado" }, linkedElsewhere: false, lastImportedAt: null });
    const hidden = await h.call("GET", "/api/linear/teams", as("plain"));
    expect(hidden.body[0]).toEqual({ ...TEAM_ENG, linkedProject: null, linkedElsewhere: true, lastImportedAt: null });
    expect(JSON.stringify(hidden.body)).not.toContain("Privado");
    expect(hidden.body[1]).toEqual({ ...TEAM_OPS, linkedProject: null, linkedElsewhere: false, lastImportedAt: null });
  });

  it("não confunde o mesmo id de time em outro workspace", async () => {
    await linked(priv());
    world({ [KEY_B]: { workspace: OTHER_WS, teams: [TEAM_ENG] } });
    await put("admin", KEY_B);
    const res = await h.call("GET", "/api/linear/teams", as("admin"));
    expect(res.body).toEqual([{ ...TEAM_ENG, linkedProject: null, linkedElsewhere: false, lastImportedAt: null }]);
  });

  it("chave revogada no Linear: 422 linear_key_invalid; Linear fora do ar: 503", async () => {
    world();
    await put("admin");
    world({ [KEY]: "invalid" });
    expect((await h.call("GET", "/api/linear/teams", as("admin"))).body.error.code).toBe("linear_key_invalid");
    world({ [KEY]: "down" });
    expect((await h.call("GET", "/api/linear/teams", as("admin"))).status).toBe(503);
    world({ [KEY]: "rate" });
    const rate = await h.call("GET", "/api/linear/teams", as("admin"));
    expect(rate.status).toBe(429);
    expect(rate.body.error.details).toEqual({ retryAfterSeconds: 42 });
  });
});

describe("GET /api/projects/:projectId/linear", () => {
  it("projeto sem origem: source null, canLink só para quem administra, keyMatches null", async () => {
    world();
    const admin = await h.call("GET", `/api/projects/${priv()}/linear`, as("admin"));
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ source: null, canLink: true, keyMatches: null });
    expect((await h.call("GET", `/api/projects/${priv()}/linear`, as("manager"))).body.canLink).toBe(true);
    expect((await h.call("GET", `/api/projects/${priv()}/linear`, as("contributor"))).body).toEqual({ source: null, canLink: false, keyMatches: null });
    expect((await h.call("GET", `/api/projects/${open()}/linear`, as("manager"))).body.canLink).toBe(false);
  });

  it("projeto privado que a pessoa não enxerga, inexistente ou de outra organização: 404", async () => {
    expect((await h.call("GET", `/api/projects/${priv()}/linear`, as("plain"))).status).toBe(404);
    expect((await h.call("GET", "/api/projects/0190c0de-0000-7000-8000-0000000000aa/linear", as("admin"))).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${h.world().other.project}/linear`, as("admin"))).status).toBe(404);
    expect((await h.call("GET", "/api/projects/nao-e-uuid/linear", as("admin"))).status).toBe(400);
  });

  it("com origem: devolve workspace, time, quando e quem; keyMatches conforme a chave de quem lê", async () => {
    await linked(priv());
    const mine = await h.call("GET", `/api/projects/${priv()}/linear`, as("admin"));
    expect(mine.body).toMatchObject({
      source: { workspace: { id: "ws-1", name: "Acme" }, team: { id: "team-eng", key: "ENG", name: "Engenharia" }, linkedBy: { id: h.world().people.admin } },
      canLink: false,
      keyMatches: true,
    });
    expect(typeof mine.body.source.linkedAt).toBe("string");
    // sem chave: null
    expect((await h.call("GET", `/api/projects/${priv()}/linear`, as("contributor"))).body.keyMatches).toBeNull();
    // chave de outro workspace: false
    await put("reader", KEY_B);
    expect((await h.call("GET", `/api/projects/${priv()}/linear`, as("reader"))).body.keyMatches).toBe(false);
    // mesmo workspace: true, mesmo que a chave não enxergue o time (isso se confere na hora de operar) e mesmo com o Linear fora do ar
    await put("manager", KEY_C);
    world({ [KEY]: "down", [KEY_C]: "down" });
    h.linear().calls.length = 0;
    for (const who of ["manager", "admin"] as const) {
      const res = await h.call("GET", `/api/projects/${priv()}/linear`, as(who));
      expect(res.status).toBe(200);
      expect(res.body.keyMatches).toBe(true);
      expect(res.body.source).not.toBeNull();
    }
    // a leitura nunca chama o Linear
    expect(h.linear().calls).toHaveLength(0);
  });
});

describe("POST /api/projects/:projectId/linear", () => {
  it("quem administra liga: grava a origem, responde 201 e registra a atividade", async () => {
    world();
    await put("manager");
    const res = await link("manager", priv());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: { workspace: { id: "ws-1", name: "Acme" }, team: { id: "team-eng", key: "ENG", name: "Engenharia" }, linkedBy: { id: h.world().people.manager } }, canLink: false, keyMatches: true });
    expect(await rows("select project_id, provider, external_workspace_id, external_workspace_name, external_team_id, external_team_key, external_team_name, linked_by_person_id from project_external_sources")).toEqual([
      { project_id: priv(), provider: "linear", external_workspace_id: "ws-1", external_workspace_name: "Acme", external_team_id: "team-eng", external_team_key: "ENG", external_team_name: "Engenharia", linked_by_person_id: h.world().people.manager },
    ]);
    const events = await rows("select kind, subject_type, subject_id, actor_person_id, payload from activity_events where kind like 'project.linear%'");
    expect(events).toEqual([{ kind: "project.linear_linked", subject_type: "project", subject_id: priv(), actor_person_id: h.world().people.manager, payload: { provider: "linear", workspaceName: "Acme", teamKey: "ENG" } }]);
  });

  it("a confirmação aceita a chave do time sem diferenciar maiúsculas", async () => {
    world();
    await put("admin");
    expect((await link("admin", priv(), { teamId: TEAM_ENG.id, confirmTeamKey: "eNg" })).status).toBe(201);
  });

  it.each([["contributor", "priv"], ["reader", "priv"], ["teamAdmin", "open"], ["manager", "open"]] as const)("%s não administra o projeto %s: 403 e nada gravado", async (who, which) => {
    world();
    await put(who);
    const res = await link(who, which === "priv" ? priv() : open());
    expect(res.status).toBe(403);
    expect(await rows("select 1 from project_external_sources")).toHaveLength(0);
  });

  it("quem não enxerga o projeto privado recebe 404", async () => {
    world();
    await put("plain");
    expect((await link("plain", priv())).status).toBe(404);
  });

  it("sem credencial: 409 linear_not_connected", async () => {
    const res = await link("admin", priv());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_connected");
  });

  it("confirmação diferente da chave do time: 422 linear_confirmation_mismatch, nada gravado", async () => {
    world();
    await put("admin");
    for (const confirmTeamKey of ["OPS", "EN", "ENGX", "Engenharia"]) {
      const res = await link("admin", priv(), { teamId: TEAM_ENG.id, confirmTeamKey });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("linear_confirmation_mismatch");
    }
    expect(await rows("select 1 from project_external_sources")).toHaveLength(0);
  });

  it("time que a chave não enxerga ou inexistente: 404 linear_team_not_found", async () => {
    world();
    await put("admin", KEY_C); // só enxerga OPS
    const res = await link("admin", priv(), { teamId: TEAM_ENG.id, confirmTeamKey: "ENG" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("linear_team_not_found");
    expect((await link("admin", priv(), { teamId: "nao-existe", confirmTeamKey: "X" })).status).toBe(404);
  });

  it("confere no Linear na hora, com a chave de quem pede (sem Bearer)", async () => {
    world();
    await put("admin");
    h.linear().calls.length = 0;
    await link("admin", priv());
    expect(h.linear().calls.length).toBeGreaterThan(0);
    for (const call of h.linear().calls) expect(call.headers["authorization"]).toBe(KEY);
    // confere o time pelo id, sem listar todos (um workspace com mais de 500 times não dá recusa falsa)
    expect(h.linear().calls.some((call) => call.query.includes("team(id") && call.variables["id"] === TEAM_ENG.id)).toBe(true);
    expect(h.linear().calls.some((call) => call.query.includes("teams("))).toBe(false);
  });

  it("a gravação reconfere a credencial: removida ou trocada por chave de outro workspace durante a chamada → 409 linear_not_connected, nada gravado", async () => {
    for (const change of ["remove", "other-workspace"] as const) {
      world();
      await put("admin");
      h.linear().beforeReply = async (call) => {
        if (!call.query.includes("team(id")) return;
        if (change === "remove") await h.pool.query("delete from external_credentials");
        else await h.pool.query("update external_credentials set external_workspace_id = 'ws-2'");
      };
      const res = await link("admin", priv());
      expect(res.status, change).toBe(409);
      expect(res.body.error.code, change).toBe("linear_not_connected");
      expect(await rows("select 1 from project_external_sources"), change).toHaveLength(0);
      expect(await rows("select 1 from activity_events where kind like 'project.linear%'"), change).toHaveLength(0);
      h.linear().beforeReply = null;
      await h.pool.query("delete from external_credentials");
    }
  });

  it("projeto que já tem origem: 409 linear_already_linked, e a origem fica como estava", async () => {
    await linked(priv());
    const res = await link("admin", priv(), { teamId: TEAM_OPS.id, confirmTeamKey: "OPS" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_already_linked");
    expect(await rows("select external_team_id from project_external_sources")).toEqual([{ external_team_id: "team-eng" }]);
  });

  it("time já ligado a outro projeto da organização: 409 linear_team_in_use", async () => {
    await linked(priv());
    const res = await link("admin", open());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_team_in_use");
    expect(await rows("select 1 from project_external_sources")).toHaveLength(1);
  });

  it("corrida: dois pedidos ao mesmo tempo para o mesmo time em projetos diferentes — um entra, o outro recebe linear_team_in_use", async () => {
    world();
    await put("admin");
    const [a, b] = await Promise.all([link("admin", priv()), link("admin", open())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe("linear_team_in_use");
    expect(await rows("select 1 from project_external_sources")).toHaveLength(1);
  });

  it("corrida: dois pedidos para o mesmo projeto — um entra, o outro recebe linear_already_linked", async () => {
    world();
    await put("admin");
    const [a, b] = await Promise.all([link("admin", priv()), link("admin", priv(), { teamId: TEAM_OPS.id, confirmTeamKey: "OPS" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body.error.code).toBe("linear_already_linked");
  });

  it("o mesmo time em outra organização não conflita", async () => {
    world();
    await put("admin");
    await link("admin", priv());
    const outsider = as("admin", OTHER_ORG);
    await h.call("PUT", "/api/linear/connection", outsider, { apiKey: KEY });
    const res = await h.call("POST", `/api/projects/${h.world().other.project}/linear`, outsider, { teamId: TEAM_ENG.id, confirmTeamKey: "ENG" });
    expect(res.status).toBe(201);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    world();
    await put("admin");
    await h.pool.query("update projects set archived_at = now() where id = $1::uuid", [priv()]);
    const res = await link("admin", priv());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });

  it.each([{}, { teamId: TEAM_ENG.id }, { confirmTeamKey: "ENG" }, { teamId: "", confirmTeamKey: "ENG" }, { teamId: TEAM_ENG.id, confirmTeamKey: "" }, { teamId: 1, confirmTeamKey: "ENG" }, { teamId: TEAM_ENG.id, confirmTeamKey: "ENG", extra: true }])("corpo inválido %j: 400, sem chamar o Linear", async (body) => {
    world();
    await put("admin");
    h.linear().calls.length = 0;
    expect((await link("admin", priv(), body)).status).toBe(400);
    expect(h.linear().calls).toHaveLength(0);
  });

  it("chave revogada, limite e Linear fora do ar na hora de ligar: 422, 429 e 503, nada gravado", async () => {
    world();
    await put("admin");
    for (const [mode, status] of [["invalid", 422], ["rate", 429], ["down", 503]] as const) {
      world({ [KEY]: mode });
      expect((await link("admin", priv())).status).toBe(status);
    }
    expect(await rows("select 1 from project_external_sources")).toHaveLength(0);
  });
});

describe("o vínculo não muda nem se desfaz", () => {
  it.each(["PUT", "PATCH", "DELETE"])("%s /api/projects/:id/linear → 404 ou 405, e a origem fica", async (method) => {
    await linked(priv());
    const res = await h.call(method, `/api/projects/${priv()}/linear`, as("admin"), method === "DELETE" ? undefined : { teamId: TEAM_OPS.id, confirmTeamKey: "OPS" });
    expect([404, 405]).toContain(res.status);
    expect(await rows("select external_team_id from project_external_sources")).toEqual([{ external_team_id: "team-eng" }]);
  });

  it("remover a conexão da pessoa não mexe no vínculo", async () => {
    await linked(priv());
    await h.call("DELETE", "/api/linear/connection", as("admin"));
    expect(await rows("select 1 from project_external_sources")).toHaveLength(1);
    const res = await h.call("GET", `/api/projects/${priv()}/linear`, as("admin"));
    expect(res.body.source).not.toBeNull();
    expect(res.body.keyMatches).toBeNull();
  });
});

describe("requireLinearAccess (para a fatia 2)", () => {
  /** Um `TenantRunner` de teste que conta a profundidade: o Linear nunca pode ser chamado de dentro de `run`. */
  let depth = 0;
  let sawNetworkInsideTransaction = false;
  const access = async (who: Who, projectId: string) => {
    const app = h.app();
    const prisma = app.get<PrismaClient>(PRISMA);
    const session = { userId: `u_${who}`, orgId: ORG, orgRole: who === "admin" ? "org:admin" : "org:member", sessionStatus: "active" };
    const tenant = { orgId: ORG, userId: session.userId };
    const clerk = who === "admin" ? "admin" : "member";
    const principal = await withTenant(prisma, tenant, (tx) => app.get(PrincipalService).load(tx, session, clerk, null));
    const runner: TenantRunner = {
      run: (fn) =>
        withTenant(prisma, tenant, async (tx) => {
          depth += 1;
          try {
            return await fn(tx, await app.get(PrincipalService).load(tx, session, clerk, null));
          } finally {
            depth -= 1;
          }
        }),
    };
    h.linear().beforeReply = () => {
      if (depth > 0) sawNetworkInsideTransaction = true;
    };
    return app.get(LinearService).requireLinearAccess(runner, principal, projectId);
  };
  const codeOf = async (run: () => Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> => {
    try {
      await run();
    } catch (error) {
      const e = error as { getStatus(): number; getResponse(): { code: string; details?: unknown } };
      return { status: e.getStatus(), code: e.getResponse().code, details: e.getResponse().details };
    }
    throw new Error("deveria falhar");
  };

  it("devolve a chave decifrada e a origem quando tudo confere; consulta só o time (sem listar todos) e fora de qualquer transação", async () => {
    await linked(priv());
    h.linear().calls.length = 0;
    depth = 0;
    sawNetworkInsideTransaction = false;
    const result = await access("admin", priv());
    expect(h.linear().calls).toHaveLength(1);
    expect(h.linear().calls[0]?.query).toMatch(/team\(id:/);
    expect(h.linear().calls[0]?.variables["id"]).toBe(TEAM_ENG.id);
    expect(sawNetworkInsideTransaction).toBe(false);
    expect(result.key).toBe(KEY);
    expect(result.source).toMatchObject({ externalWorkspaceId: "ws-1", externalTeamId: "team-eng" });
  });

  it("sem credencial: 409 linear_not_connected; projeto sem vínculo: 409 linear_not_linked", async () => {
    await linked(priv());
    expect(await codeOf(() => access("contributor", priv()))).toMatchObject({ status: 409, code: "linear_not_connected" });
    world();
    await put("contributor");
    expect(await codeOf(() => access("contributor", open()))).toMatchObject({ status: 409, code: "linear_not_linked" });
  });

  it("chave de outro workspace: 403 linear_workspace_mismatch com o NOME do workspace esperado", async () => {
    await linked(priv());
    await put("contributor", KEY_B);
    const failure = await codeOf(() => access("contributor", priv()));
    expect(failure).toMatchObject({ status: 403, code: "linear_workspace_mismatch", details: { workspaceName: "Acme" } });
  });

  it("mesmo workspace mas a chave não enxerga o time: 403 linear_team_not_visible", async () => {
    await linked(priv());
    await put("contributor", KEY_C);
    expect(await codeOf(() => access("contributor", priv()))).toMatchObject({ status: 403, code: "linear_team_not_visible" });
  });

  it("outra pessoa com a própria chave do mesmo workspace e time visível usa o vínculo", async () => {
    await linked(priv());
    await put("contributor", KEY);
    expect((await access("contributor", priv())).source.externalTeamKey).toBe("ENG");
  });
});

describe("linkConflict (a violação de UNIQUE é traduzida pela restrição, nunca pelo palpite)", () => {
  const p2002 = (index: string) => ({ code: "P2002", meta: { driverAdapterError: { cause: { originalCode: "23505", constraint: { index } } } } });

  it("só a UNIQUE do time vira linear_team_in_use e só a chave primária vira linear_already_linked", () => {
    expect(codeOfHttp(linkConflict(p2002("project_external_sources_team_key")))).toBe("linear_team_in_use");
    expect(codeOfHttp(linkConflict(p2002("project_external_sources_pkey")))).toBe("linear_already_linked");
  });

  it("outra restrição, outro erro do Prisma ou erro comum: nada é traduzido (o original propaga)", () => {
    expect(linkConflict(p2002("outra_restricao_qualquer"))).toBeNull();
    expect(linkConflict({ code: "P2002", meta: {} })).toBeNull();
    expect(linkConflict({ code: "P2003", meta: { driverAdapterError: { cause: { constraint: { index: "project_external_sources_pkey" } } } } })).toBeNull();
    expect(linkConflict(new Error("project_external_sources_pkey"))).toBeNull();
    expect(linkConflict(null)).toBeNull();
  });
});

function codeOfHttp(error: { getResponse(): unknown } | null): string | undefined {
  return (error?.getResponse() as { code?: string } | undefined)?.code;
}
