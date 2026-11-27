import { explodedTree } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { dependencyEdges } from "../map/items.js";
import { generatedTickets } from "./generatedProject.js";

const tree = (count: number, chain: number) => {
  const tickets = generatedTickets(count, chain);
  const nodes = tickets.map((ticket) => ({ id: ticket.id, parentId: ticket.parentId, status: ticket.status, number: ticket.number, priority: 0 }));
  return explodedTree(nodes, dependencyEdges(tickets), null);
};

describe("generatedTickets", () => {
  it("80 tickets com uma corrente de 16 passos: ao menos 16 colunas", () => {
    const result = tree(80, 16);
    expect(result.nodes.length).toBeGreaterThan(60);
    expect(result.columns).toBeGreaterThanOrEqual(16);
  });
  it("500 tickets dão uma árvore inteira, sem ciclo", () => {
    const result = tree(500, 24);
    expect(result.nodes.length).toBeGreaterThan(400);
    expect(result.rows).toBeGreaterThan(10);
  });
});
