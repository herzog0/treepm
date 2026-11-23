import { createPrismaClient } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/access/authorization.service.js";
import { ProjectQueryService } from "../src/query/project-query.service.js";
import { ideaRootOfTicket } from "../src/tickets/idea-root.js";
import { readBranchOf, readProgressOf } from "../src/tickets/ticket-reads.js";
import type { TicketScope } from "../src/tickets/ticket-scope.js";
import { AgentWorkService } from "../src/tickets/agent-work.service.js";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { OWNER_URL, ownerPoolWithCleanup, truncateAll } from "./helpers.js";

// Isolamento das consultas recursivas (TREEPM-253), pelo papel DONO, que ignora o RLS: com o RLS fora do caminho, só o filtro
// explícito de `org_id`/`project_id` em cada passo impede de atravessar de uma organização para outra. As duas organizações têm
// tickets de MESMO `id` (a chave primária é `(org_id, id)`) e até o mesmo `project_id`, com formas diferentes: o que a função
// devolve para A não pode trazer nada de B.
const pool: pg.Pool = ownerPoolWithCleanup();
let owner: PrismaClient;
const A = "org_iso_a";
const B = "org_iso_b";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ROOT, MID, LEAF, SIBLING] = [id(1), id(2), id(3), id(4)];
const scopeA: TicketScope = { orgId: A, projectId: PROJECT };
const scopeB: TicketScope = { orgId: B, projectId: PROJECT };
const tickets = new TicketsService({} as never, {} as never, {} as never, { now: () => Date.now() });
const queries = new ProjectQueryService(new AuthorizationService(), { now: () => Date.now() }) as unknown as {
  ideasOf(tx: unknown, scope: TicketScope, ids: string[]): Promise<Map<string, unknown>>;
  ancestors(tx: unknown, scope: TicketScope, parentId: string): Promise<{ title: string }[]>;
};

async function seedOrg(org: string, rows: { id: string; number: number; parent: string | null; status?: string; stage?: string | null; title?: string }[]): Promise<void> {
  await pool.query("insert into organizations (org_id, name, slug) values ($1,$1,$1)", [org]);
  const person = (await pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,$2,'P',$3,'admin') returning id", [org, `u_${org}`, `${org}@x.test`])).rows[0]!.id;
  await pool.query("insert into projects (org_id, id, name, key, visibility, next_ticket_number) values ($1,$2,'P','ISO','organization',100)", [org, PROJECT]);
  for (const row of rows) {
    await pool.query(
      "insert into tickets (org_id, id, project_id, number, parent_id, title, description, status, idea_stage, created_by_person_id) values ($1,$2,$3,$4,$5,$6,'',$7,$8,$9)",
      [org, row.id, PROJECT, row.number, row.parent, row.title ?? `T${row.number}`, row.status ?? "todo", row.stage ?? null, person],
    );
  }
}

beforeAll(() => {
  owner = createPrismaClient(OWNER_URL);
});
afterAll(async () => {
  await owner.$disconnect();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  // A: raiz → meio → folha (+ irmã da folha), nada de ideia, tudo `todo`/`done`.
  await seedOrg(A, [
    { id: ROOT, number: 1, parent: null, title: "A-raiz" },
    { id: MID, number: 2, parent: ROOT, title: "A-meio" },
    { id: LEAF, number: 3, parent: MID, status: "done", title: "A-folha" },
    { id: SIBLING, number: 4, parent: MID, title: "A-irmã" },
  ]);
  // B: os MESMOS ids, mas a raiz é uma ideia e a folha está cancelada; B tem ainda um filho a mais.
  await seedOrg(B, [
    { id: ROOT, number: 1, parent: null, stage: "ready", title: "B-raiz" },
    { id: MID, number: 2, parent: ROOT, title: "B-meio" },
    { id: LEAF, number: 3, parent: MID, status: "cancelled", title: "B-folha" },
    { id: SIBLING, number: 4, parent: MID, title: "B-irmã" },
    { id: id(5), number: 5, parent: LEAF, title: "B-neta" },
  ]);
});

const tx = <T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> => owner.$transaction(async (client) => fn(client as unknown as PrismaClient));

describe("papel dono (sem RLS), dois tenants com tickets de mesmo id: a consulta não atravessa", () => {
  it("raiz de ideia: em A a folha não está em ideia; em B está, sob a raiz de B", async () => {
    expect(await tx((c) => ideaRootOfTicket(c, scopeA, LEAF))).toBeNull();
    expect(await tx((c) => ideaRootOfTicket(c, scopeB, LEAF))).toEqual({ id: ROOT, number: 1, stage: "ready" });
  });

  it("raiz de ideia: um escopo com a organização errada não enxerga o ticket", async () => {
    expect(await tx((c) => ideaRootOfTicket(c, { orgId: "org_inexistente", projectId: PROJECT }, LEAF))).toBeNull();
    expect(await tx((c) => ideaRootOfTicket(c, { orgId: A, projectId: "22222222-2222-4222-8222-222222222222" }, LEAF))).toBeNull();
  });

  it("ramo e progresso: A conta só os tickets de A; B, só os de B", async () => {
    const a = await tx((c) => readBranchOf(c, scopeA, [ROOT, MID, LEAF]));
    expect(a.get(ROOT)).toEqual({ progress: { done: 1, total: 3, excluded: 0, ideas: 0 }, ideaRoot: null, prioritySource: null });
    expect(a.get(MID)).toEqual({ progress: { done: 1, total: 2, excluded: 0, ideas: 0 }, ideaRoot: null, prioritySource: null });
    expect(a.get(LEAF)).toEqual({ progress: null, ideaRoot: null, prioritySource: null });
    const b = await tx((c) => readBranchOf(c, scopeB, [ROOT, MID, LEAF]));
    expect(b.get(ROOT)).toEqual({ progress: { done: 0, total: 0, excluded: 0, ideas: 0 }, ideaRoot: { id: ROOT, number: 1, stage: "ready" }, prioritySource: null });
    expect(b.get(MID)?.ideaRoot).toEqual({ id: ROOT, number: 1, stage: "ready" });
    expect(b.get(LEAF)?.progress).toEqual({ done: 0, total: 0, excluded: 0, ideas: 0 });
    expect([...(await tx((c) => readProgressOf(c, scopeA, [LEAF]))).keys()]).toEqual([]);
  });

  it("cadeia de pais e situações dos descendentes", async () => {
    expect([...(await tx((c) => tickets.ancestorLinks(c, { orgId: A, id: PROJECT }, LEAF))).entries()]).toEqual([[LEAF, MID], [MID, ROOT], [ROOT, null]]);
    expect(await tx((c) => tickets.descendantStatuses(c, { orgId: A, id: PROJECT }, ROOT))).toHaveLength(3);
    expect((await tx((c) => tickets.descendantStatuses(c, { orgId: A, id: PROJECT }, ROOT))).sort()).toEqual(["done", "todo", "todo"]);
    expect((await tx((c) => tickets.descendantStatuses(c, { orgId: B, id: PROJECT }, ROOT))).sort()).toEqual(["cancelled", "todo", "todo", "todo"]);
  });

  it("situação de ideia em lote (MCP): a ideia de B não aparece em A", async () => {
    expect([...(await tx((c) => queries.ideasOf(c, scopeA, [LEAF, MID]))).keys()]).toEqual([]);
    const inB = await tx((c) => queries.ideasOf(c, scopeB, [LEAF, MID, ROOT]));
    expect([...inB.keys()].sort()).toEqual([LEAF, MID, ROOT].sort());
    expect(inB.get(ROOT)).toEqual({ kind: "root", stage: "ready" });
    expect(inB.get(LEAF)).toEqual({ kind: "inside", rootNumber: 1 });
  });

  it("caminho de ancestrais do MCP: só os de A", async () => {
    const path = await tx((c) => queries.ancestors(c, scopeA, MID));
    expect(path.map((row) => row.title)).toEqual(["A-raiz", "A-meio"]);
  });

  it("trava de subárvore: trava as linhas de A e deixa as de B", async () => {
    await owner.$transaction(async (client) => {
      await tickets.lockSubtree(client as never, { orgId: A, id: PROJECT }, ROOT);
      const probe = await pool.connect();
      try {
        await probe.query("begin");
        const lockedA = await probe.query("select id from tickets where org_id = $1 order by number for update skip locked", [A]);
        expect(lockedA.rows).toHaveLength(0);
        const freeB = await probe.query("select id from tickets where org_id = $1 order by number for update skip locked", [B]);
        expect(freeB.rows).toHaveLength(5);
      } finally {
        await probe.query("rollback");
        probe.release();
      }
    });
  });

  it("marcador de trabalho da subárvore: só os tickets de A", async () => {
    const calls: string[][] = [];
    const agent = Object.create(AgentWorkService.prototype) as { clearSubtree(tx: unknown, principal: unknown, project: { orgId: string; id: string; key: string }, rootId: string, reason: string): Promise<void>; clearMarkers: unknown };
    (agent as { clearMarkers: unknown }).clearMarkers = async (_tx: unknown, _p: unknown, _key: string, ids: string[]) => void calls.push(ids);
    await tx((c) => agent.clearSubtree(c, {}, { orgId: A, id: PROJECT, key: "ISO" }, ROOT, "idea"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sort()).toEqual([ROOT, MID, LEAF, SIBLING].sort());
    calls.length = 0;
    await tx((c) => agent.clearSubtree(c, {}, { orgId: B, id: PROJECT, key: "ISO" }, ROOT, "idea"));
    expect(calls[0]!).toHaveLength(5);
  });

  it("controle: sem o filtro de organização a mesma consulta atravessaria (o teste enxerga o defeito)", async () => {
    const rows = await pool.query<{ org_id: string }>(
      "with recursive up as (select org_id, id, parent_id, 1 as depth from tickets where org_id = $1 and id = $2 union all select t.org_id, t.id, t.parent_id, up.depth + 1 from tickets t join up on t.id = up.parent_id where up.depth < 10) select org_id from up",
      [A, LEAF],
    );
    expect(new Set(rows.rows.map((row) => row.org_id))).toEqual(new Set([A, B]));
  });
});
