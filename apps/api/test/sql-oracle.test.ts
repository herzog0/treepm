import { createPrismaClient } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { ideaRootsOf, queuePlaces, ticketProgress } from "@treepm/domain";
import type { DependencyEdge, TicketNode, TicketProgress } from "@treepm/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/access/authorization.service.js";
import { ProjectQueryService } from "../src/query/project-query.service.js";
import { ideaRootOfTicket } from "../src/tickets/idea-root.js";
import { readBranchOf, readSummaryRows } from "../src/tickets/ticket-reads.js";
import type { TicketScope } from "../src/tickets/ticket-scope.js";
import { loadBigProject, PERF_ORG } from "../scripts/big-project/load.js";
import { planBigProject } from "../scripts/big-project/plan.js";
import type { BigProjectPlan } from "../scripts/big-project/plan.js";
import { OWNER_URL, ownerPoolWithCleanup } from "./helpers.js";

// Oráculo independente (TREEPM-254): a regra de progresso e de raiz de ideia existe em DOIS lugares, no domínio (em memória:
// `ticketProgress`, `ideaRootsOf`) e em SQL (`ticket-reads.ts`, `idea-root.ts`, `project-query.service.ts`). Este teste carrega projetos
// gerados com ideia dentro de ideia, ideia no topo e cancelado dentro de ideia e compara, ticket a ticket, o SQL com o cálculo em
// memória sobre as MESMAS linhas. Não há referência gravada: se uma das duas regras mudar sozinha, o teste falha. O lugar na fila (ADR
// 0068, seção 4) também, pelos dois caminhos SQL: a lista (`readSummaryRows`) e o ramo de um ticket (`readBranchOf`), contra `queuePlaces`.
const pool: pg.Pool = ownerPoolWithCleanup();
let owner: PrismaClient;
const queries = new ProjectQueryService(new AuthorizationService(), { now: () => Date.now() }) as unknown as {
  ideasOf(tx: unknown, scope: TicketScope, ids: string[]): Promise<Map<string, { kind: string; stage?: string; rootNumber?: number }>>;
};
const NOW = Date.UTC(2026, 10, 22, 12);

beforeAll(() => {
  owner = createPrismaClient(OWNER_URL);
});
afterAll(async () => {
  await owner.$disconnect();
  await pool.end();
});

type Row = { id: string; parent_id: string | null; status: TicketNode["status"]; idea_stage: string | null; number: number };

async function readTree(): Promise<Row[]> {
  return (await pool.query<Row>("select id, parent_id, status, idea_stage, number from tickets order by number")).rows;
}

const nodes = (rows: Row[]): TicketNode[] => rows.map((row) => ({ id: row.id, parentId: row.parent_id, status: row.status, ideaStage: row.idea_stage as TicketNode["ideaStage"] }));

/** Mais dependências, das duas espécies, sempre para um ticket de número menor (nunca há ciclo): cadeias para "próximo" e "esperando". */
async function moreDependencies(): Promise<void> {
  await pool.query(`
    insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind, need)
    select a.org_id, a.project_id, a.id, b.id, 'depends_on', case when a.number % 3 = 0 then 'deliver' else 'start' end
    from tickets a join tickets b on b.project_id = a.project_id and b.number = a.number - 1 - (a.number % 7)
    where a.number % 2 = 0
    on conflict do nothing`);
}

async function comparePlaces(plan: BigProjectPlan, rows: Row[], memory: TicketNode[], label: string): Promise<Record<string, number>> {
  const edges = (await pool.query<{ from_ticket_id: string; to_ticket_id: string; need: DependencyEdge["need"] }>("select from_ticket_id, to_ticket_id, need from ticket_relations where kind = 'depends_on'")).rows.map(
    (row): DependencyEdge => ({ from: row.from_ticket_id, to: row.to_ticket_id, need: row.need }),
  );
  const expected = queuePlaces(memory, edges);
  const sql = new Map((await owner.$transaction((tx) => readSummaryRows(tx as never, plan.projectId))).map((row) => [row.id, row.place ?? null] as const));
  const seen: Record<string, number> = {};
  // O caso da revisão 1: dependência para começar aberta num alvo sem lugar na fila (pai ou ideia) faz esperar. O gerador o produz.
  const placeless = new Set(rows.filter((row) => !expected.has(row.id) && row.status !== "done" && row.status !== "cancelled").map((row) => row.id));
  seen["onPlaceless"] = edges.filter((edge) => edge.need === "start" && placeless.has(edge.to) && expected.has(edge.from)).length;
  for (const row of rows) {
    const got = sql.get(row.id) ?? null;
    expect(got, `${label}: lugar na fila de ${row.number}`).toBe(expected.get(row.id) ?? null);
    seen[got ?? "null"] = (seen[got ?? "null"] ?? 0) + 1;
  }
  // O ramo de uns poucos ids (a leitura do detalhe e do get_ticket) dá o mesmo que a lista do projeto inteiro.
  const sample = rows.filter((_, i) => i % 13 === 0).map((row) => row.id);
  const scope: TicketScope = { orgId: PERF_ORG, projectId: plan.projectId };
  const some = await owner.$transaction((tx) => readBranchOf(tx as never, scope, sample));
  expect(some.size, `${label}: amostra`).toBe(sample.length);
  for (const id of sample) expect(some.get(id)?.place ?? null, `${label}: amostra ${id}`).toBe(sql.get(id) ?? null);
  return seen;
}

async function compare(plan: BigProjectPlan, label: string): Promise<{ withProgress: number; inIdea: number; roots: number; places: Record<string, number> }> {
  const rows = await readTree();
  const memory = nodes(rows);
  const expectedProgress = ticketProgress(memory);
  const expectedRoots = ideaRootsOf(memory);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const scope: TicketScope = { orgId: PERF_ORG, projectId: plan.projectId };
  const ids = rows.map((row) => row.id);
  const branches = await owner.$transaction((tx) => readBranchOf(tx as never, scope, ids));
  const ideaMap = await owner.$transaction((tx) => queries.ideasOf(tx, scope, ids));
  let withProgress = 0;
  for (const row of rows) {
    const branch = branches.get(row.id);
    expect(branch, `${label}: sem ramo para ${row.number}`).toBeDefined();
    const wanted: TicketProgress | null = expectedProgress.get(row.id) ?? null;
    expect(branch!.progress, `${label}: progresso de ${row.number}`).toEqual(wanted);
    if (wanted) withProgress += 1;
    const rootId = expectedRoots.get(row.id) ?? null;
    expect(branch!.ideaRoot?.id ?? null, `${label}: raiz de ideia de ${row.number}`).toBe(rootId);
    if (rootId) {
      const root = byId.get(rootId)!;
      expect(branch!.ideaRoot).toEqual({ id: rootId, number: root.number, stage: root.idea_stage });
      expect(ideaMap.get(row.id), `${label}: ideasOf ${row.number}`).toEqual(rootId === row.id ? { kind: "root", stage: root.idea_stage } : { kind: "inside", rootNumber: root.number });
    } else {
      expect(ideaMap.has(row.id), `${label}: ideasOf ${row.number} fora de ideia`).toBe(false);
    }
  }
  // A função de um ticket só (usada nas escritas) também concorda, numa amostra.
  for (const row of rows.filter((_, i) => i % 11 === 0)) {
    const one = await owner.$transaction((tx) => ideaRootOfTicket(tx as never, scope, row.id));
    expect(one?.id ?? null, `${label}: ideaRootOfTicket ${row.number}`).toBe(expectedRoots.get(row.id) ?? null);
  }
  const places = await comparePlaces(plan, rows, memory, label);
  return { withProgress, inIdea: expectedRoots.size, roots: rows.filter((row) => row.idea_stage !== null).length, places };
}

const loaded = async (options: Partial<Parameters<typeof planBigProject>[0]>, n = 1200, seed = 3): Promise<BigProjectPlan> => {
  const plan = planBigProject({ n, seed, key: "BG", now: NOW, nestedIdeas: true, topIdeas: true, closedInIdeas: true, ...options });
  await loadBigProject(pool, plan);
  await moreDependencies();
  return plan;
};

describe("SQL × domínio em memória: mesmas respostas, sem referência gravada", () => {
  it.each([3, 11, 13])("projeto gerado com ideias aninhadas, no topo e cancelados dentro (semente %i)", async (seed) => {
    const plan = await loaded({}, 1200, seed);
    const seen = await compare(plan, `semente ${seed}`);
    expect(seen.withProgress).toBeGreaterThan(100);
    // Os três lugares (e o nulo) aparecem de fato.
    for (const place of ["free", "next", "waiting", "null", "onPlaceless"]) expect(seen.places[place] ?? 0, `lugar ${place}`).toBeGreaterThan(5);
    expect(seen.inIdea).toBeGreaterThan(20);
    // O gerador de fato produziu os casos que importam.
    const rows = await readTree();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const stageOf = (id: string): string | null => byId.get(id)?.idea_stage ?? null;
    const hasRootAbove = (row: Row): boolean => {
      for (let cursor = row.parent_id; cursor !== null; cursor = byId.get(cursor)?.parent_id ?? null) if (stageOf(cursor) !== null) return true;
      return false;
    };
    const roots = rows.filter((row) => row.idea_stage !== null);
    expect(roots.some((row) => row.parent_id === null), "ideia no topo").toBe(true);
    expect(roots.some(hasRootAbove), "ideia dentro de ideia").toBe(true);
    expect(rows.some((row) => row.status === "cancelled" && row.idea_stage === null && (hasRootAbove(row))), "cancelado dentro de ideia").toBe(true);
  });

  it("projeto das sementes de sempre (sem as opções): também concorda", async () => {
    const plan = await loaded({ nestedIdeas: false, topIdeas: false, closedInIdeas: false }, 1200, 7);
    await compare(plan, "padrão");
  });

  it("sobre dados fora das regras do produto (concluído e em andamento dentro de ideia): as duas regras ainda concordam", async () => {
    const plan = await loaded({}, 900, 5);
    // O SQL e a função pura são definidos para qualquer árvore; aqui a árvore é embaralhada de propósito, só onde o banco deixa.
    await pool.query(`
      update tickets set status = (array['todo','in_progress','in_review','done','cancelled'])[1 + (abs(hashtext(id::text)) % 5)]
      where idea_stage is null and agent_work_until is null and number % 3 <> 0`);
    const seen = await compare(plan, "embaralhado");
    expect(seen.withProgress).toBeGreaterThan(50);
  });
});
