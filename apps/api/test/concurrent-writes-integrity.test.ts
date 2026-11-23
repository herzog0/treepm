import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBigProject } from "../scripts/big-project/load.js";
import { planBigProject } from "../scripts/big-project/plan.js";
import { checkIntegrity, checkTreeShape, compareListWithDatabase } from "../scripts/concurrent-writes/integrity.js";
import { ownerPoolWithCleanup } from "./helpers.js";

// A conferência de integridade da medição de escrita concorrente tem de pegar o que ela procura (TREEPM-249).
describe("forma da árvore (pura)", () => {
  const row = (id: string, parent: string | null) => ({ id, parent_id: parent });
  it("árvore sã: nada a reportar", () => {
    expect(checkTreeShape([row("a", null), row("b", "a"), row("c", "b"), row("d", null)])).toEqual({ cycle: [], selfParent: [], orphan: [] });
  });
  it("ciclo de dois, de três, auto-pai e quem desce de um ciclo", () => {
    const shape = checkTreeShape([row("a", "b"), row("b", "a"), row("x", "y"), row("y", "z"), row("z", "x"), row("s", "s"), row("filho", "a"), row("ok", null)]);
    expect(new Set(shape.cycle)).toEqual(new Set(["a", "b", "x", "y", "z", "s", "filho"]));
    expect(shape.selfParent).toEqual(["s"]);
  });
  it("órfão: pai que não existe", () => {
    expect(checkTreeShape([row("a", "fantasma"), row("b", "a")]).orphan).toEqual(["a"]);
  });
});

const pool = ownerPoolWithCleanup();
afterAll(() => pool.end());

describe("conferência no banco", () => {
  let projectId = "";
  beforeAll(async () => {
    const plan = planBigProject({ n: 300, seed: 3, key: "BG", now: Date.UTC(2026, 10, 23) });
    await loadBigProject(pool, plan);
    projectId = plan.projectId;
  });

  it("projeto recém-carregado: íntegro", async () => {
    const report = await checkIntegrity(pool, projectId);
    expect(report).toMatchObject({ ok: true, tickets: 300 });
  });

  it("pega um ciclo plantado (com o gatilho do banco desligado só para plantar)", async () => {
    const { rows } = await pool.query<{ id: string; parent_id: string }>("select id, parent_id from tickets where project_id = $1 and parent_id is not null limit 1", [projectId]);
    const child = rows[0]!;
    await pool.query("alter table tickets disable trigger tickets_no_parent_cycle");
    try {
      await pool.query("update tickets set parent_id = $1 where id = $2", [child.id, child.parent_id]);
      const report = await checkIntegrity(pool, projectId);
      expect(report.ok).toBe(false);
      expect(report.shape.cycle).toEqual(expect.arrayContaining([child.id, child.parent_id]));
    } finally {
      await pool.query("update tickets set parent_id = null where id = $1", [child.parent_id]);
      await pool.query("alter table tickets enable trigger tickets_no_parent_cycle");
    }
  });

  it("pega concluído com filho aberto", async () => {
    const parent = (await pool.query<{ id: string }>("select p.id from tickets p join tickets c on c.parent_id = p.id where p.project_id = $1 and c.status = 'todo' and p.status <> 'done' limit 1", [projectId])).rows[0]!;
    await pool.query("update tickets set status = 'done' where id = $1", [parent.id]);
    const report = await checkIntegrity(pool, projectId);
    expect(report.doneWithOpenChild).toContain(parent.id);
    expect(report.ok).toBe(false);
  });

  it("lista da API diferente do banco aparece nas diferenças", async () => {
    const rows = (await pool.query<{ id: string; parent_id: string | null; title: string; status: string; priority: number; number: number }>("select id, parent_id, title, status, priority, number from tickets where project_id = $1", [projectId])).rows;
    const asListed = rows.map((r) => ({ id: r.id, parentId: r.parent_id, title: r.title, status: r.status, priority: r.priority, number: r.number, assigneeIds: [] as string[] }));
    const assignees = (await pool.query<{ ticket_id: string; person_id: string }>("select ticket_id, person_id from ticket_assignees")).rows;
    for (const a of assignees) asListed.find((t) => t.id === a.ticket_id)?.assigneeIds.push(a.person_id);
    expect(await compareListWithDatabase(pool, projectId, asListed)).toEqual([]);
    const broken = asListed.map((t, i) => (i === 0 ? { ...t, title: "outro" } : t)).slice(0, -1);
    const diffs = await compareListWithDatabase(pool, projectId, broken);
    // contagem, título trocado e o ticket que sumiu da lista
    expect(diffs).toHaveLength(3);
  });
});
