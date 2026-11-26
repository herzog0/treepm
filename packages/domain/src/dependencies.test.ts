import { describe, expect, it } from "vitest";
import { DependencyGraph, createsDependencyCycle } from "./dependencies.js";

type Edge = readonly [from: string, to: string];

describe("createsDependencyCycle", () => {
  it("is false on an empty graph", () => {
    expect(createsDependencyCycle([], "A", "B")).toBe(false);
  });

  it("is true when a ticket would depend on itself", () => {
    expect(createsDependencyCycle([], "A", "A")).toBe(true);
  });

  it("is true for a direct cycle (the reverse edge already exists)", () => {
    expect(createsDependencyCycle([["B", "A"]], "A", "B")).toBe(true);
  });

  it("follows a chain: A→B→C→D already, so D→A closes it", () => {
    const edges: Edge[] = [["A", "B"], ["B", "C"], ["C", "D"]];
    expect(createsDependencyCycle(edges, "D", "A")).toBe(true);
    expect(createsDependencyCycle(edges, "A", "D")).toBe(false);
  });

  it("a diamond is not a cycle", () => {
    const edges: Edge[] = [["A", "B"], ["A", "C"], ["B", "D"]];
    expect(createsDependencyCycle(edges, "C", "D")).toBe(false);
  });

  it("a cycle of three", () => {
    const edges: Edge[] = [["A", "B"], ["B", "C"]];
    expect(createsDependencyCycle(edges, "C", "A")).toBe(true);
  });

  it("is false for an edge that already exists", () => {
    expect(createsDependencyCycle([["A", "B"]], "A", "B")).toBe(false);
  });

  it("terminates on a graph that already has a cycle elsewhere", () => {
    const edges: Edge[] = [["X", "Y"], ["Y", "X"]];
    expect(createsDependencyCycle(edges, "A", "B")).toBe(false);
  });
});

describe("DependencyGraph (incremental: um mapa por página, não um por ligação)", () => {
  it("dá o mesmo que createsDependencyCycle e acompanha as ligações acrescentadas", () => {
    const graph = new DependencyGraph([["b", "a"], ["c", "b"]]);
    expect(graph.wouldCycle("a", "c")).toBe(true);
    expect(graph.wouldCycle("a", "a")).toBe(true);
    expect(graph.wouldCycle("d", "c")).toBe(false);
    graph.add("d", "c");
    expect(graph.wouldCycle("a", "d")).toBe(true);
    // Repetida não muda nada (o banco guarda uma por par).
    graph.add("d", "c");
    expect(graph.wouldCycle("c", "d")).toBe(true);
    expect(graph.wouldCycle("e", "d")).toBe(false);
  });

  it("20 mil ligações e mil conferências seguidas cabem com folga", () => {
    const edges: [string, string][] = [];
    for (let i = 0; i < 2000; i += 1) for (let k = 1; k <= 10; k += 1) if (i - k >= 0) edges.push([`t${i}`, `t${i - k}`]);
    const graph = new DependencyGraph(edges);
    const t0 = Date.now();
    for (let i = 0; i < 1000; i += 1) {
      const [from, to] = [`t${(i * 7) % 2000}`, `t${(i * 13) % 2000}`];
      if (!graph.wouldCycle(from, to)) graph.add(from, to);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
