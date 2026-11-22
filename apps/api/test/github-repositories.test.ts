import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signState } from "../src/github/state.js";
import { REPOSITORY_PROVIDER } from "../src/github/ports.js";
import { OctokitRepositoryProvider } from "../src/github/octokit-repository-provider.js";
import { REPO_APP, REPO_SITE } from "./github-fakes.js";
import { GITHUB_CONFIG, GITHUB_SECRETS, TEST_CONFIG, createTestApp } from "./helpers.js";
import { useHarness } from "./harness.js";
import { WHO, as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(GITHUB_CONFIG);
const outsider = JSON.stringify({ userId: "u_outsider", orgId: "org_B", orgRole: "org:admin", sessionStatus: "active" });
const sessionOf = (who: Who | "outsider") => (who === "outsider" ? outsider : as(who));

async function rows(sql: string, params: unknown[] = []) {
  return (await h.pool.query(sql, params)).rows as Record<string, unknown>[];
}

/** Liga a organização A ao GitHub direto no banco (a rota de conexão tem os próprios testes). */
async function connect(orgId = "org_A", installationId = 101, personId?: string): Promise<string> {
  const connectedBy = personId ?? (await rows("select id from people where org_id = $1 and clerk_role = 'admin' limit 1", [orgId]))[0]?.["id"];
  const created = await rows(
    "insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by_person_id) values ($1, $2, 'herzog0', 'User', 'selected', $3) returning id",
    [orgId, installationId, connectedBy],
  );
  return String(created[0]?.["id"]);
}

/** Cenário completo: organização A ligada ao GitHub e o provedor falso respondendo pela instalação 101. */
async function ready(): Promise<void> {
  h.github().scenario();
  await connect();
}

const linkRepo = (who: Who | "outsider", projectId: string, repoId: number) => h.call("POST", `/api/projects/${projectId}/repositories`, sessionOf(who), { repoId });

describe("GET /api/github/installation", () => {
  it("qualquer membro vê a ligação, sem o identificador do GitHub", async () => {
    await ready();
    for (const who of WHO) {
      const res = await h.call("GET", "/api/github/installation", as(who));
      expect(res.status, who).toBe(200);
      expect(res.body).toEqual({ installation: { accountLogin: "herzog0", accountType: "User", repositorySelection: "selected", connectedAt: expect.any(String) } });
      expect(JSON.stringify(res.body)).not.toContain("101");
    }
  });

  it("sem ligação, installation é null; uma organização nunca vê a de outra", async () => {
    expect((await h.call("GET", "/api/github/installation", as("admin"))).body).toEqual({ installation: null });
    await ready();
    expect((await h.call("GET", "/api/github/installation", outsider)).body).toEqual({ installation: null });
  });
});

describe("DELETE /api/github/installation", () => {
  it("o administrador remove a ligação, com os repositórios dos projetos, e registra github.disconnected; nada é desinstalado", async () => {
    await ready();
    expect((await linkRepo("admin", h.world().projects.org, REPO_APP.repoId)).status).toBe(201);
    const res = await h.call("DELETE", "/api/github/installation", as("admin"));
    expect(res.status).toBe(204);
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
    expect(await rows("select 1 from project_repositories")).toHaveLength(0);
    expect(await rows("select 1 from activity_events where kind = 'github.disconnected'")).toHaveLength(1);
    expect(h.github().calls.filter((call) => call.startsWith("exchange") || call.startsWith("install"))).toEqual([]);
    expect((await h.call("GET", `/api/projects/${h.world().projects.org}/repositories`, as("admin"))).body).toEqual([]);
  });

  it.each(["teamAdmin", "manager", "contributor", "reader", "plain"] as const)("%s não desconecta (403)", async (who) => {
    await ready();
    expect((await h.call("DELETE", "/api/github/installation", as(who))).status).toBe(403);
    expect(await rows("select 1 from github_installations")).toHaveLength(1);
  });

  it("sem ligação: 404 not_connected", async () => {
    const res = await h.call("DELETE", "/api/github/installation", as("admin"));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_connected");
  });

  it("não alcança a ligação de outra organização", async () => {
    await ready();
    expect((await h.call("DELETE", "/api/github/installation", outsider)).status).toBe(404);
    expect(await rows("select 1 from github_installations")).toHaveLength(1);
  });
});

describe("GET /api/github/repositories", () => {
  it("o administrador e o gestor de algum projeto veem os repositórios da instalação, buscados na hora", async () => {
    await ready();
    for (const who of ["admin", "manager"] as const) {
      const res = await h.call("GET", "/api/github/repositories", as(who));
      expect(res.status, who).toBe(200);
      expect(res.body).toEqual([REPO_APP, REPO_SITE]);
    }
    expect(h.github().calls.filter((call) => call.startsWith("listRepositories"))).toHaveLength(2);
  });

  it.each(["teamAdmin", "contributor", "reader", "plain"] as const)("%s não lista (403), mesmo sem ligação", async (who) => {
    await ready();
    expect((await h.call("GET", "/api/github/repositories", as(who))).status).toBe(403);
    expect(h.github().calls).toEqual([]);
  });

  it("sem ligação: 409 not_connected", async () => {
    const res = await h.call("GET", "/api/github/repositories", as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_connected");
  });

  it("instalação sumida ou suspensa no GitHub: 409 installation_unavailable, e a ligação local continua", async () => {
    await ready();
    h.github().installations.delete(101);
    const gone = await h.call("GET", "/api/github/repositories", as("admin"));
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe("installation_unavailable");
    h.github().scenario({ suspended: true });
    const suspended = await h.call("GET", "/api/github/repositories", as("admin"));
    expect(suspended.status).toBe(409);
    expect(suspended.body.error.code).toBe("installation_unavailable");
    expect(await rows("select 1 from github_installations")).toHaveLength(1);
  });

  it.each(["getInstallation", "listRepositories"] as const)("falha do provedor em %s: 503 github_unavailable", async (operation) => {
    await ready();
    h.github().failOn = operation;
    const res = await h.call("GET", "/api/github/repositories", as("admin"));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("github_unavailable");
  });

  it("a organização B, ligada a outra instalação, não vê os repositórios da A", async () => {
    await ready();
    await connect("org_B", 202);
    h.github().installations.set(202, { installationId: 202, appId: 5858226, accountLogin: "herzog0", accountType: "User", repositorySelection: "all", suspended: false });
    h.github().repositories.set(202, [{ ...REPO_SITE, repoId: 900, fullName: "b/privado" }]);
    const res = await h.call("GET", "/api/github/repositories", outsider);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { fullName: string }) => r.fullName)).toEqual(["b/privado"]);
    expect(h.github().calls).toContain("listRepositories:202");
    expect(h.github().calls).not.toContain("listRepositories:101");
  });
});

describe("POST /api/projects/:id/repositories", () => {
  it("o administrador liga um repositório da instalação e grava o retrato", async () => {
    await ready();
    const res = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), ...REPO_APP, linkedAt: expect.any(String) });
    const saved = await rows("select * from project_repositories");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ org_id: "org_A", project_id: h.world().projects.priv, full_name: "herzog0/app", html_url: REPO_APP.htmlUrl, private: true, default_branch: "main", linked_by_person_id: h.world().people.admin });
    expect(String(saved[0]?.["repo_id"])).toBe("501");
    const events = await rows("select kind, subject_type, subject_id, payload from activity_events where kind = 'project.repository_linked'");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject_type: "project", subject_id: h.world().projects.priv });
  });

  it("o gestor do projeto liga; contribuidor, leitor e membro sem papel não (403 ou 404 se nem veem o projeto)", async () => {
    await ready();
    expect((await linkRepo("manager", h.world().projects.priv, REPO_APP.repoId)).status).toBe(201);
    const expected: Record<string, number> = { teamAdmin: 404, contributor: 403, reader: 403, plain: 404 };
    for (const who of ["teamAdmin", "contributor", "reader", "plain"] as const) {
      expect((await linkRepo(who, h.world().projects.priv, REPO_SITE.repoId)).status, who).toBe(expected[who]);
    }
    // em projeto aberto a organização, quem vê o projeto mas não o gerencia recebe 403
    for (const who of ["teamAdmin", "contributor", "reader", "plain"] as const) {
      expect((await linkRepo(who, h.world().projects.org, REPO_SITE.repoId)).status, who).toBe(403);
    }
    expect(await rows("select 1 from project_repositories")).toHaveLength(1);
  });

  it("confere na hora que o repositório está na instalação: fora dela, 404 repository_not_found", async () => {
    await ready();
    const unknown = await linkRepo("admin", h.world().projects.priv, 424242);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("repository_not_found");
    h.github().repositories.set(101, [REPO_APP]); // o GitHub tirou o repositório da instalação depois da listagem
    const removed = await linkRepo("admin", h.world().projects.priv, REPO_SITE.repoId);
    expect(removed.status).toBe(404);
    expect(removed.body.error.code).toBe("repository_not_found");
    expect(h.github().calls.filter((call) => call.startsWith("listRepositories"))).toHaveLength(2);
    expect(await rows("select 1 from project_repositories")).toHaveLength(0);
  });

  it("repetido: 409 repository_already_linked; o mesmo repositório em outro projeto vale", async () => {
    await ready();
    expect((await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId)).status).toBe(201);
    const again = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("repository_already_linked");
    expect((await linkRepo("admin", h.world().projects.org, REPO_APP.repoId)).status).toBe(201);
    expect(await rows("select 1 from project_repositories")).toHaveLength(2);
  });

  it("projeto arquivado: a mesma recusa das outras escritas, 409 project_archived", async () => {
    await ready();
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.org]);
    const res = await linkRepo("admin", h.world().projects.org, REPO_APP.repoId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
    expect(await rows("select 1 from project_repositories")).toHaveLength(0);
  });

  it("sem ligação: 409 not_connected; projeto de outra organização: 404; corpo inválido: 400", async () => {
    const none = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("not_connected");
    await ready();
    expect((await linkRepo("admin", h.world().other.project, REPO_APP.repoId)).status).toBe(404);
    for (const body of [{}, { repoId: "501" }, { repoId: 0 }, { repoId: 1.5 }, { repoId: 501, extra: 1 }]) {
      const res = await h.call("POST", `/api/projects/${h.world().projects.priv}/repositories`, as("admin"), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.call("POST", "/api/projects/nao-e-uuid/repositories", as("admin"), { repoId: 1 })).status).toBe(400);
  });

  it("a organização B (ligada à instalação 202) não liga um repositório da instalação 101", async () => {
    await ready();
    await connect("org_B", 202);
    h.github().installations.set(202, { installationId: 202, appId: 5858226, accountLogin: "herzog0", accountType: "User", repositorySelection: "all", suspended: false });
    h.github().repositories.set(202, []);
    const res = await linkRepo("outsider", h.world().other.project, REPO_APP.repoId);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("repository_not_found");
  });

  it("instalação sumida no GitHub: 409 installation_unavailable; falha do provedor: 503", async () => {
    await ready();
    h.github().installations.delete(101);
    expect((await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId)).status).toBe(409);
    h.github().scenario();
    h.github().fail = true;
    const res = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("github_unavailable");
  });
});

describe("GET e DELETE /api/projects/:id/repositories", () => {
  it("quem vê o projeto vê os repositórios ligados, em ordem; quem não vê recebe 404", async () => {
    await ready();
    await linkRepo("admin", h.world().projects.priv, REPO_SITE.repoId);
    await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    for (const who of ["admin", "manager", "contributor", "reader"] as const) {
      const res = await h.call("GET", `/api/projects/${h.world().projects.priv}/repositories`, as(who));
      expect(res.status, who).toBe(200);
      expect(res.body.map((r: { fullName: string }) => r.fullName)).toEqual(["herzog0/app", "herzog0/site"]);
      expect(res.body[0]).toEqual({ id: expect.any(String), ...REPO_APP, linkedAt: expect.any(String) });
    }
    expect((await h.call("GET", `/api/projects/${h.world().projects.priv}/repositories`, as("plain"))).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${h.world().projects.priv}/repositories`, outsider)).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${h.world().other.project}/repositories`, as("admin"))).status).toBe(404);
  });

  it("a listagem não consulta o GitHub e funciona com o GitHub fora do ar", async () => {
    await ready();
    await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    h.github().calls.length = 0;
    h.github().fail = true;
    const res = await h.call("GET", `/api/projects/${h.world().projects.priv}/repositories`, as("reader"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(h.github().calls).toEqual([]);
  });

  it("o gestor desliga o repositório (204) e registra project.repository_unlinked; contribuidor não (403)", async () => {
    await ready();
    const linked = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    const path = `/api/projects/${h.world().projects.priv}/repositories/${linked.body.id}`;
    expect((await h.call("DELETE", path, as("contributor"))).status).toBe(403);
    expect((await h.call("DELETE", path, as("plain"))).status).toBe(404);
    expect((await h.call("DELETE", path, as("manager"))).status).toBe(204);
    expect(await rows("select 1 from project_repositories")).toHaveLength(0);
    expect(await rows("select 1 from activity_events where kind = 'project.repository_unlinked'")).toHaveLength(1);
    const again = await h.call("DELETE", path, as("manager"));
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("repository_not_found");
  });

  it("desligar leva os vínculos de código em cascata, e o repositório de outro projeto não se alcança por este", async () => {
    await ready();
    const linked = await linkRepo("admin", h.world().projects.priv, REPO_APP.repoId);
    const ticket = (await rows("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'T', $2) returning id", [h.world().projects.priv, h.world().people.admin]))[0]?.["id"];
    await h.pool.query(
      "insert into ticket_code_links (org_id, project_id, ticket_id, project_repository_id, kind, ref, state, url, seen_at) values ('org_A', $1, $2, $3, 'branch', 'feat/x', 'active', 'u', now())",
      [h.world().projects.priv, ticket, linked.body.id],
    );
    const wrongProject = await h.call("DELETE", `/api/projects/${h.world().projects.org}/repositories/${linked.body.id}`, as("admin"));
    expect(wrongProject.status).toBe(404);
    expect((await h.call("DELETE", `/api/projects/${h.world().projects.priv}/repositories/${linked.body.id}`, as("admin"))).status).toBe(204);
    expect(await rows("select 1 from ticket_code_links")).toHaveLength(0);
  });

  it("projeto arquivado também recusa desligar (409 project_archived)", async () => {
    await ready();
    const linked = await linkRepo("admin", h.world().projects.org, REPO_APP.repoId);
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.org]);
    const res = await h.call("DELETE", `/api/projects/${h.world().projects.org}/repositories/${linked.body.id}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
  });
});

describe("GET /api/me", () => {
  it("informa github.enabled: true com as cinco variáveis", async () => {
    const res = await h.call("GET", "/api/me", as("admin"));
    expect(res.status).toBe(200);
    expect(res.body.github).toEqual({ enabled: true });
    expect(res.body.assistant).toEqual({ configured: false, consent: true, enabled: false });
  });
});

describe("ligação do provedor real", () => {
  // Chave de mentira: o SDK só a lê quando assina uma requisição, e nenhuma é feita aqui.
  const realConfig = { ...GITHUB_CONFIG, GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n" };

  it("com as cinco variáveis, a ligação usa o adaptador do octokit; sem elas, não há provedor e a API sobe", async () => {
    const { app: on } = await createTestApp([], realConfig, { realGithub: true });
    const { app: off } = await createTestApp([], TEST_CONFIG, { realGithub: true });
    expect(on.get(REPOSITORY_PROVIDER)).toBeInstanceOf(OctokitRepositoryProvider);
    expect(off.get(REPOSITORY_PROVIDER)).toBeNull();
    await on.close();
    await off.close();
  });
});

describe("GitHub desligado", () => {
  it("todas as rotas respondem 404 github_disabled, para qualquer papel, e /api/me diz enabled: false", async () => {
    const { app, github } = await createTestApp([], TEST_CONFIG);
    try {
      const request = (await import("supertest")).default;
      const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
      const routes: [string, string, object | undefined][] = [
        ["POST", "/api/github/connect", undefined],
        ["POST", "/api/github/connect/complete", { code: "c", state: "s" }],
        ["GET", "/api/github/installation", undefined],
        ["DELETE", "/api/github/installation", undefined],
        ["GET", "/api/github/repositories", undefined],
        ["GET", `/api/projects/${id}/repositories`, undefined],
        ["POST", `/api/projects/${id}/repositories`, { repoId: 1 }],
        ["DELETE", `/api/projects/${id}/repositories/${id}`, undefined],
        // o corpo inválido também não vence o 404
        ["POST", "/api/github/connect/complete", {}],
        ["POST", `/api/projects/${id}/repositories`, {}],
      ];
      for (const [method, path, body] of routes) {
        for (const session of [as("admin"), as("plain")]) {
          const agent = request(app.getHttpServer());
          const verb = method.toLowerCase() as "get" | "post" | "delete";
          const req = agent[verb](path).set("x-test-session", session);
          const res = await (body ? req.send(body) : req);
          expect(res.status, `${method} ${path}`).toBe(404);
          expect(res.body.error.code, `${method} ${path}`).toBe("github_disabled");
        }
      }
      expect(github.calls).toEqual([]);
      const me = await request(app.getHttpServer()).get("/api/me").set("x-test-session", as("admin"));
      expect(me.body.github).toEqual({ enabled: false });
    } finally {
      await app.close();
    }
  });
});

describe("segredos nunca saem", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    Logger.overrideLogger(false);
  });

  it("nem o client secret, nem a chave privada, nem o code, nem o state aparecem em respostas, eventos ou log", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    Logger.overrideLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    for (const method of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(capture));
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (capture(String(chunk)), true)));
    spies.push(vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (capture(String(chunk)), true)));

    const CODE = "SENTINELA-code-de-uso-unico";
    h.github().scenario();
    h.github().codes.set(CODE, h.github().codes.get("good-code")!);
    const bodies: string[] = [];
    const record = (res: { status: number; text: string }) => bodies.push(`${res.status} ${res.text}`);

    // A resposta de /connect leva o state de propósito (é a URL que o navegador abre): fica fora da conferência do state.
    const connect = await h.call("POST", "/api/github/connect", as("admin"));
    const state = new URL(connect.body.url as string).searchParams.get("state") ?? "";
    record(await h.call("POST", "/api/github/connect/complete", as("admin"), { code: CODE, state }));
    record(await h.call("GET", "/api/github/installation", as("admin")));
    record(await h.call("GET", "/api/github/repositories", as("admin")));
    const linked = await h.call("POST", `/api/projects/${h.world().projects.org}/repositories`, as("admin"), { repoId: REPO_APP.repoId });
    record(linked);
    record(await h.call("GET", `/api/projects/${h.world().projects.org}/repositories`, as("admin")));
    // caminhos de erro: state ruim, código recusado, provedor com erro cru, repetido
    record(await h.call("POST", "/api/github/connect/complete", as("admin"), { code: CODE, state: `${state}x` }));
    record(await h.call("POST", "/api/github/connect/complete", as("admin"), { code: "SENTINELA-code-recusado", state: signState(GITHUB_SECRETS.clientSecret, { orgId: "org_A", userId: "u_admin" }, new Date()) }));
    h.github().fail = true;
    h.github().failWith = new Error(`falha crua: ${CODE} ${state} ${GITHUB_SECRETS.clientSecret} ${GITHUB_SECRETS.privateKey}`);
    record(await h.call("GET", "/api/github/repositories", as("admin")));
    record(await h.call("POST", "/api/github/connect/complete", as("admin"), { code: CODE, state: signState(GITHUB_SECRETS.clientSecret, { orgId: "org_A", userId: "u_admin" }, new Date()) }));
    h.github().fail = false;
    record(await h.call("POST", `/api/projects/${h.world().projects.org}/repositories`, as("admin"), { repoId: REPO_APP.repoId }));

    const stored = JSON.stringify([
      await rows("select * from activity_events"),
      await rows("select * from github_installations"),
      await rows("select * from project_repositories"),
    ]);
    const everything = [...bodies, ...logged, stored].join("\n");
    for (const secret of [GITHUB_SECRETS.clientSecret, "SENTINELA-chave-privada", "BEGIN RSA PRIVATE KEY", CODE, "SENTINELA-code-recusado", state]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(bodies.length).toBeGreaterThan(8);
    // o log existe e é só texto fixo: o erro cru do provedor foi registrado sem a mensagem dele
    expect(logged.join("\n")).not.toContain("falha crua");
    expect(logged.join("\n")).toContain("Falha do provedor de repositórios em getInstallation: Error."); // a captura de log funciona
    for (const secret of [GITHUB_SECRETS.clientSecret, "SENTINELA-chave-privada"]) expect(connect.text).not.toContain(secret);
  });
});

describe("isolamento entre organizações", () => {
  it("a organização B não enxerga a instalação nem os repositórios ligados da A", async () => {
    await ready();
    await linkRepo("admin", h.world().projects.org, REPO_APP.repoId);
    expect((await h.call("GET", "/api/github/installation", outsider)).body).toEqual({ installation: null });
    expect((await h.call("GET", `/api/projects/${h.world().projects.org}/repositories`, outsider)).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${h.world().other.project}/repositories`, outsider)).body).toEqual([]);
  });
});
