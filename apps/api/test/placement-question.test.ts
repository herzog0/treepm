import { describe, expect, it } from "vitest";
import { buildQuestion, commonAncestor, forkOf } from "../src/assistant/placement-question.js";
import type { QuestionNode } from "../src/assistant/placement-question.js";

const nodes: QuestionNode[] = [
  { id: "A", parentId: null, number: 1, title: "A" },
  { id: "A1", parentId: "A", number: 2, title: "A1" },
  { id: "A1a", parentId: "A1", number: 3, title: "A1a" },
  { id: "B", parentId: null, number: 4, title: "B" },
  { id: "B1", parentId: "B", number: 5, title: "B1" },
];
const byId = new Map(nodes.map((n) => [n.id, n]));

describe("buildQuestion (ADR 0054, item 2)", () => {
  const base = { byId, projectName: "Projeto", choice: null, unjudged: [] as string[] };
  it("até três opções em ordem de probabilidade, com caminho; na raiz o nó da pergunta é o projeto", () => {
    const q = buildQuestion({ ...base, doubt: { level: 1, parentId: null, kind: "root" }, stepCandidates: [{ ticketId: "B", probability: 0.1 }, { ticketId: "A", probability: 0.7 }] });
    expect(q).toMatchObject({ level: 1, kind: "root", at: { id: null, title: "Projeto", path: [] } });
    expect(q.options.map((o) => [o.id, o.probability])).toEqual([["A", 0.7], ["B", 0.1]]);
    expect(Object.keys(q).sort()).toEqual(["at", "kind", "level", "options"]);
  });
  it("no máximo três", () => {
    const many = ["A", "B", "A1", "B1", "A1a"].map((ticketId, i) => ({ ticketId, probability: 0.5 - i * 0.1 }));
    expect(buildQuestion({ ...base, doubt: { level: 1, parentId: null, kind: "fit" }, stepCandidates: many }).options.map((o) => o.id)).toEqual(["A", "B", "A1"]);
  });
  it("interrupted sem julgamento usa os filhos sem probabilidade; related usa a escolha, mesmo com uma opção só", () => {
    expect(buildQuestion({ ...base, doubt: { level: 2, parentId: "A", kind: "interrupted" }, stepCandidates: [], unjudged: ["A1"] }).options).toEqual([{ id: "A1", title: "A1", path: [{ id: "A", title: "A" }, { id: "A1", title: "A1" }], probability: null }]);
    const q = buildQuestion({ ...base, doubt: { level: 1, parentId: null, kind: "related" }, stepCandidates: [], choice: { options: [{ id: "B1", probability: 0.4 }, { id: "A1", probability: 0.3 }], top: 0.4, descentId: null } });
    expect(q.options.map((o) => [o.id, o.probability])).toEqual([["B1", 0.4], ["A1", 0.3]]);
    expect(q.at.path).toEqual([]);
    expect(buildQuestion({ ...base, doubt: { level: 1, parentId: null, kind: "related" }, stepCandidates: [], choice: { options: [{ id: "B1", probability: 0.4 }], top: 0.4, descentId: null } }).options).toHaveLength(1);
  });
  it("forkOf: o nó em que os caminhos se separam (inclusive um deles, se o outro está dentro)", () => {
    expect(forkOf("A1", "B1", byId)).toBeNull();
    expect(forkOf("A1", "A", byId)).toBe("A");
    expect(forkOf("A1a", "A", byId)).toBe("A");
    expect(forkOf("A1a", "A1", byId)).toBe("A1");
    expect(forkOf("A1", "A1", byId)).toBe("A1");
    expect(forkOf(null, "B", byId)).toBeNull();
  });
  it("commonAncestor: o nó mais fundo que é ancestral estrito de todos", () => {
    expect(commonAncestor(["A1", "B1"], byId)).toBeNull();
    expect(commonAncestor(["A1", "A1a"], byId)).toBe("A");
    expect(commonAncestor(["A1a"], byId)).toBe("A1");
  });
});
