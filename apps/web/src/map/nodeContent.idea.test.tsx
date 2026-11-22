import { render } from "@testing-library/react";
import type { SpatialNodeContent } from "@treepm/react";
import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import type { MapNode } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";

const nodeOf = (ticket: ReturnType<typeof makeTicket>): MapNode => ({ id: ticket.id, parentId: "p", kind: "ticket", label: ticket.title, color: "#e879c6", key: ticket.key, ticket, leafCount: 1 });
function content(ticket: ReturnType<typeof makeTicket>, lod: SpatialNodeContent<MapNode>["lod"]) {
  const node = nodeOf(ticket);
  const { container } = render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 0, descendantCount: 0 })}</>);
  return container;
}
const marks = (container: HTMLElement) => [...container.querySelectorAll("[data-state]")].map((mark) => mark.getAttribute("data-state"));

describe("idea marks on the map cards (ADR 0042)", () => {
  const stages = [
    ["new", "Nova"],
    ["refining", "Em refinamento"],
    ["ready", "Pronta para triagem"],
  ] as const;

  it.each(stages)("the idea root in stage %s reads 'Ideia · %s' at the full level, with the idea mark", (stage, name) => {
    const ticket = makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage } });
    const full = content(ticket, "full");
    expect(full).toHaveTextContent(`Ideia · ${name}`);
    expect(marks(full)).toEqual(["idea"]);
  });

  it("the discarded idea root reads 'Ideia · Descartada' with the muted idea mark", () => {
    const full = content(makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage: "discarded" } }), "full");
    expect(full).toHaveTextContent("Ideia · Descartada");
    expect(marks(full)).toEqual(["idea-discarded"]);
  });

  it("a ticket inside an idea reads 'Ideia' with the idea mark, whatever its status", () => {
    const ticket = makeTicket("a", "p", 2, "Dentro", { status: "done", idea: { root: false, rootId: "i", rootKey: "P-1" } });
    const full = content(ticket, "full");
    expect(full).toHaveTextContent(/Ideia$/);
    expect(full).not.toHaveTextContent("Concluído");
    expect(marks(full)).toEqual(["idea"]);
  });

  it("a ticket inside a discarded idea shows the muted mark", () => {
    const ticket = makeTicket("a", "p", 2, "Dentro", { idea: { root: false, rootId: "i", rootKey: "P-1" } });
    const node = { ...nodeOf(ticket), ideaDiscarded: true };
    const { container } = render(<>{renderNodeContent({ node, label: node.label, lod: "compact", aggregate: false, depth: 1, childCount: 0, descendantCount: 0 })}</>);
    expect(marks(container)).toEqual(["idea-discarded"]);
  });

  it("chip and compact show the idea mark and no stage text; the dot shows nothing", () => {
    const ticket = makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage: "refining" } });
    for (const lod of ["chip", "compact"] as const) {
      const container = content(ticket, lod);
      expect(marks(container)).toEqual(["idea"]);
      expect(container).not.toHaveTextContent("Em refinamento");
    }
    expect(content(ticket, "dot")).toBeEmptyDOMElement();
  });

  it("a plain parent keeps its usual progress and gets no idea text at the full level", () => {
    const parent = makeTicket("t", "p", 1, "Pai", { status: "in_progress", progress: { done: 1, total: 4, excluded: 0, ideas: 2 } });
    const full = content(parent, "full");
    expect(full).toHaveTextContent("1 de 4 concluídos");
    expect(full).not.toHaveTextContent("ideia");
    expect(marks(full)).toEqual(["progress"]);
  });
});
