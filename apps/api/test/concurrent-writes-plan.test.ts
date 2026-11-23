import { describe, expect, it } from "vitest";
import { planBigProject } from "../scripts/big-project/plan.js";
import { buildPools, createWriterPlan, importItems, insideIdea, MIXES, SCENARIOS, writerLeaves } from "../scripts/concurrent-writes/plan.js";
import type { Op, Scenario } from "../scripts/concurrent-writes/plan.js";
import { codeOf, percentile, summarize } from "../scripts/concurrent-writes/stats.js";

// Planejamento das escritas concorrentes (TREEPM-249): puro, sem banco, determinístico pela semente.
const plan = planBigProject({ n: 2000, seed: 7, key: "BG", now: Date.UTC(2026, 10, 23), people: 80 });
const pools = buildPools(plan);
const take = (scenario: Scenario, writer: number, writers: number, count: number, seed = 7): Op[] => {
  const next = createWriterPlan({ plan, pools, scenario, writer, writers, seed });
  return Array.from({ length: count }, () => next());
};

describe("plano das escritas concorrentes", () => {
  it("mesma entrada, mesma sequência; outro escritor ou outra semente, outra sequência", () => {
    expect(take("mixed", 3, 16, 200)).toEqual(take("mixed", 3, 16, 200));
    expect(take("mixed", 3, 16, 200)).not.toEqual(take("mixed", 4, 16, 200));
    expect(take("mixed", 3, 16, 200)).not.toEqual(take("mixed", 3, 16, 200, 8));
  });

  it("as folhas dos escritores são disjuntas (fora do cenário branch) e todas válidas", () => {
    const idea = insideIdea(plan);
    const seen = new Set<number>();
    for (let w = 0; w < 16; w += 1) {
      for (const leaf of writerLeaves({ pools, scenario: "edits", writer: w, writers: 16 })) {
        expect(seen.has(leaf)).toBe(false);
        seen.add(leaf);
        const t = plan.tickets[leaf]!;
        expect(t.status).toBe("todo");
        expect(idea[leaf]).toBe(false);
        expect(t.agentWork).toBeNull();
        expect(plan.tickets.some((c) => c.parent === leaf)).toBe(false);
      }
    }
  });

  it("só folhas se movem e o destino nunca é folha do conjunto: nenhuma sequência fecha ciclo", () => {
    const leaves = new Set(pools.leaves);
    for (const scenario of ["structure", "mixed", "branch"] as const) {
      for (let w = 0; w < 8; w += 1) {
        for (const op of take(scenario, w, 8, 400)) {
          if (op.kind === "move") {
            expect(leaves.has(op.ticket)).toBe(true);
            expect(leaves.has(op.parent)).toBe(false);
            expect(pools.inner).toContain(op.parent);
          }
          if (op.kind === "create" && op.parent !== null) expect(pools.inner).toContain(op.parent);
        }
      }
    }
  });

  it("a mistura segue os pesos de cada cenário e só usa as operações dele", () => {
    for (const scenario of SCENARIOS) {
      const ops = take(scenario, 0, 4, 4000);
      const kinds = new Set(Object.keys(MIXES[scenario]));
      const total = Object.values(MIXES[scenario]).reduce((a, b) => a + b, 0);
      for (const op of ops) expect(kinds.has(op.kind)).toBe(true);
      for (const [kind, weight] of Object.entries(MIXES[scenario])) {
        const share = ops.filter((op) => op.kind === kind).length / ops.length;
        expect(share).toBeGreaterThan(weight / total - 0.05);
        expect(share).toBeLessThan(weight / total + 0.05);
      }
    }
  });

  it("situação e pessoa alternam em folha própria: nunca pedem o valor que o ticket já tem", () => {
    const state = new Map<number, string>();
    const assigned = new Set(plan.tickets.flatMap((t) => t.assignees.map((p) => `${t.index}:${p}`)));
    for (const op of take("edits", 2, 8, 1000)) {
      if (op.kind === "status") {
        expect(op.status).not.toBe(state.get(op.ticket) ?? "todo");
        state.set(op.ticket, op.status);
      }
      if (op.kind === "assignee") {
        const id = `${op.ticket}:${op.person}`;
        expect(op.add).toBe(!assigned.has(id));
        if (op.add) assigned.add(id);
        else assigned.delete(id);
      }
    }
  });

  it("o ramo do cenário branch é um só e as folhas e pais dele ficam dentro dele", () => {
    const inside = (i: number): boolean => {
      for (let c: number | null = i; c !== null; c = plan.tickets[c]!.parent) if (c === pools.branch.root) return true;
      return false;
    };
    expect(pools.branch.leaves.length).toBeGreaterThan(20);
    expect(pools.branch.leaves.every(inside)).toBe(true);
    expect(pools.branch.inner.every(inside)).toBe(true);
    expect(writerLeaves({ pools, scenario: "branch", writer: 0, writers: 4 })).toEqual(writerLeaves({ pools, scenario: "branch", writer: 3, writers: 4 }));
  });

  it("a importação tem 500 itens", () => {
    const count = (items: { children?: unknown[] }[]): number => items.reduce((sum, i) => sum + 1 + count((i.children ?? []) as { children?: unknown[] }[]), 0);
    expect(count(importItems("x"))).toBe(500);
  });
});

describe("estatística", () => {
  it("percentis e contagem por código", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 50), percentile(xs, 95), percentile(xs, 99), percentile([], 50)]).toEqual([50, 95, 99, null]);
    const s = summarize([{ ms: 10, code: "2xx" }, { ms: 30, code: "2xx" }, { ms: 20, code: "409 structure_busy" }], 2);
    expect(s).toMatchObject({ count: 3, okCount: 2, throughput: 1, codes: { "2xx": 2, "409 structure_busy": 1 } });
    expect(codeOf(409, '{"code":"concurrent_update"}')).toBe("409 concurrent_update");
    expect(codeOf(429, "")).toBe("429");
    expect(codeOf(503, "")).toBe("5xx");
    expect(codeOf(201, "")).toBe("2xx");
  });
});
