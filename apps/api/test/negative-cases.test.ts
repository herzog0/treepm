import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { ORG, OTHER_ORG, as } from "./world.js";

const h = useHarness();
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

describe("casos negativos obrigatórios (docs/domain-model.md)", () => {
  it("caso 1: com a organização A no contexto, a API não lê dados de B em nenhuma listagem", async () => {
    const w = h.world();
    const [people, teams, areas, projects] = await Promise.all(
      ["people", "teams", "areas", "projects"].map((p) => h.call("GET", `/api/${p}`, as("admin"))),
    );
    const ids = (res: { body: { id: string }[] }) => res.body.map((row) => row.id);
    expect(ids(people!)).not.toContain(w.other.person);
    expect(ids(teams!)).not.toContain(w.other.team);
    expect(ids(projects!)).not.toContain(w.other.project);
    expect(areas!.status).toBe(200);
    const mutate = await h.call("PATCH", `/api/teams/${w.other.team}`, as("admin"), { name: "invadido" });
    expect(mutate.status).toBe(404);
    expect((await h.pool.query("select name from teams where id = $1", [w.other.team])).rows[0].name).toBe("TB");
  });

  it("caso 3: ID de projeto de B enviado por usuário de A devolve 404 em qualquer rota", async () => {
    const id = h.world().other.project;
    const admin = as("admin");
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/projects/${id}`],
      ["PATCH", `/api/projects/${id}`, { name: "x" }],
      ["PUT", `/api/projects/${id}/members/${h.world().people.plain}`, { role: "reader" }],
      ["DELETE", `/api/projects/${id}/members/${h.world().people.plain}`],
      ["PUT", `/api/projects/${id}/teams/${h.world().teams.t1}`],
      ["DELETE", `/api/projects/${id}/teams/${h.world().teams.t1}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await h.call(method, path, admin, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    // A resposta é idêntica à de um ID que não existe em lugar nenhum.
    const unknown = await h.call("GET", `/api/projects/${UNKNOWN_ID}`, admin);
    const foreign = await h.call("GET", `/api/projects/${id}`, admin);
    expect(foreign.body).toEqual(unknown.body);
  });

  it("caso 4: membro sem papel não vê projeto privado em GET /projects, GET /projects/:id nem em contagens", async () => {
    const w = h.world();
    const list = await h.call("GET", "/api/projects", as("plain"));
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([w.projects.org]);
    expect(JSON.stringify(list.body)).not.toContain(w.projects.priv);
    expect(JSON.stringify(list.body)).not.toContain("PRIV");

    const detail = await h.call("GET", `/api/projects/${w.projects.priv}`, as("plain"));
    expect(detail.status).toBe(404);

    // Contagens: o gestor vê os 2 projetos e a quantidade de membros; o membro sem papel não vê o privado.
    const manager = await h.call("GET", "/api/projects", as("manager"));
    expect(manager.body).toHaveLength(2);
    const privateForManager = manager.body.find((p: { id: string }) => p.id === w.projects.priv);
    expect(privateForManager.members).toHaveLength(4);
    expect(privateForManager.teamIds).toEqual([w.teams.t1]);

    // Admin de time sem papel no projeto também não o descobre.
    const teamAdmin = await h.call("GET", "/api/projects", as("teamAdmin"));
    expect(teamAdmin.body.map((p: { id: string }) => p.id)).toEqual([w.projects.org]);
  });

  it("caso 4 (tentativa de descoberta): mutações em projeto privado por quem não o vê devolvem 404, não 403", async () => {
    const w = h.world();
    const res = await h.call("PATCH", `/api/projects/${w.projects.priv}`, as("plain"), { name: "x" });
    expect(res.status).toBe(404);
  });

  it("caso 5: leitor e colaborador não concedem papéis nem alteram o projeto", async () => {
    const w = h.world();
    for (const who of ["reader", "contributor"] as const) {
      const grant = await h.call("PUT", `/api/projects/${w.projects.priv}/members/${w.people.plain}`, as(who), {
        role: "manager",
      });
      expect(grant.status, `${who} concede`).toBe(403);
      const revoke = await h.call("DELETE", `/api/projects/${w.projects.priv}/members/${w.people.target}`, as(who));
      expect(revoke.status, `${who} revoga`).toBe(403);
      const rename = await h.call("PATCH", `/api/projects/${w.projects.priv}`, as(who), { name: "Hackeado" });
      expect(rename.status, `${who} renomeia`).toBe(403);
      const archive = await h.call("PATCH", `/api/projects/${w.projects.priv}`, as(who), { archived: true });
      expect(archive.status, `${who} arquiva`).toBe(403);
    }
    const state = await h.pool.query("select name, archived_at from projects where id = $1", [w.projects.priv]);
    expect(state.rows[0]).toEqual({ name: "Privado", archived_at: null });
    expect((await h.pool.query("select 1 from project_memberships where project_id = $1", [w.projects.priv])).rowCount).toBe(4);
  });

  it("caso 6: pessoa removida da organização no Clerk não acessa mais nada, mesmo com memberships antigas", async () => {
    const w = h.world();
    const before = await h.call("GET", `/api/projects/${w.projects.priv}`, as("manager"));
    expect(before.status).toBe(200);

    h.verifier().removed.add(`u_manager:${ORG}`);

    for (const path of ["/api/me", "/api/people", "/api/projects", `/api/projects/${w.projects.priv}`, "/api/teams"]) {
      const res = await h.call("GET", path, as("manager"));
      expect(res.status, path).toBe(403);
    }
    const mutation = await h.call("PATCH", `/api/projects/${w.projects.priv}`, as("manager"), { name: "x" });
    expect(mutation.status).toBe(403);
    // As linhas antigas continuam no banco; o bloqueio vem do Clerk.
    expect((await h.pool.query("select 1 from project_memberships where person_id = $1", [w.people.manager])).rowCount).toBe(1);
    expect((await h.pool.query("select name from projects where id = $1", [w.projects.priv])).rows[0].name).toBe("Privado");
  });

  it("caso 6 (variante): o mesmo usuário, agora só em B, não enxerga A com as linhas antigas", async () => {
    const w = h.world();
    h.verifier().removed.add(`u_manager:${ORG}`);
    // O token do usuário passa a trazer apenas a organização B.
    const asOtherOrg = as("manager", OTHER_ORG);
    const res = await h.call("GET", `/api/projects/${w.projects.priv}`, asOtherOrg);
    expect(res.status).toBe(404);
    const list = await h.call("GET", "/api/projects", asOtherOrg);
    expect(list.body.map((p: { id: string }) => p.id)).not.toContain(w.projects.priv);
  });

  it("caso 7: relação entre time de A e projeto de B é recusada (404 na API, nada gravado)", async () => {
    const w = h.world();
    const teamOfBToProjectOfA = await h.call("PUT", `/api/projects/${w.projects.priv}/teams/${w.other.team}`, as("admin"));
    expect(teamOfBToProjectOfA.status).toBe(404);
    const teamOfAToProjectOfB = await h.call("PUT", `/api/projects/${w.other.project}/teams/${w.teams.t2}`, as("admin"));
    expect(teamOfAToProjectOfB.status).toBe(404);
    expect((await h.pool.query("select 1 from project_teams where team_id = $1 or project_id = $2", [w.other.team, w.other.project])).rowCount).toBe(0);
  });
});
