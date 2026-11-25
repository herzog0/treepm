import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { createApiClient } from "./client.js";
import { describeApiError } from "./errorText.js";

const ID = "11111111-1111-4111-8111-111111111111";

function setup(body: unknown = {}, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })));
  const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
  return { client, fetchImpl };
}
const lastCall = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => {
  const [path, init] = fetchImpl.mock.calls.at(-1)!;
  return { path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

const connection = { configured: true, connection: { workspace: { id: "w1", name: "Acme" }, hint: "a1b2", connectedAt: "2026-11-24T10:00:00.000Z" } };
const team = { id: "t1", key: "ENG", name: "Engenharia", linkedProject: { id: ID, name: "TreePM" }, linkedElsewhere: false };
const projectLinear = {
  source: { workspace: { id: "w1", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: ID } },
  canLink: false,
  keyMatches: true,
};

describe("rotas do Linear (ADR 0060)", () => {
  it("lê a ligação da pessoa", async () => {
    const { client, fetchImpl } = setup(connection);
    expect(await client.getLinearConnection()).toEqual({ ok: true, data: connection });
    expect(lastCall(fetchImpl)).toMatchObject({ path: "/api/linear/connection", method: "GET" });
  });

  it("aceita a ligação sem chave e o servidor sem Linear", async () => {
    expect((await setup({ configured: false, connection: null }).client.getLinearConnection())).toEqual({ ok: true, data: { configured: false, connection: null } });
    expect((await setup({ configured: true, connection: null }).client.getLinearConnection())).toEqual({ ok: true, data: { configured: true, connection: null } });
    // agindo como outra pessoa o servidor responde 200 com `actingAs: true` e nenhuma conexão
    expect((await setup({ configured: true, connection: null, actingAs: true }).client.getLinearConnection())).toEqual({ ok: true, data: { configured: true, connection: null, actingAs: true } });
  });

  it("conecta com a chave e devolve a nova ligação", async () => {
    const { client, fetchImpl } = setup(connection);
    expect(await client.connectLinear("lin_api_x")).toEqual({ ok: true, data: connection });
    expect(lastCall(fetchImpl)).toEqual({ path: "/api/linear/connection", method: "PUT", body: { apiKey: "lin_api_x" } });
  });

  it("remove a chave", async () => {
    const { client, fetchImpl } = setup({}, 204);
    expect(await client.disconnectLinear()).toEqual({ ok: true, data: undefined });
    expect(lastCall(fetchImpl)).toMatchObject({ path: "/api/linear/connection", method: "DELETE" });
  });

  it("lista os times que a chave enxerga", async () => {
    const { client, fetchImpl } = setup([team]);
    expect(await client.listLinearTeams()).toEqual({ ok: true, data: [team] });
    expect(lastCall(fetchImpl)).toMatchObject({ path: "/api/linear/teams", method: "GET" });
  });

  it("lê e cria a origem do projeto", async () => {
    const { client, fetchImpl } = setup(projectLinear);
    expect(await client.getProjectLinear(ID)).toEqual({ ok: true, data: projectLinear });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${ID}/linear`, method: "GET" });
    expect(await client.linkProjectToLinear(ID, { teamId: "t1", confirmTeamKey: "ENG" })).toEqual({ ok: true, data: projectLinear });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/projects/${ID}/linear`, method: "POST", body: { teamId: "t1", confirmTeamKey: "ENG" } });
  });

  it("uma resposta fora do contrato vira indisponível", async () => {
    expect(await setup({ nope: true }).client.listLinearTeams()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("guarda o prazo do limite do Linear nos detalhes do erro", async () => {
    const { client } = setup({ error: { code: "linear_rate_limited", message: "x", details: { retryAfterSeconds: 42 } } }, 429);
    expect(await client.listLinearTeams()).toEqual({ ok: false, error: { kind: "unavailable", code: "linear_rate_limited", details: { retryAfterSeconds: 42 } } });
  });

  it("mantém o código dos erros 422 e 503 do Linear", async () => {
    expect(await setup({ error: { code: "linear_key_invalid", message: "x" } }, 422).client.connectLinear("k")).toEqual({ ok: false, error: { kind: "unavailable", code: "linear_key_invalid" } });
    expect(await setup({ error: { code: "linear_not_configured", message: "x" } }, 503).client.listLinearTeams()).toEqual({ ok: false, error: { kind: "unavailable", code: "linear_not_configured" } });
  });
});

describe("frases dos erros do Linear", () => {
  const phrase = (code: string, details?: Record<string, unknown>) => describeApiError(i18n.t, { kind: "unavailable", code, ...(details ? { details } : {}) });
  it.each([
    "linear_key_invalid", "linear_unavailable", "linear_not_connected", "linear_not_configured", "linear_confirmation_mismatch",
    "linear_already_linked", "linear_team_in_use", "linear_team_not_found", "project_archived", "not_while_acting_as",
  ])("%s tem frase própria, não a genérica", (code) => {
    const text = phrase(code);
    expect(text).not.toBe(describeApiError(i18n.t, { kind: "unavailable" }));
    expect(text).not.toContain("errors.");
  });
  it("o limite diz quantos segundos esperar", () => {
    expect(phrase("linear_rate_limited", { retryAfterSeconds: 42 })).toContain("42");
    expect(phrase("linear_rate_limited")).not.toContain("{{");
  });
  it("a frase da chave inválida diz que ela foi recusada pelo Linear", () => {
    expect(phrase("linear_key_invalid")).toMatch(/Linear/);
  });
});
