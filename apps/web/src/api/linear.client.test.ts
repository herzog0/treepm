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

const runView = {
  id: ID, projectId: ID, mode: "first", phase: "issues", done: false, categorize: false, categorizeAvailable: false,
  errorStreak: 0, pageSize: 50, counts: { issuesCreated: 10, issuesSeen: 10 }, totalExpected: 412, waitUntil: null, lastErrorCode: null, destinationTicketId: null,
  startedBy: { id: ID }, startedAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:01:00.000Z", finishedAt: null,
};

describe("importação em passos do Linear (ADR 0060, seção 3)", () => {
  it("abre a rodada com o destino", async () => {
    const { client, fetchImpl } = setup(runView, 201);
    expect(await client.openLinearRun(ID, { destinationTicketId: null })).toEqual({ ok: true, data: runView });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/projects/${ID}/linear/runs`, method: "POST", body: { destinationTicketId: null } });
  });
  it("lê a rodada atual, que pode não existir", async () => {
    const { client, fetchImpl } = setup({ run: runView });
    expect(await client.getCurrentLinearRun(ID)).toEqual({ ok: true, data: { run: runView } });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${ID}/linear/runs/current`, method: "GET" });
    expect(await setup({ run: null }).client.getCurrentLinearRun(ID)).toEqual({ ok: true, data: { run: null } });
  });
  it("dá um passo", async () => {
    const { client, fetchImpl } = setup({ ...runView, waitUntil: "2026-11-24T10:05:00.000Z" });
    const result = await client.stepLinearRun(ID, ID);
    expect(result).toMatchObject({ ok: true, data: { waitUntil: "2026-11-24T10:05:00.000Z" } });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${ID}/linear/runs/${ID}/step`, method: "POST" });
  });
  it("aceita a fase 'mentions', a falha, os contadores novos e o booleano em counts", async () => {
    const view = { ...runView, phase: "mentions", errorStreak: 3, pageSize: 50, counts: { issuesCreated: 10, skippedInvalid: 2, withoutDescription: 1, movedOutOfIdea: 4, assigneeEmailUnavailable: true } };
    expect(await setup(view).client.stepLinearRun(ID, ID)).toEqual({ ok: true, data: view });
    const failedView = { ...runView, phase: "failed", done: true, errorStreak: 0, pageSize: 50, lastErrorCode: "step_failed" };
    expect(await setup({ run: failedView }).client.getCurrentLinearRun(ID)).toEqual({ ok: true, data: { run: failedView } });
  });
  it("aceita a fase 'missing' e os contadores e booleanos da reimportação", async () => {
    const view = { ...runView, mode: "reimport", phase: "missing", pageSize: 50, counts: { updated: 3, keptTouched: 1, keptMoved: 2, elsewhere: 1, missing: 4, missingProjects: 1, descriptionUnavailable: true, missingNotChecked: true } };
    expect(await setup(view).client.stepLinearRun(ID, ID)).toEqual({ ok: true, data: view });
  });
  it("aceita a fase 'statuses' (reimportação: atualizando situações)", async () => {
    const view = { ...runView, mode: "reimport", phase: "statuses", pageSize: 50, counts: { updated: 1 } };
    expect(await setup(view).client.stepLinearRun(ID, ID)).toEqual({ ok: true, data: view });
  });
  it("a rodada atual traz a última concluída (lastFinished), que pode ser nula", async () => {
    const finished = { ...runView, phase: "done", done: true, pageSize: 50, finishedAt: "2026-11-22T10:00:00.000Z" };
    expect(await setup({ run: null, lastFinished: finished }).client.getCurrentLinearRun(ID)).toEqual({ ok: true, data: { run: null, lastFinished: finished } });
    expect(await setup({ run: null, lastFinished: null }).client.getCurrentLinearRun(ID)).toEqual({ ok: true, data: { run: null, lastFinished: null } });
  });
  it("abre a reimportação sem destino (herda): o corpo não leva a chave", async () => {
    const { client, fetchImpl } = setup(runView, 201);
    await client.openLinearRun(ID, {});
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/projects/${ID}/linear/runs`, method: "POST", body: {} });
  });
  it("lê a prévia: quantas issues vêm, ou nulo quando o Linear não disse", async () => {
    const { client, fetchImpl } = setup({ issueCount: 412 });
    expect(await client.getLinearPreview(ID)).toEqual({ ok: true, data: { issueCount: 412 } });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${ID}/linear/preview`, method: "GET" });
    expect(await setup({ issueCount: null }).client.getLinearPreview(ID)).toEqual({ ok: true, data: { issueCount: null } });
  });
  it("os times trazem a data da última importação (ou nula)", async () => {
    const withDate = { ...team, lastImportedAt: "2026-11-22T10:00:00.000Z" };
    expect(await setup([withDate, { ...team, id: "t2", lastImportedAt: null }]).client.listLinearTeams()).toMatchObject({ ok: true, data: [{ lastImportedAt: "2026-11-22T10:00:00.000Z" }, { lastImportedAt: null }] });
    // servidor antigo, sem o campo: segue valendo
    expect((await setup([team]).client.listLinearTeams()).ok).toBe(true);
  });
  it("a origem do ticket traz missingSince", async () => {
    const detail = { id: ID, projectId: ID, number: 1, parentId: null, progress: null, idea: null, assigneeIds: [], descriptionExcerpt: "", agentWork: null, key: "TREEPM-1", title: "a", status: "todo", description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: ID, createdAt: "x", updatedAt: "x" };
    const source = { provider: "linear", key: "ENG-123", url: null, missingSince: "2026-11-20T10:00:00.000Z" };
    const result = await setup({ ...detail, externalSource: source }).client.getTicket(ID);
    expect(result.ok && result.data.externalSource).toEqual(source);
  });
  it("abandona a rodada", async () => {
    const abandoned = { ...runView, phase: "failed", done: true, errorStreak: 0, pageSize: 50 };
    const { client, fetchImpl } = setup(abandoned);
    expect(await client.abandonLinearRun(ID, ID)).toEqual({ ok: true, data: abandoned });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${ID}/linear/runs/${ID}/abandon`, method: "POST" });
  });
  it("o detalhe aceita origem do Linear sem endereço (url nula)", async () => {
    const detail = { id: ID, projectId: ID, number: 1, parentId: null, progress: null, idea: null, assigneeIds: [], descriptionExcerpt: "", agentWork: null, key: "TREEPM-1", title: "a", status: "todo", description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: ID, createdAt: "x", updatedAt: "x" };
    const source = { provider: "linear", key: "ENG-123", url: null };
    const result = await setup({ ...detail, externalSource: source }).client.getTicket(ID);
    expect(result.ok && result.data.externalSource).toEqual(source);
  });
  it("uma rodada fora do contrato vira indisponível", async () => {
    expect(await setup({ ...runView, phase: "nope" }).client.stepLinearRun(ID, ID)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it("o detalhe do ticket traz a origem do Linear, ou nenhuma", async () => {
    const detail = { id: ID, projectId: ID, number: 1, parentId: null, progress: null, idea: null, assigneeIds: [], descriptionExcerpt: "", agentWork: null, key: "TREEPM-1", title: "a", status: "todo", description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: ID, createdAt: "x", updatedAt: "x" };
    const source = { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/x" };
    const withSource = await setup({ ...detail, externalSource: source }).client.getTicket(ID);
    expect(withSource.ok && withSource.data.externalSource).toEqual(source);
  });
});

describe("frases dos erros do Linear", () => {
  const phrase = (code: string, details?: Record<string, unknown>) => describeApiError(i18n.t, { kind: "unavailable", code, ...(details ? { details } : {}) });
  it.each([
    "linear_key_invalid", "linear_unavailable", "linear_not_connected", "linear_not_configured", "linear_confirmation_mismatch",
    "linear_already_linked", "linear_team_in_use", "linear_team_not_found", "project_archived", "not_while_acting_as",
    "linear_run_open", "linear_reimport_not_available", "linear_step_in_progress", "structure_busy", "linear_not_linked", "linear_workspace_mismatch", "linear_team_not_visible",
    "linear_destination_invalid", "linear_run_finished", "step_failed", "step_too_slow",
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
