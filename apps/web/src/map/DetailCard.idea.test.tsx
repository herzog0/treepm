import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import { DetailCard } from "./DetailCard.js";
import type { MapNode } from "./items.js";

const nodeOf = (ticket: ReturnType<typeof makeTicket>): MapNode => ({ id: ticket.id, parentId: "p", kind: "ticket", label: ticket.title, color: "#8b92a3", key: ticket.key, ticket, leafCount: 1 });
const text = (ticket: ReturnType<typeof makeTicket>) => render(<DetailCard node={nodeOf(ticket)} childCount={2} />).container;

describe("detail card with ideas (ADR 0042)", () => {
  it("appends ' · n ideia(s)' to the progress of a plain parent, in the most detailed level", () => {
    const one = text(makeTicket("t", "p", 1, "Pai", { progress: { done: 1, total: 4, excluded: 0, ideas: 1 } }));
    expect(one).toHaveTextContent("1 de 4 concluídos · 1 ideia");
    const many = text(makeTicket("t", "p", 1, "Pai", { progress: { done: 1, total: 4, excluded: 0, ideas: 3 } }));
    expect(many).toHaveTextContent("1 de 4 concluídos · 3 ideias");
  });

  it("a parent with only ideas below shows its own status and the idea count", () => {
    const card = text(makeTicket("t", "p", 1, "Pai", { status: "done", progress: { done: 0, total: 0, excluded: 0, ideas: 2 } }));
    expect(card).toHaveTextContent("Concluído · 2 ideias");
  });

  it("shows the idea root and the ticket inside as in the other levels", () => {
    expect(text(makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage: "ready" } }))).toHaveTextContent("Ideia · Pronta para triagem");
    expect(text(makeTicket("a", "p", 2, "Dentro", { idea: { root: false, rootId: "i", rootKey: "P-1" } }))).toHaveTextContent(/Ideia$/);
  });

  it("does not change a parent without ideas", () => {
    expect(text(makeTicket("t", "p", 1, "Pai", { progress: { done: 1, total: 4, excluded: 0 } }))).not.toHaveTextContent("ideia");
  });
});
