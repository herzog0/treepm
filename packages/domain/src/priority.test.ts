import { describe, expect, it } from "vitest";
import { PRIORITY_MAX, PRIORITY_MIN, effectivePriorities, effectivePriority, isValidPriority } from "./priority.js";
import type { PriorityNode } from "./priority.js";

const p = (id: string, parentId: string | null, priority = 0): PriorityNode => ({ id, parentId, priority });

describe("isValidPriority", () => {
  it("aceita inteiros de -999 a 999, o zero e os negativos", () => {
    for (const value of [0, 1, -1, 5, 999, -999]) expect(isValidPriority(value)).toBe(true);
    expect([PRIORITY_MIN, PRIORITY_MAX]).toEqual([-999, 999]);
  });
  it("recusa fora do intervalo, fracionário e não numérico", () => {
    for (const value of [1000, -1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isValidPriority(value)).toBe(false);
  });
});

describe("effectivePriority", () => {
  it("a própria, quando diferente de 0 (e diz que veio dela)", () => {
    const tree = [p("a", null, 5), p("b", "a", 2)];
    expect(effectivePriority(tree, "b")).toEqual({ value: 2, fromId: "b" });
  });
  it("0 herda a do ancestral mais próximo diferente de 0, de vários níveis acima", () => {
    const tree = [p("a", null, 7), p("b", "a", 0), p("c", "b", 3), p("d", "c", 0), p("e", "d", 0)];
    expect(effectivePriority(tree, "e")).toEqual({ value: 3, fromId: "c" });
    expect(effectivePriority(tree, "b")).toEqual({ value: 7, fromId: "a" });
  });
  it("negativo também é uma prioridade própria e é herdado", () => {
    const tree = [p("a", null, -4), p("b", "a")];
    expect(effectivePriority(tree, "b")).toEqual({ value: -4, fromId: "a" });
  });
  it("sem nenhum diferente de 0 na cadeia, vale 0 e não vem de ticket nenhum", () => {
    const tree = [p("a", null), p("b", "a")];
    expect(effectivePriority(tree, "b")).toEqual({ value: 0, fromId: null });
  });
  it("ticket desconhecido vale 0", () => {
    expect(effectivePriority([p("a", null, 3)], "zzz")).toEqual({ value: 0, fromId: null });
  });
  it("não trava em pai que forma ciclo (dado inconsistente)", () => {
    const tree = [p("a", "b"), p("b", "a")];
    expect(effectivePriority(tree, "a")).toEqual({ value: 0, fromId: null });
  });
  it("effectivePriorities dá o mesmo que effectivePriority para cada ticket, em árvores geradas", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 30; round += 1) {
      const nodes: PriorityNode[] = [];
      const size = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < size; i += 1) {
        const parent = i === 0 || rand() < 0.15 ? null : `t${Math.floor(rand() * i)}`;
        const priority = rand() < 0.5 ? 0 : Math.floor(rand() * 21) - 10;
        nodes.push(p(`t${i}`, parent, priority));
      }
      const all = effectivePriorities(nodes);
      for (const node of nodes) {
        // Oráculo: sobe de pai em pai, sem memória.
        let cursor: PriorityNode | undefined = node;
        let expected = { value: 0, fromId: null as string | null };
        while (cursor) {
          if (cursor.priority !== 0) {
            expected = { value: cursor.priority, fromId: cursor.id };
            break;
          }
          cursor = nodes.find((other) => other.id === cursor?.parentId);
        }
        expect(all.get(node.id)).toEqual(expected);
        expect(effectivePriority(nodes, node.id)).toEqual(expected);
      }
    }
  });
});
