import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

const h = useHarness();
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

describe("pessoas", () => {
  it("GET /people lista as pessoas da organização", async () => {
    const res = await h.call("GET", "/api/people", as("plain"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(7);
    expect(res.body[0]).toEqual({
      id: expect.any(String),
      displayName: expect.any(String),
      email: expect.any(String),
      avatarUrl: null,
      clerkRole: expect.stringMatching(/^(admin|member)$/),
      active: true,
      isTest: false,
    });
  });
});

describe("times", () => {
  it("cria, lista, renomeia e remove", async () => {
    const created = await h.call("POST", "/api/teams", as("admin"), { name: "Plataforma" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: "Plataforma", members: [] });

    const list = await h.call("GET", "/api/teams", as("plain"));
    expect(list.body.map((t: { name: string }) => t.name)).toContain("Plataforma");
    const t1 = list.body.find((t: { name: string }) => t.name === "T1");
    expect(t1.members).toEqual(
      expect.arrayContaining([
        { personId: h.world().people.teamAdmin, role: "admin" },
        { personId: h.world().people.target, role: "member" },
      ]),
    );

    const renamed = await h.call("PATCH", `/api/teams/${created.body.id}`, as("admin"), { name: "Infra" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Infra");

    const removed = await h.call("DELETE", `/api/teams/${created.body.id}`, as("admin"));
    expect(removed.status).toBe(204);
    expect((await h.call("PATCH", `/api/teams/${created.body.id}`, as("admin"), { name: "x" })).status).toBe(404);
  });

  it("inclui, altera o papel e remove membros", async () => {
    const { t2 } = h.world().teams;
    const personId = h.world().people.plain;
    const added = await h.call("PUT", `/api/teams/${t2}/members/${personId}`, as("admin"), { role: "member" });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ personId, role: "member" });
    const changed = await h.call("PUT", `/api/teams/${t2}/members/${personId}`, as("admin"), { role: "admin" });
    expect(changed.body).toEqual({ personId, role: "admin" });
    expect((await h.pool.query("select role from team_memberships where team_id=$1 and person_id=$2", [t2, personId])).rows[0].role).toBe("admin");
    expect((await h.call("DELETE", `/api/teams/${t2}/members/${personId}`, as("admin"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/teams/${t2}/members/${personId}`, as("admin"))).status).toBe(404);
  });

  it("admin de time não promove a si mesmo a mais do que a regra de canManageTeamMembers permite (mesma regra do papel)", async () => {
    // Leitura adotada: alterar o papel de quem já é membro usa canManageTeamMembers (admin do time pode).
    const { t1 } = h.world().teams;
    const res = await h.call("PUT", `/api/teams/${t1}/members/${h.world().people.target}`, as("teamAdmin"), { role: "admin" });
    expect(res.status).toBe(200);
  });

  it("nome duplicado → 409 team_name_taken (criação e renomeação)", async () => {
    const dup = await h.call("POST", "/api/teams", as("admin"), { name: "T1" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("team_name_taken");
    const rename = await h.call("PATCH", `/api/teams/${h.world().teams.t2}`, as("admin"), { name: "T1" });
    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe("team_name_taken");
  });

  it("pessoa inexistente → 404; pessoa inativa → 409 person_inactive", async () => {
    const { t2 } = h.world().teams;
    expect((await h.call("PUT", `/api/teams/${t2}/members/${UNKNOWN_ID}`, as("admin"), { role: "member" })).status).toBe(404);
    await h.pool.query("update people set active = false where id = $1", [h.world().people.plain]);
    const res = await h.call("PUT", `/api/teams/${t2}/members/${h.world().people.plain}`, as("admin"), { role: "member" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("person_inactive");
  });
});

describe("áreas", () => {
  it("cria, lista, renomeia e remove; nome duplicado → 409 area_name_taken", async () => {
    const created = await h.call("POST", "/api/areas", as("admin"), { name: "Engenharia" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: "Engenharia" });
    const dup = await h.call("POST", "/api/areas", as("admin"), { name: "Engenharia" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("area_name_taken");
    const second = await h.call("POST", "/api/areas", as("admin"), { name: "Design" });
    const clash = await h.call("PATCH", `/api/areas/${second.body.id}`, as("admin"), { name: "Engenharia" });
    expect(clash.status).toBe(409);
    const renamed = await h.call("PATCH", `/api/areas/${second.body.id}`, as("admin"), { name: "Produto" });
    expect(renamed.body.name).toBe("Produto");
    const list = await h.call("GET", "/api/areas", as("plain"));
    expect(list.body.map((a: { name: string }) => a.name).sort()).toEqual(["Engenharia", "Produto"]);
    expect((await h.call("DELETE", `/api/areas/${second.body.id}`, as("admin"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/areas/${second.body.id}`, as("admin"))).status).toBe(404);
  });
});

describe("projetos", () => {
  it("cria com visibilidade padrão organization, lê, edita e arquiva/desarquiva", async () => {
    const created = await h.call("POST", "/api/projects", as("admin"), { name: "Mapa", key: "MAP" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      name: "Mapa",
      key: "MAP",
      visibility: "organization",
      archivedAt: null,
      members: [],
      teamIds: [],
    });
    const id = created.body.id as string;
    expect((await h.call("GET", `/api/projects/${id}`, as("plain"))).body).toEqual(created.body);

    const patched = await h.call("PATCH", `/api/projects/${id}`, as("admin"), { name: "Mapa 2", visibility: "private" });
    expect(patched.body).toMatchObject({ name: "Mapa 2", visibility: "private", key: "MAP" });
    expect((await h.call("GET", `/api/projects/${id}`, as("plain"))).status).toBe(404);

    const archived = await h.call("PATCH", `/api/projects/${id}`, as("admin"), { archived: true });
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    const unarchived = await h.call("PATCH", `/api/projects/${id}`, as("admin"), { archived: false });
    expect(unarchived.body.archivedAt).toBeNull();
  });

  it("key duplicada → 409 project_key_taken", async () => {
    const res = await h.call("POST", "/api/projects", as("admin"), { name: "Outro", key: "PRIV" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_key_taken");
  });

  it("papéis de projeto: concede, altera, revoga; revogar o último gestor é permitido ao admin da organização", async () => {
    const { priv } = h.world().projects;
    const { plain, manager } = h.world().people;
    const granted = await h.call("PUT", `/api/projects/${priv}/members/${plain}`, as("manager"), { role: "contributor" });
    expect(granted.body).toEqual({ personId: plain, role: "contributor" });
    expect((await h.call("GET", `/api/projects/${priv}`, as("plain"))).status).toBe(200);
    const changed = await h.call("PUT", `/api/projects/${priv}/members/${plain}`, as("manager"), { role: "reader" });
    expect(changed.body.role).toBe("reader");
    expect((await h.call("DELETE", `/api/projects/${priv}/members/${plain}`, as("manager"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/projects/${priv}/members/${plain}`, as("manager"))).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${priv}`, as("plain"))).status).toBe(404);
    // Último gestor: o próprio gestor revoga a si mesmo; o admin continua agindo.
    expect((await h.call("DELETE", `/api/projects/${priv}/members/${manager}`, as("manager"))).status).toBe(204);
    expect((await h.call("PATCH", `/api/projects/${priv}`, as("admin"), { name: "Ainda" })).status).toBe(200);
  });

  it("times do projeto: associa (idempotente) e desassocia", async () => {
    const { priv } = h.world().projects;
    const { t2 } = h.world().teams;
    const first = await h.call("PUT", `/api/projects/${priv}/teams/${t2}`, as("admin"));
    const again = await h.call("PUT", `/api/projects/${priv}/teams/${t2}`, as("admin"));
    expect(first.body).toEqual({ projectId: priv, teamId: t2 });
    expect(again.status).toBe(200);
    expect((await h.call("GET", `/api/projects/${priv}`, as("admin"))).body.teamIds.sort()).toEqual([h.world().teams.t1, t2].sort());
    expect((await h.call("DELETE", `/api/projects/${priv}/teams/${t2}`, as("admin"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/projects/${priv}/teams/${t2}`, as("admin"))).status).toBe(404);
    expect((await h.call("PUT", `/api/projects/${priv}/teams/${UNKNOWN_ID}`, as("admin"))).status).toBe(404);
  });
});

describe("validação de entrada", () => {
  const cases: [string, string, string, unknown][] = [
    ["ID de time que não é UUID", "PATCH", "/api/teams/nao-e-uuid", { name: "x" }],
    ["ID de projeto que não é UUID", "GET", "/api/projects/123", undefined],
    ["ID de pessoa que não é UUID", "PUT", `/api/teams/${UNKNOWN_ID}/members/abc`, { role: "member" }],
    ["nome de time vazio", "POST", "/api/teams", { name: "  " }],
    ["campo desconhecido em time", "POST", "/api/teams", { name: "X", extra: 1 }],
    ["papel de time inválido", "PUT", `/api/teams/${UNKNOWN_ID}/members/${UNKNOWN_ID}`, { role: "owner" }],
    ["key de projeto em minúsculas", "POST", "/api/projects", { name: "X", key: "abc" }],
    ["visibilidade inválida", "POST", "/api/projects", { name: "X", key: "ABC", visibility: "public" }],
    ["PATCH de projeto sem campos", "PATCH", `/api/projects/${UNKNOWN_ID}`, {}],
    ["papel de projeto inválido", "PUT", `/api/projects/${UNKNOWN_ID}/members/${UNKNOWN_ID}`, { role: "owner" }],
    ["corpo ausente em área", "POST", "/api/areas", undefined],
  ];
  it.each(cases)("%s → 400 validation_error", async (_name, method, path, body) => {
    const res = await h.call(method, path, as("admin"), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("recurso inexistente → 404", async () => {
    for (const [method, path, body] of [
      ["PATCH", `/api/teams/${UNKNOWN_ID}`, { name: "x" }],
      ["DELETE", `/api/teams/${UNKNOWN_ID}`, undefined],
      ["PATCH", `/api/areas/${UNKNOWN_ID}`, { name: "x" }],
      ["DELETE", `/api/areas/${UNKNOWN_ID}`, undefined],
      ["GET", `/api/projects/${UNKNOWN_ID}`, undefined],
    ] as const) {
      expect((await h.call(method, path, as("admin"), body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("rotas de produto sem sessão → 401", async () => {
    const request = (await import("supertest")).default;
    const res = await request(h.app().getHttpServer()).get("/api/projects");
    expect(res.status).toBe(401);
  });
});
