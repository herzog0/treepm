import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { WHO, as } from "./world.js";
import type { Who, World } from "./world.js";

const h = useHarness();

type Row = {
  action: string;
  req: (w: World) => { method: string; path: string; body?: unknown };
  /** Status por papel, na ordem: admin da org, admin do time T1, gestor de P, colaborador, leitor, membro sem papel. */
  expected: [number, number, number, number, number, number];
};

const rows: Row[] = [
  { action: "ver pessoas", req: () => ({ method: "GET", path: "/api/people" }), expected: [200, 200, 200, 200, 200, 200] },
  { action: "ver times", req: () => ({ method: "GET", path: "/api/teams" }), expected: [200, 200, 200, 200, 200, 200] },
  { action: "ver áreas", req: () => ({ method: "GET", path: "/api/areas" }), expected: [200, 200, 200, 200, 200, 200] },
  {
    action: "criar time",
    req: () => ({ method: "POST", path: "/api/teams", body: { name: "Novo" } }),
    expected: [201, 403, 403, 403, 403, 403],
  },
  {
    action: "renomear o time T1 (do admin do time)",
    req: (w) => ({ method: "PATCH", path: `/api/teams/${w.teams.t1}`, body: { name: "Renomeado" } }),
    expected: [200, 200, 403, 403, 403, 403],
  },
  {
    action: "renomear o time T2 (de outro)",
    req: (w) => ({ method: "PATCH", path: `/api/teams/${w.teams.t2}`, body: { name: "Renomeado" } }),
    expected: [200, 403, 403, 403, 403, 403],
  },
  {
    action: "remover time",
    req: (w) => ({ method: "DELETE", path: `/api/teams/${w.teams.t1}` }),
    expected: [204, 403, 403, 403, 403, 403],
  },
  {
    action: "incluir pessoa no time T1",
    req: (w) => ({ method: "PUT", path: `/api/teams/${w.teams.t1}/members/${w.people.plain}`, body: { role: "member" } }),
    expected: [200, 200, 403, 403, 403, 403],
  },
  {
    action: "incluir pessoa no time T2",
    req: (w) => ({ method: "PUT", path: `/api/teams/${w.teams.t2}/members/${w.people.plain}`, body: { role: "member" } }),
    expected: [200, 403, 403, 403, 403, 403],
  },
  {
    action: "remover pessoa do time T1",
    req: (w) => ({ method: "DELETE", path: `/api/teams/${w.teams.t1}/members/${w.people.target}` }),
    expected: [204, 204, 403, 403, 403, 403],
  },
  {
    action: "remover pessoa do time T2",
    req: (w) => ({ method: "DELETE", path: `/api/teams/${w.teams.t2}/members/${w.people.target}` }),
    expected: [204, 403, 403, 403, 403, 403],
  },
  {
    action: "criar área",
    req: () => ({ method: "POST", path: "/api/areas", body: { name: "Design" } }),
    expected: [201, 403, 403, 403, 403, 403],
  },
  {
    action: "criar projeto",
    req: () => ({ method: "POST", path: "/api/projects", body: { name: "Novo", key: "NEW" } }),
    expected: [201, 403, 403, 403, 403, 403],
  },
  {
    action: "ver projeto organization",
    req: (w) => ({ method: "GET", path: `/api/projects/${w.projects.org}` }),
    expected: [200, 200, 200, 200, 200, 200],
  },
  {
    action: "ver projeto private",
    req: (w) => ({ method: "GET", path: `/api/projects/${w.projects.priv}` }),
    expected: [200, 404, 200, 200, 200, 404],
  },
  {
    action: "renomear projeto private",
    req: (w) => ({ method: "PATCH", path: `/api/projects/${w.projects.priv}`, body: { name: "Outro" } }),
    expected: [200, 404, 200, 403, 403, 404],
  },
  {
    action: "mudar visibilidade do projeto private",
    req: (w) => ({ method: "PATCH", path: `/api/projects/${w.projects.priv}`, body: { visibility: "organization" } }),
    expected: [200, 404, 200, 403, 403, 404],
  },
  {
    action: "arquivar projeto private",
    req: (w) => ({ method: "PATCH", path: `/api/projects/${w.projects.priv}`, body: { archived: true } }),
    expected: [200, 404, 200, 403, 403, 404],
  },
  {
    action: "renomear projeto organization (gestor de outro projeto)",
    req: (w) => ({ method: "PATCH", path: `/api/projects/${w.projects.org}`, body: { name: "Outro" } }),
    expected: [200, 403, 403, 403, 403, 403],
  },
  {
    action: "conceder papel no projeto private",
    req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.priv}/members/${w.people.plain}`, body: { role: "reader" } }),
    expected: [200, 404, 200, 403, 403, 404],
  },
  {
    action: "revogar papel no projeto private",
    req: (w) => ({ method: "DELETE", path: `/api/projects/${w.projects.priv}/members/${w.people.target}` }),
    expected: [204, 404, 204, 403, 403, 404],
  },
  {
    action: "conceder papel no projeto organization",
    req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.org}/members/${w.people.plain}`, body: { role: "reader" } }),
    expected: [200, 403, 403, 403, 403, 403],
  },
  {
    action: "associar time ao projeto private",
    req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.priv}/teams/${w.teams.t2}` }),
    expected: [200, 404, 200, 403, 403, 404],
  },
  {
    action: "desassociar time do projeto private",
    req: (w) => ({ method: "DELETE", path: `/api/projects/${w.projects.priv}/teams/${w.teams.t1}` }),
    expected: [204, 404, 204, 403, 403, 404],
  },
  {
    action: "associar time ao projeto organization",
    req: (w) => ({ method: "PUT", path: `/api/projects/${w.projects.org}/teams/${w.teams.t2}` }),
    expected: [200, 403, 403, 403, 403, 403],
  },
];

describe("matriz de permissões da Fase 1, por papel", () => {
  for (const row of rows) {
    describe(row.action, () => {
      WHO.forEach((who: Who, index) => {
        it(`${who} → ${row.expected[index]}`, async () => {
          const { method, path, body } = row.req(h.world());
          const res = await h.call(method, path, as(who), body);
          expect(res.status).toBe(row.expected[index]);
          if (res.status === 403) expect(res.body.error.code).toBe("forbidden");
          if (res.status === 404) expect(res.body.error.code).toBe("not_found");
        });
      });
    });
  }
});
