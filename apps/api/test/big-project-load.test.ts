import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "../scripts/big-project/load.js";
import { planBigProject } from "../scripts/big-project/plan.js";
import type { BigProjectPlan } from "../scripts/big-project/plan.js";
import { createTestApp, ownerPoolWithCleanup, sessionHeader } from "./helpers.js";

// O projeto grande gravado em lote tem de ser lido pela API de verdade sem erro (as regras que o SQL ignora, o plano respeita).
const pool = ownerPoolWithCleanup();
let app: INestApplication;
let plan: BigProjectPlan;
const session = sessionHeader({ userId: PERF_ADMIN_USER, orgId: PERF_ORG, orgRole: "org:admin" });
const get = (path: string) => request(app.getHttpServer()).get(path).set("x-test-session", session);

beforeAll(async () => {
  ({ app } = await createTestApp());
  plan = planBigProject({ n: 300, seed: 3, key: "BG", now: Date.now() });
  await loadBigProject(pool, plan);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("projeto grande carregado em lote", () => {
  it("a lista traz os N tickets, com ideias, marcadores e progresso, e passa pela validação de saída", async () => {
    const res = await get(`/api/projects/${plan.projectId}/tickets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(300);
    expect(res.body.some((t: { idea: unknown }) => t.idea !== null)).toBe(true);
    expect(res.body.some((t: { agentWork: unknown }) => t.agentWork !== null)).toBe(true);
    expect(res.body.some((t: { progress: unknown }) => t.progress !== null)).toBe(true);
  });

  it("detalhe das fixtures, atividade do ticket de muito histórico e lista de ideias respondem", async () => {
    const f = plan.fixtures;
    for (const index of [f.deep, f.shallow, f.history, f.idea]) expect((await get(`/api/tickets/${plan.tickets[index]!.id}`)).status).toBe(200);
    const activity = await get(`/api/tickets/${plan.tickets[f.history]!.id}/activity?limit=100`);
    expect(activity.status).toBe(200);
    expect(activity.body.entries.length).toBe(100);
    expect((await get(`/api/projects/${plan.projectId}/ideas`)).body.length).toBeGreaterThan(0);
  });

  it("as ligações gravadas são as que a regra do produto refaria a partir das descrições", async () => {
    const res = await request(app.getHttpServer()).post(`/api/projects/${plan.projectId}/tickets/mentions/rebuild`).set("x-test-session", session);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, removed: 0 });
  });
});
