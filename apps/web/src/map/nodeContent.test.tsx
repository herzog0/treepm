import { render } from "@testing-library/react";
import type { SpatialNodeContent } from "@treepm/react";
import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import type { MapNode } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";

const ticketNode = (ticket = makeTicket("t1", "alfa", 3, "Publicar")): MapNode => ({
  id: ticket.id,
  parentId: "alfa",
  kind: "ticket",
  label: ticket.title,
  color: "#8b92a3",
  key: ticket.key,
  ticket,
  leafCount: 1,
});
const projectNode: MapNode = { id: "alfa", parentId: "org", kind: "project", label: "Projeto Alfa", color: "#a99bff", key: "ALFA", ticket: null, leafCount: 1 };
const orgNode: MapNode = { id: "org", parentId: null, kind: "organization", label: "Equipe Alfa", color: "#a99bff", key: null, ticket: null, leafCount: 1 };

function content(node: MapNode, lod: SpatialNodeContent<MapNode>["lod"], extra: Partial<SpatialNodeContent<MapNode>> = {}) {
  const { container } = render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 0, descendantCount: 0, ...extra })}</>);
  return container;
}
const marks = (container: HTMLElement) => container.querySelectorAll("[data-state]");

describe("renderNodeContent", () => {
  it("renders nothing for the dot level", () => {
    expect(content(ticketNode(), "dot")).toBeEmptyDOMElement();
  });

  it("full: key, title and the mark with the status name", () => {
    const container = content(ticketNode(makeTicket("t1", "alfa", 3, "Publicar", { status: "in_review" })), "full");
    expect(container).toHaveTextContent("ALFA-3");
    expect(container).toHaveTextContent("Publicar");
    expect(container).toHaveTextContent("Em revisão");
    expect(marks(container)).toHaveLength(1);
    expect(marks(container)[0]).toHaveAttribute("data-state", "in_review");
  });

  it("full: a ticket with children shows 'N de M concluídos' with the progress mark", () => {
    const ticket = makeTicket("t1", "alfa", 3, "Pai", { status: null, progress: { done: 3, total: 8, excluded: 0 } });
    const container = content(ticketNode(ticket), "full");
    expect(container).toHaveTextContent("3 de 8 concluídos");
    expect(marks(container)[0]).toHaveAttribute("data-state", "progress");
  });

  it("compact: key, title and the mark, without the status text", () => {
    const container = content(ticketNode(makeTicket("t1", "alfa", 3, "Publicar", { status: "done" })), "compact");
    expect(container).toHaveTextContent("ALFA-3");
    expect(container).toHaveTextContent("Publicar");
    expect(container).not.toHaveTextContent("Concluído");
    expect(marks(container)).toHaveLength(1);
  });

  it("chip: mark and title, no key", () => {
    const container = content(ticketNode(), "chip");
    expect(container).toHaveTextContent("Publicar");
    expect(container).not.toHaveTextContent("ALFA-3");
    expect(marks(container)).toHaveLength(1);
  });

  it("every mark is decorative", () => {
    for (const lod of ["full", "compact", "chip"] as const) {
      for (const element of marks(content(ticketNode(), lod))) expect(element).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("keeps the project and organization content as before, without a status mark", () => {
    const project = content(projectNode, "full");
    expect(project).toHaveTextContent("ALFA");
    expect(project).toHaveTextContent("Projeto Alfa");
    expect(marks(project)).toHaveLength(0);
    const organization = content(orgNode, "full", { childCount: 2 });
    expect(organization).toHaveTextContent("Organização");
    expect(organization).toHaveTextContent("2 projetos");
  });

  it("shows the aggregate count when the node stands for its collapsed branch", () => {
    expect(content(projectNode, "compact", { aggregate: true, descendantCount: 7 })).toHaveTextContent("7 itens");
  });

  it("uses the singular for a single aggregated item or project", () => {
    const count = (container: HTMLElement) => container.querySelector(".spatial-aggregate-count")?.textContent;
    expect(count(content(projectNode, "compact", { aggregate: true, descendantCount: 1 }))).toBe("1 item");
    expect(count(content(orgNode, "compact", { aggregate: true, descendantCount: 1, childCount: 1 }))).toBe("1 projeto");
    expect(content(orgNode, "full", { childCount: 1 })).toHaveTextContent("1 projeto");
  });
});

describe("renderNodeContent for the assistant draft", () => {
  const draftNode: MapNode = { id: "assistant-draft", parentId: "t1", kind: "draft", label: "Corrigir o login", color: "#a99bff", key: "Novo", ticket: null, leafCount: 1 };

  it("full: marks the card as a draft that is not created yet, without a status mark", () => {
    const container = content(draftNode, "full");
    expect(container).toHaveTextContent("Novo");
    expect(container).toHaveTextContent("Corrigir o login");
    expect(container).toHaveTextContent("Ainda não criado");
    expect(container.querySelector(".node-draft")).not.toBeNull();
    expect(marks(container)).toHaveLength(0);
  });

  it("compact and chip keep the draft marker so the dashed style can apply", () => {
    expect(content(draftNode, "compact").querySelector(".node-draft")).not.toBeNull();
    expect(content(draftNode, "chip").querySelector(".node-draft")).not.toBeNull();
  });
});
