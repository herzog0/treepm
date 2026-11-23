import { mentionedKeys } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { planBigProject } from "../scripts/big-project/plan.js";
import type { BigProjectPlan } from "../scripts/big-project/plan.js";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const plan = (n: number, seed = 7): BigProjectPlan => planBigProject({ n, seed, key: "BG", now: NOW });

const depthHistogram = (p: BigProjectPlan): number[] => {
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const t of p.tickets) out[t.depth] = (out[t.depth] ?? 0) + 1;
  return out;
};

describe("planejamento do projeto grande (determinístico, por semente)", () => {
  it("a mesma semente gera exatamente o mesmo projeto; outra semente gera outro", () => {
    expect(JSON.stringify(plan(300))).toBe(JSON.stringify(plan(300)));
    expect(JSON.stringify(plan(300, 8))).not.toBe(JSON.stringify(plan(300)));
  });

  it("tem N tickets, números de 1 a N e o pai sempre criado antes do filho", () => {
    const p = plan(1000);
    expect(p.tickets).toHaveLength(1000);
    p.tickets.forEach((t, i) => {
      expect(t.number).toBe(i + 1);
      if (t.parent !== null) expect(t.parent).toBeLessThan(i);
    });
    expect(new Set(p.tickets.map((t) => t.id)).size).toBe(1000);
  });

  it("árvore realista: profundidade de 4 a 7, larguras variadas e raízes em número razoável", () => {
    for (const n of [1000, 5000]) {
      const p = plan(n);
      const histogram = depthHistogram(p);
      const maxDepth = Math.max(...p.tickets.map((t) => t.depth));
      expect(maxDepth).toBeGreaterThanOrEqual(5);
      expect(maxDepth).toBeLessThanOrEqual(7);
      expect(histogram.slice(1, 5).every((count) => count > 0)).toBe(true);
      const children = new Map<number, number>();
      for (const t of p.tickets) if (t.parent !== null) children.set(t.parent, (children.get(t.parent) ?? 0) + 1);
      const widths = [...children.values()];
      expect(Math.max(...widths)).toBeGreaterThan(8);
      expect(Math.max(...widths)).toBeLessThanOrEqual(80);
      expect(Math.min(...widths)).toBe(1);
      expect(histogram[1]).toBeGreaterThanOrEqual(5);
    }
  });

  it("cerca de 15% concluídos, algumas ideias, alguns marcadores de trabalho pela IA", () => {
    const p = plan(5000);
    const done = p.tickets.filter((t) => t.status === "done").length / 5000;
    expect(done).toBeGreaterThan(0.13);
    expect(done).toBeLessThan(0.18);
    expect(p.tickets.filter((t) => t.ideaStage !== null).length).toBeGreaterThanOrEqual(10);
    expect(p.tickets.filter((t) => t.agentWork !== null).length).toBeGreaterThanOrEqual(5);
  });

  it("respeita as invariantes do produto: nada concluído com filho aberto; ideia e o que está dentro dela em a fazer e sem marcador", () => {
    const p = plan(5000);
    const open = (status: string) => status !== "done" && status !== "cancelled";
    const insideIdea = new Set<number>();
    for (const t of p.tickets) {
      if (t.ideaStage !== null || (t.parent !== null && insideIdea.has(t.parent))) insideIdea.add(t.index);
    }
    for (const t of p.tickets) {
      if (t.status === "done" && t.parent !== null) continue;
      if (t.parent !== null && p.tickets[t.parent]!.status === "done") expect(open(t.status), `filho aberto sob concluído: ${t.number}`).toBe(false);
      if (insideIdea.has(t.index)) {
        expect(t.status).toBe("todo");
        expect(t.agentWork).toBeNull();
      }
      if (t.agentWork !== null) expect(open(t.status)).toBe(true);
    }
    // Filho de pai concluído, em qualquer posição, também está encerrado.
    for (const t of p.tickets) {
      if (t.parent !== null && p.tickets[t.parent]!.status === "done") expect(open(t.status)).toBe(false);
    }
  });

  it("descrições de tamanhos variados, com menções que a regra do produto reconhece, e ligações coerentes com elas", () => {
    const p = plan(2000);
    const sizes = p.tickets.map((t) => t.description.length);
    expect(Math.min(...sizes)).toBe(0);
    expect(Math.max(...sizes)).toBeGreaterThan(3000);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20_000);
    const withMentions = p.tickets.filter((t) => mentionedKeys(t.description).some((key) => key.startsWith("BG-")));
    expect(withMentions.length).toBeGreaterThan(100);
    const mentions = p.relations.filter((r) => r.kind === "mentions");
    expect(mentions.length).toBeGreaterThan(100);
    for (const r of p.relations) expect(r.from).not.toBe(r.to);
    // `depends_on` só aponta para ticket mais antigo, então nunca há ciclo.
    for (const r of p.relations.filter((x) => x.kind === "depends_on")) expect(r.to).toBeLessThan(r.from);
  });

  it("comentários, eventos de histórico, áreas e contribuições em parte dos tickets, mais um ticket de muito histórico", () => {
    const p = plan(2000);
    expect(p.comments.length).toBeGreaterThan(100);
    expect(p.events.length).toBeGreaterThan(2000);
    expect(p.contributions.length).toBeGreaterThan(50);
    expect(p.areas.length).toBeGreaterThanOrEqual(5);
    const history = p.fixtures.history;
    expect(p.events.filter((e) => e.ticket === history).length).toBeGreaterThanOrEqual(1000);
    expect(p.comments.filter((c) => c.ticket === history).length).toBeGreaterThanOrEqual(300);
    for (const c of p.comments) expect(c.body.length).toBeGreaterThan(0);
  });

  it("fixtures: folha funda sob cadeia concluída, folha funda comum, raso, ideia e os dois pais do mover", () => {
    const p = plan(1000);
    const f = p.fixtures;
    const t = (i: number) => p.tickets[i]!;
    expect(t(f.doneLeaf).depth).toBe(7);
    expect(f.doneChain).toHaveLength(7);
    for (const i of f.doneChain) expect(t(i).status).toBe("done");
    expect(t(f.doneLeaf).parent).toBe(f.doneChain[5]);
    expect(t(f.deep).depth).toBeGreaterThanOrEqual(6);
    expect(t(f.shallow).depth).toBe(1);
    expect(t(f.idea).ideaStage).not.toBeNull();
    expect(t(f.move).status).toBe("todo");
    expect(t(f.move).parent).toBe(f.moveFrom);
    expect(f.moveTo).not.toBe(f.moveFrom);
    expect(t(f.moveTo).ideaStage).toBeNull();
    expect(["todo", "in_progress", "in_review"]).toContain(t(f.moveTo).status);
  });

  describe("variedade de ideias por opção (oráculo de equivalência, TREEPM-254)", () => {
    const rich = (n = 2000, seed = 3): BigProjectPlan => planBigProject({ n, seed, key: "BG", now: NOW, nestedIdeas: true, topIdeas: true, closedInIdeas: true });
    const ancestorsOf = (p: BigProjectPlan, index: number): number[] => {
      const out: number[] = [];
      for (let cursor = p.tickets[index]!.parent; cursor !== null; cursor = p.tickets[cursor]!.parent) out.push(cursor);
      return out;
    };

    it("com as opções desligadas, o plano é exatamente o de sempre (as referências gravadas dependem disso)", () => {
      for (const seed of [3, 7]) {
        const off = planBigProject({ n: 400, seed, key: "BG", now: NOW, nestedIdeas: false, topIdeas: false, closedInIdeas: false });
        const plain = plan(400, seed);
        expect(JSON.stringify(off.tickets)).toBe(JSON.stringify(plain.tickets));
        expect(JSON.stringify(off.fixtures)).toBe(JSON.stringify(plain.fixtures));
        expect(JSON.stringify(off.relations)).toBe(JSON.stringify(plain.relations));
        expect(JSON.stringify(off.events)).toBe(JSON.stringify(plain.events));
      }
    });

    it("é determinístico e gera ideia dentro de ideia, ideia no topo e cancelado dentro de ideia", () => {
      expect(JSON.stringify(rich())).toBe(JSON.stringify(rich()));
      const p = rich();
      const roots = p.tickets.filter((t) => t.ideaStage !== null);
      expect(roots.some((t) => t.parent === null)).toBe(true);
      expect(roots.some((t) => ancestorsOf(p, t.index).some((a) => p.tickets[a]!.ideaStage !== null))).toBe(true);
      const insideIdea = (index: number): boolean => p.tickets[index]!.ideaStage !== null || ancestorsOf(p, index).some((a) => p.tickets[a]!.ideaStage !== null);
      expect(p.tickets.some((t) => t.status === "cancelled" && t.ideaStage === null && insideIdea(t.index))).toBe(true);
    });

    it("respeita as regras: dentro de ideia só a fazer ou cancelado (nunca concluído), a raiz a fazer, sem marcador", () => {
      for (const seed of [3, 11, 19]) {
        const p = rich(1500, seed);
        for (const t of p.tickets) {
          const inside = t.ideaStage !== null || ancestorsOf(p, t.index).some((a) => p.tickets[a]!.ideaStage !== null);
          if (!inside) continue;
          expect(["todo", "cancelled"], `ticket ${t.number} dentro de ideia`).toContain(t.status);
          if (t.ideaStage !== null) expect(t.status).toBe("todo");
          expect(t.agentWork).toBeNull();
        }
        for (const t of p.tickets) if (t.agentWork !== null) expect(["todo", "in_progress", "in_review"]).toContain(t.status);
        for (const t of p.tickets) if (t.parent !== null && p.tickets[t.parent]!.status === "done") expect(["done", "cancelled"]).toContain(t.status);
      }
    });
  });
});
