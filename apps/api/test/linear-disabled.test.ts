import { describe, expect, it } from "vitest";
import { TEST_CONFIG } from "./helpers.js";
import { KEY, useLinearHarness } from "./linear-support.js";
import { as } from "./world.js";

// Sem CREDENTIALS_ENCRYPTION_KEY (ADR 0060) a API sobe e a ligação com o Linear fica desligada.
const { h } = useLinearHarness(TEST_CONFIG);
const PROJECT = "0190c0de-0000-7000-8000-000000000001";

describe("com CREDENTIALS_ENCRYPTION_KEY ausente", () => {
  it("GET connection responde 200 com configured false (a web esconde a seção)", async () => {
    const res = await h.call("GET", "/api/linear/connection", as("contributor"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, connection: null });
  });

  it.each([
    ["PUT", "/api/linear/connection", { apiKey: KEY }],
    ["PUT", "/api/linear/connection", {}],
    ["GET", "/api/linear/teams", undefined],
    ["GET", `/api/projects/${PROJECT}/linear`, undefined],
    ["POST", `/api/projects/${PROJECT}/linear`, { teamId: "t", confirmTeamKey: "ENG" }],
    ["POST", `/api/projects/${PROJECT}/linear`, {}],
  ])("%s %s: 503 linear_not_configured, antes de qualquer validação", async (method, path, body) => {
    const res = await h.call(method, path, as("admin"), body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("linear_not_configured");
    expect(h.linear().calls).toHaveLength(0);
  });

  it("DELETE connection continua funcionando: a pessoa sempre consegue remover a própria chave guardada", async () => {
    const w = h.world();
    await h.pool.query(
      `insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
       select 'org_A', $1::uuid, 'linear', $2::bytea, $3::bytea, 1, 'ws-1', 'Acme', 'abcd' union all select 'org_A', $4::uuid, 'linear', $2::bytea, $3::bytea, 1, 'ws-1', 'Acme', 'abcd'`,
      [w.people.contributor, Buffer.from("cifrado-0123456789ab"), Buffer.alloc(12, 3), w.people.reader],
    );
    const res = await h.call("DELETE", "/api/linear/connection", as("contributor"));
    expect(res.status).toBe(204);
    const left = (await h.pool.query<{ person_id: string }>("select person_id from external_credentials")).rows;
    expect(left).toEqual([{ person_id: w.people.reader }]);
    expect(h.linear().calls).toHaveLength(0);
  });

  it("a API sobe sem a variável e as outras rotas seguem funcionando", async () => {
    expect((await h.call("GET", "/api/me", as("admin"))).status).toBe(200);
  });
});
