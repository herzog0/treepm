import type { INestApplication } from "@nestjs/common";
import { APP_URL } from "@treepm/db/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "../scripts/big-project/load.js";
import { planBigProject } from "../scripts/big-project/plan.js";
import type { BigProjectPlan } from "../scripts/big-project/plan.js";
import { buildPools } from "../scripts/concurrent-writes/plan.js";
import { createTestApp, ownerPoolWithCleanup } from "./helpers.js";
import { explainReads } from "./explain-reads.js";
import { perfClock, perfSession } from "./perf-support.js";
import { recordTimed } from "./query-recorder.js";

// Custo das mudanças de estrutura em LINHAS LIDAS pelo executor (TREEPM-261), não em linhas devolvidas: uma busca que varre o projeto
// e devolve 0 linhas parece barata para `recordQueries`. Cada caminho roda num projeto pequeno e num grande (10 vezes maior) e a
// leitura do grande não pode passar da do pequeno além de uma folga fixa, nem varrer `tickets` em sequência.
const pool = ownerPoolWithCleanup();
const appPool = new pg.Pool({ connectionString: APP_URL, max: 1 });
let app: INestApplication;
const SMALL = 300;
const BIG = 3000;
const SLACK = 12; // linhas: o que a profundidade de uma árvore sorteada pode somar

const send = (method: "get" | "post" | "patch" | "delete", path: string, body?: unknown) => {
  const req = request(app.getHttpServer())[method](path).set("x-test-session", perfSession);
  return body === undefined ? req : req.send(body as object);
};

type Cost = { scanned: number; seqScansOfTickets: number; status: number };
/** Roda a requisição anotando as consultas e refaz as leituras com EXPLAIN (ANALYZE). */
async function costOf(run: () => Promise<{ status: number; body?: unknown }>): Promise<Cost> {
  const { result, queries } = await recordTimed(async () => run());
  const work = queries.filter((q) => !/^\s*(begin|commit|rollback)/i.test(q.text));
  const explained = await explainReads(appPool, { orgId: PERF_ORG, userId: PERF_ADMIN_USER }, work);
  expect(explained.replayed, "nenhuma leitura refeita: o replay não mediu nada").toBeGreaterThan(5);
  return { scanned: explained.scanned, seqScansOfTickets: explained.seqScansOfTickets, status: result.status };
}

type Path = { name: string; run: (plan: BigProjectPlan, index: number) => Promise<Cost> };
const T = (plan: BigProjectPlan, i: number): string => plan.tickets[i]!.id;
const PATHS: Path[] = [
  {
    name: "mover uma folha de pai",
    run: async (plan) => {
      const pools = buildPools(plan);
      return costOf(() => send("patch", `/api/tickets/${T(plan, pools.leaves[3]!)}`, { parentId: T(plan, pools.inner[2]!) }));
    },
  },
  {
    name: "mudar a situação de uma folha",
    run: async (plan) => costOf(() => send("patch", `/api/tickets/${T(plan, buildPools(plan).leaves[3]!)}`, { status: "in_progress" })),
  },
  {
    name: "remover uma folha",
    run: async (plan) => {
      const made = await send("post", `/api/projects/${plan.projectId}/tickets`, { title: "Para remover", parentId: T(plan, buildPools(plan).inner[2]!) });
      expect(made.status).toBe(201);
      return costOf(() => send("delete", `/api/tickets/${(made.body as { id: string }).id}`));
    },
  },
  {
    name: "aceitar uma ideia",
    run: async (plan) => {
      const root = plan.tickets.find((t) => t.ideaStage === "new" || t.ideaStage === "refining" || t.ideaStage === "ready")!;
      return costOf(() => send("post", `/api/tickets/${root.id}/idea/accept`));
    },
  },
  {
    name: "descartar uma ideia",
    run: async (plan) => {
      const root = plan.tickets.filter((t) => t.ideaStage === "new" || t.ideaStage === "refining" || t.ideaStage === "ready").at(-1)!;
      return costOf(() => send("post", `/api/tickets/${root.id}/idea/discard`));
    },
  },
  {
    name: "transformar uma folha em ideia",
    run: async (plan) => costOf(() => send("post", `/api/tickets/${T(plan, buildPools(plan).leaves[5]!)}/idea`)),
  },
];

// Os caminhos que CRIAM ticket com pai (criar, importar) buscam as descrições que já citam a chave nova (`lockLinkedTickets` e
// `backfillMentionsTo`): sem índice de texto isso varre o projeto. Lacuna conhecida (ver o relatório e o ticket filho do TREEPM-261): o
// conserto exige migration. `it.fails` mantém a suíte verde e fica VERMELHO assim que a busca deixar de crescer com o projeto,
// quando a marca deve sair.
const GAPS: Path[] = [
  {
    name: "criar um ticket com pai",
    run: async (plan) => costOf(() => send("post", `/api/projects/${plan.projectId}/tickets`, { title: "Novo", description: "Texto curto.", parentId: T(plan, buildPools(plan).inner[2]!) })),
  },
  {
    name: "importar tickets sob um pai",
    run: async (plan) =>
      costOf(() => send("post", `/api/projects/${plan.projectId}/tickets/import`, { parentId: T(plan, buildPools(plan).inner[2]!), items: [{ title: "A", description: "a" }, { title: "B", children: [{ title: "C" }] }] })),
  },
];

const costs = new Map<string, Cost>();

async function reload(n: number): Promise<BigProjectPlan> {
  const plan = planBigProject({ n, seed: 11, key: "BG", now: perfClock.now() });
  await loadBigProject(pool, plan);
  await pool.query("analyze");
  return plan;
}

beforeAll(async () => {
  ({ app } = await createTestApp([], undefined, { clock: perfClock }));
  for (const [size, key] of [[SMALL, "small"], [BIG, "big"]] as const) {
    for (const path of [...PATHS, ...GAPS]) {
      // Cada caminho parte do projeto recém-carregado (mesma semente, mesmos ids): um não muda o que o outro lê.
      const plan = await reload(size);
      const cost = await path.run(plan, 0);
      expect(cost.status, `${path.name} (${size})`).toBeLessThan(300);
      costs.set(`${path.name}|${key}`, cost);
    }
  }
}, 900_000);
afterAll(async () => {
  await app.close();
  await appPool.end();
  await pool.end();
});

const pair = (name: string): { small: Cost; big: Cost } => ({ small: costs.get(`${name}|small`)!, big: costs.get(`${name}|big`)! });
const assertFlat = (name: string): void => {
  const { small, big } = pair(name);
  expect(big.seqScansOfTickets, `${name}: varreduras sequenciais de tickets no projeto grande`).toBe(0);
  expect(big.scanned, `${name}: linhas lidas ${small.scanned} (${SMALL}) → ${big.scanned} (${BIG})`).toBeLessThanOrEqual(small.scanned + SLACK);
};

describe("mudanças de estrutura não leem o projeto inteiro (linhas lidas, projeto 10 vezes maior)", () => {
  for (const path of PATHS) it(path.name, () => assertFlat(path.name));
});

describe("lacunas conhecidas: buscar quem cita a chave nova varre o projeto (exige migration)", () => {
  for (const path of GAPS) it.fails(path.name, () => assertFlat(path.name));
});
