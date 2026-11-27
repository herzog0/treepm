import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import { DetailCard } from "./DetailCard.js";
import type { MapNode } from "./items.js";

// ADR 0069: o card mais detalhado também traz os três números do pai e a marca do habilitador.
const nodeOf = (ticket: ReturnType<typeof makeTicket>, extra: Partial<MapNode> = {}): MapNode => ({ id: ticket.id, parentId: "p", kind: "ticket", label: ticket.title, color: "#8b92a3", key: ticket.key, ticket, leafCount: 1, ...extra });

describe("detail card (ADR 0069)", () => {
  it("shows the three numbers of a parent, keeping the idea count", () => {
    const ticket = makeTicket("t", "p", 1, "Pai", { status: "in_progress", progress: { done: 1, total: 4, excluded: 0, ideas: 1 } });
    const card = render(<DetailCard node={nodeOf(ticket, { counts: { tickets: 4, done: 1, free: 2 } })} childCount={2} />).container;
    expect(card).toHaveTextContent("4 tickets · 1 pronto · 2 livres · 1 ideia");
    // "n itens" (só os filhos diretos) ao lado de "4 tickets" (a subárvore) seriam dois números para a mesma pergunta.
    expect(card.querySelector(".node-detail-count")).toBeNull();
  });

  it("marks the enabler", () => {
    const card = render(<DetailCard node={nodeOf(makeTicket("c", "p", 2, "Casca"), { enabler: true })} childCount={0} />).container;
    expect(card).toHaveTextContent("Abre os irmãos");
  });
});
