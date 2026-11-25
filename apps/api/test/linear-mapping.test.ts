import { describe, expect, it } from "vitest";
import { mapLinearIssue, mapLinearIssuePage } from "../src/linear/linear-mapping.js";
import type { LinearIssueNode } from "../src/linear/ports.js";

const node = (over: Partial<LinearIssueNode> = {}): LinearIssueNode => ({ id: "i1", identifier: "ENG-1", url: "https://linear.app/a/issue/ENG-1", title: "Título", description: null, priority: 2, updatedAt: "2026-01-01T00:00:00Z", trashed: false, stateType: "started", parentId: null, projectId: null, assignee: null, ...over });

describe("L9 item 1: o mapeamento de uma issue é pura função e rápido", () => {
  const inputs: Record<string, string> = {
    "300 KB de ` _a` numa linha": " _a".repeat(100_000),
    "300 KB de JSON minificado com _id": `{${'"_id":"x",'.repeat(25_000)}"z":1}`,
    "400 KB de `ENG-45 `": "ENG-45 ".repeat(60_000),
  };
  for (const [name, description] of Object.entries(inputs)) {
    it(`${name}: o mapeamento inteiro leva menos de 50 ms`, () => {
      mapLinearIssue(node({ description: "aquece" }), "ENG");
      const started = performance.now();
      const mapped = mapLinearIssue(node({ description }), "ENG");
      expect(performance.now() - started).toBeLessThan(50);
      expect(mapped.description.length).toBeLessThanOrEqual(20_000);
    });
  }
  it("a página mapeia só o que será gravado (lixeira fora, repetida uma vez)", () => {
    const mapped = mapLinearIssuePage([node(), node({ id: "i2", trashed: true }), node()], "ENG");
    expect([...mapped.keys()]).toEqual(["i1"]);
  });
});
