import { describe, expect, it } from "vitest";
import { createsDependencyCycle } from "./dependencies.js";

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
