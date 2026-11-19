import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { World } from "./world.js";

const h = useHarness();

type Mutation = {
  name: string;
  who: "admin" | "teamAdmin" | "manager";
  req: (w: World) => { method: string; path: string; body?: unknown };
  kind: string;
  subjectType: string;
  subjectId: (w: World) => string | null; // null: id criado, não conhecido de antemão
};

const mutations: Mutation[] = [
  { name: "criar time", who: "admin", req: () => ({ method: "POST", path: "/api/teams", body: { name: "N" } }), kind: "team.created", subjectType: "team", subjectId: () => null },
  { name: "renomear time", who: "teamAdmin", req: (w) => ({ method: "PATCH", path: `/api/teams/${w.teams.t1}`, body: { name: "R" } }), kind: "team.renamed", subjectType: "team", subjectId: (w) => w.teams.t1 },
  { name: "remover time", who: "admin", req: (w) => ({ method: "DELETE", path: `/api/teams/${w.teams.t2}` }), kind: "team.deleted", subjectType: "team", subjectId: (w) => w.teams.t2 },
  { name: "incluir membro de time", who: "teamAdmin", req: (w) => ({ method: "PUT", path: `/api/teams/${w.teams.t1}/members/${w.people.plain}`, body: { role: "member" } }), kind: "team.member_added", subjectType: "team", subjectId: (w) => w.teams.t1 },
  { name: "alterar papel em time", who: "teamAdmin", req: (w) => ({ method: "PUT", path: `/api/teams/${w.teams.t1}/members/${w.people.target}`, body: { role: "admin" } }), kind: "team.member_role_changed", subjectType: "team", subjectId: (w) => w.teams.t1 },
  { name: "remover membro de time", who: "teamAdmin", req: (w) => ({ method: "DELETE", path: `/api/teams/${w.teams.t1}/members/${w.people.target}` }), kind: "team.member_removed", subjectType: "team", subjectId: (w) => w.teams.t1 },
  { name: "criar área", who: "admin", req: () => ({ method: "POST", path: "/api/areas", body: { name: "A" } }), kind: "area.created", subjectType: "area", subjectId: () => null },
  { name: "criar projeto", who: "admin", req: () => ({ method: "POST", path: "/api/projects", body: { name: "P", key: "PP" } }), kind: "project.created", subjectType: "project", subjectId: () => null },
  { name: "editar projeto", who: "manager", req: (w) => ({ method: "PATCH", path: `/api/projects/${w.projects.priv}`, body: { name: "Z", archived: true } }), kind: "project.updated", subjectType: "project", subjectId: (w) => w.projects.priv },
  { name: "conceder papel no projeto", who: "manager", req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.priv}/members/${w.people.plain}`, body: { role: "reader" } }), kind: "project.member_granted", subjectType: "project", subjectId: (w) => w.projects.priv },
  { name: "alterar papel no projeto", who: "manager", req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.priv}/members/${w.people.target}`, body: { role: "contributor" } }), kind: "project.member_role_changed", subjectType: "project", subjectId: (w) => w.projects.priv },
  { name: "revogar papel no projeto", who: "manager", req: (w) => ({ method: "DELETE", path: `/api/projects/${w.projects.priv}/members/${w.people.target}` }), kind: "project.member_revoked", subjectType: "project", subjectId: (w) => w.projects.priv },
  { name: "associar time ao projeto", who: "manager", req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.priv}/teams/${w.teams.t2}` }), kind: "project.team_attached", subjectType: "project", subjectId: (w) => w.projects.priv },
  { name: "desassociar time do projeto", who: "manager", req: (w) => ({ method: "DELETE", path: `/api/projects/${w.projects.priv}/teams/${w.teams.t1}` }), kind: "project.team_detached", subjectType: "project", subjectId: (w) => w.projects.priv },
];

describe("atividade: cada mutação grava exatamente um evento na mesma transação", () => {
  it.each(mutations)("$name → um evento $kind", async (m) => {
    const w = h.world();
    // Provisiona a pessoa antes da contagem (a primeira chamada de cada pessoa não grava evento).
    await h.call("GET", "/api/people", as(m.who));
    const before = Number((await h.pool.query("select count(*) from activity_events")).rows[0].count);
    const { method, path, body } = m.req(w);
    const res = await h.call(method, path, as(m.who), body);
    expect(res.status).toBeLessThan(300);
    const events = await h.pool.query("select * from activity_events order by occurred_at, id");
    expect(events.rowCount).toBe(before + 1);
    const event = events.rows[events.rows.length - 1];
    expect(event.kind).toBe(m.kind);
    expect(event.subject_type).toBe(m.subjectType);
    expect(event.org_id).toBe("org_A");
    expect(event.actor_person_id).toBe(w.people[m.who]);
    expect(event.subject_id).toBe(m.subjectId(w) ?? res.body.id);
    expect(typeof event.payload).toBe("object");
  });

  it("leituras e mutações recusadas não gravam evento", async () => {
    const w = h.world();
    await h.call("GET", "/api/projects", as("plain"));
    await h.call("GET", "/api/teams", as("plain"));
    await h.call("POST", "/api/teams", as("plain"), { name: "x" }); // 403
    await h.call("PATCH", `/api/projects/${w.projects.priv}`, as("plain"), { name: "x" }); // 404
    await h.call("POST", "/api/teams", as("admin"), { name: "T1" }); // 409
    expect((await h.pool.query("select 1 from activity_events")).rowCount).toBe(0);
  });

  it("o evento é revertido junto com a mutação quando a transação falha", async () => {
    const w = h.world();
    // Cria o time T1 de novo: conflito de unicidade → 409, nada gravado.
    const res = await h.call("POST", "/api/teams", as("admin"), { name: "T1" });
    expect(res.status).toBe(409);
    expect((await h.pool.query("select 1 from activity_events")).rowCount).toBe(0);
    expect(w).toBeDefined();
  });

  it("payload mínimo: criação de projeto registra nome, key e visibilidade", async () => {
    await h.call("POST", "/api/projects", as("admin"), { name: "Mapa", key: "MAP", visibility: "private" });
    const event = (await h.pool.query("select payload from activity_events")).rows[0];
    expect(event.payload).toEqual({ name: "Mapa", key: "MAP", visibility: "private" });
  });
});
