import { mixIndicatorColorCounts, mixIndicatorColors } from "@treepm/react";
import { describe, expect, it } from "vitest";
import type { TicketSummary } from "../api/client.js";
import { makeMe, makeProject, makeTicket } from "../test/fakes.js";
import { randomTickets } from "../test/randomTree.js";
import { buildMapItems, paintBranches } from "./items.js";
import type { MapNode } from "./items.js";
import { hasOpenDescendants } from "./ticketState.js";

const org = makeMe().organization;
const project = makeProject("p", "ALFA", "Alfa");
const isInIdea = (ticket: Pick<TicketSummary, "idea">) => ticket.idea !== null && ticket.idea !== undefined;

/** A implementação de antes (quadrática), guardada aqui como referência de equivalência. */
function paintBranchesReference(nodes: readonly MapNode[]): readonly MapNode[] {
  const childrenOf = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const descendants = (node: MapNode): MapNode[] => (childrenOf.get(node.id) ?? []).flatMap((child) => [child, ...descendants(child)]);
  return nodes.map((node) => {
    if (!node.ticket || isInIdea(node.ticket) || !hasOpenDescendants(node.ticket)) return node;
    const found = descendants(node).filter((entry) => entry.ticket !== null && !isInIdea(entry.ticket));
    if (found.length === 0) return node;
    return { ...node, leafCount: found.length, color: mixIndicatorColors(found.map((entry) => ({ color: entry.color, weight: 1 }))) };
  });
}

/** Os nós antes da pintura (cor própria de cada situação), como `buildMapItems` os monta. */
function unpainted(tickets: TicketSummary[]): MapNode[] {
  return buildMapItems(org, [project], { p: tickets.map((ticket) => ({ ...ticket, progress: null })) }).map((node) => ({ ...node }));
}
function withProgress(tickets: TicketSummary[]): MapNode[] {
  const base = unpainted(tickets);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return base.map((node) => (node.ticket ? { ...node, ticket: byId.get(node.id)! } : node));
}

describe("paintBranches: same result as the quadratic version", () => {
  const cases: [string, number, number, Parameters<typeof randomTickets>[3]?][] = [];
  for (let seed = 1; seed <= 30; seed += 1) cases.push([`random tree, seed ${seed}`, 40 + seed * 17, seed]);
  for (let seed = 1; seed <= 4; seed += 1) cases.push([`deep chains, seed ${seed}`, 300, seed, { chain: 0.97 }]);
  cases.push(["only ideas", 80, 5, { ideas: 0.9 }], ["no ideas", 200, 6, { ideas: 0 }], ["everything done", 200, 7, { done: 1, ideas: 0 }], ["almost nothing done", 200, 8, { done: 0, ideas: 0.02 }]);
  for (const [label, count, seed, options] of cases) {
    it(label, () => {
      const nodes = withProgress(randomTickets(count, seed, "p", options));
      const expected = paintBranchesReference(nodes);
      const actual = paintBranches(nodes);
      expect(actual.map((node) => [node.id, node.color, node.leafCount])).toEqual(expected.map((node) => [node.id, node.color, node.leafCount]));
      expect(actual).toEqual(expected);
      // Quem não muda continua sendo o mesmo objeto.
      actual.forEach((node, position) => expect(node === nodes[position]).toBe(expected[position] === nodes[position]));
    });
  }

  it("empty tree", () => {
    expect(paintBranches([])).toEqual([]);
  });

  it("a branch whose descendants are all concluded keeps its own color", () => {
    const tickets = [makeTicket("a", "p", 1, "A", { status: "in_progress", progress: { done: 2, total: 2, excluded: 0 } }), makeTicket("b", "p", 2, "B", { parentId: "a", status: "done" }), makeTicket("c", "p", 3, "C", { parentId: "b", status: "done" })];
    const nodes = withProgress(tickets);
    expect(paintBranches(nodes)).toEqual(paintBranchesReference(nodes));
    expect(paintBranches(nodes).find((node) => node.id === "a")!.color).toBe(nodes.find((node) => node.id === "a")!.color);
  });

  it("a deep chain (400 levels) matches", () => {
    const tickets: TicketSummary[] = [];
    const depth = 400;
    for (let at = 0; at < depth; at += 1) {
      tickets.push(makeTicket(`c${at}`, "p", at + 1, `C${at}`, { parentId: at === 0 ? null : `c${at - 1}`, status: at % 3 === 0 ? "done" : at % 3 === 1 ? "in_progress" : "in_review", progress: at === depth - 1 ? null : { done: 0, total: depth - at - 1, excluded: 0 } }));
    }
    const nodes = withProgress(tickets);
    expect(paintBranches(nodes).map((node) => node.color)).toEqual(paintBranchesReference(nodes).map((node) => node.color));
  });

  it("same result as buildMapItems did, byte for byte, on a large tree (20 colors of rounding edge: many mixes)", () => {
    const nodes = withProgress(randomTickets(4000, 99, "p", { chain: 0.4, ideas: 0.03 }));
    expect(paintBranches(nodes)).toEqual(paintBranchesReference(nodes));
  });
});

describe("paintBranches: linear cost", () => {
  /** Conta quantas vezes cada nó é lido (`id`): a versão quadrática relê o nó a cada ancestral aberto. */
  function chainWithReadCounter(depth: number) {
    let reads = 0;
    const nodes = withProgress(Array.from({ length: depth }, (_, at) => makeTicket(`c${at}`, "p", at + 1, `C${at}`, { parentId: at === 0 ? null : `c${at - 1}`, status: at % 2 === 0 ? "todo" : "in_progress", progress: at === depth - 1 ? null : { done: 0, total: depth - at - 1, excluded: 0 } })));
    const counted = nodes.map((node) => Object.defineProperty({ ...node }, "id", { get: () => { reads += 1; return node.id; }, enumerable: true }));
    return { nodes: counted as MapNode[], reads: () => reads };
  }
  it("reads each node a constant number of times, whatever the depth", () => {
    const small = chainWithReadCounter(200);
    paintBranches(small.nodes);
    const large = chainWithReadCounter(800);
    paintBranches(large.nodes);
    expect(small.reads()).toBeLessThan(200 * 12);
    expect(large.reads()).toBeLessThan(800 * 12);
    // Quadruplicar os nós quadruplica as leituras (a versão quadrática as multiplicava por ~16).
    expect(large.reads() / small.reads()).toBeLessThan(4.5);
  });
});

describe("mixIndicatorColorCounts: same string as mixIndicatorColors for equal weights", () => {
  const palette = ["#8b92a3", "#6ea8ff", "#e7b450", "#4fc48c", "#ffffff", "#000000", "#e879c6"];
  it("matches the expanded mix on thousands of random multisets, including large counts", () => {
    let state = 12345;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let round = 0; round < 3000; round += 1) {
      const counts = new Map<string, number>();
      const kinds = 1 + Math.floor(random() * palette.length);
      for (let k = 0; k < kinds; k += 1) counts.set(palette[Math.floor(random() * palette.length)]!, 1 + Math.floor(random() * (round % 10 === 0 ? 4000 : 12)));
      const expanded = [...counts].flatMap(([color, count]) => Array.from({ length: count }, () => ({ color, weight: 1 })));
      expect(mixIndicatorColorCounts(counts)).toBe(mixIndicatorColors(expanded));
    }
  });
  it("a single color returns that color", () => {
    expect(mixIndicatorColorCounts(new Map([["#4fc48c", 5000]]))).toBe("#4fc48c");
  });
  it("refuses an empty count and an unsupported color, like the original", () => {
    expect(() => mixIndicatorColorCounts(new Map())).toThrow();
    expect(() => mixIndicatorColorCounts(new Map([["red", 1], ["#ffffff", 1]]))).toThrow();
  });
});
