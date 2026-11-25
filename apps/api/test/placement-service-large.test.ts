import { describe, expect, it } from "vitest";
import { buildJudgeRequest, judgeInputFits } from "../src/assistant/jev-branch-judge.js";
import { PlacementService } from "../src/assistant/placement.service.js";
import type { PlacementSnapshot, TreeTicket } from "../src/assistant/placement.service.js";
import type { BranchJudge } from "../src/assistant/ports.js";

// ADR 0052, revisão 1, ponto 4: um nível com 60 candidatos de texto cheio decide em vez de parar por tamanho.
let number = 0;
const ticket = (id: string, parentId: string | null, title: string, description = ""): TreeTicket => ({ id, parentId, number: ++number, title, description, status: "todo" });
const tickets: TreeTicket[] = [];
for (let i = 0; i < 60; i++) {
  tickets.push(ticket(`g${i}`, null, `Agrupador ${i}`, `Descrição do agrupador ${i}. `.repeat(12)));
  for (let k = 0; k < 30; k++) tickets.push(ticket(`g${i}k${k}`, `g${i}`, `Filho número ${k} do agrupador ${i}`));
}
const snapshot: PlacementSnapshot = { projectId: "p", tickets, notes: new Map() };
const draft = { title: "Algo novo", description: "Algo novo no sistema", children: [] };

const judge = (seen: { sizes: number[] }): BranchJudge => ({
  async judge(input) {
    seen.sizes.push(JSON.stringify(buildJudgeRequest(input).request).length);
    return { belongs: 0.9, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.9 : 0.1 / Math.max(input.candidates.length - 1, 1)])) };
  },
});

describe("procura com 60 candidatos de texto cheio", () => {
  it("o texto cheio não cabe, mas a procura encolhe os descendentes de todos na mesma proporção e decide", async () => {
    const service = new PlacementService();
    const seen = { sizes: [] as number[] };
    const outcome = await service.search(draft, snapshot, { judge: judge(seen) });
    expect(outcome.stoppedEarly).toBeNull();
    expect(outcome.trace.steps[0]?.result).toBe("descended");
    expect(outcome.trace.steps[0]?.candidates).toHaveLength(60);
    expect(seen.sizes.length).toBeGreaterThan(0);
    // O que chegou ao juiz coube (e foi o nível raiz com os 60).
    const captured: unknown[] = [];
    await service.search(draft, snapshot, { judge: { async judge(input) { captured.push(input); expect(judgeInputFits(input)).toBe(true); return { belongs: 0.9, choice: { [input.candidates[0]!.id]: 0.9 } }; } } });
    expect(captured.length).toBeGreaterThan(0);
  });
});
