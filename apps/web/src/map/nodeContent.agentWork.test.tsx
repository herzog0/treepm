import { act, render } from "@testing-library/react";
import type { SpatialNodeContent } from "@treepm/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTicket } from "../test/fakes.js";
import { DetailCard } from "./DetailCard.js";
import { MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
import { buildMapItems } from "./items.js";
import type { MapNode } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";

/** ADR 0043: o contorno do ticket em trabalho pela IA. Quem desenha o movimento é o CSS (`agent-work.css`, suíte de navegador); aqui, a marca no card. */
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ticketNode = (agentWork: { since: string; until: string; note: string | null } | null | undefined): MapNode => {
  const ticket = makeTicket("t1", "alfa", 3, "Publicar", agentWork === undefined ? {} : { agentWork });
  return { id: ticket.id, parentId: "alfa", kind: "ticket", label: ticket.title, color: "#6ea8ff", key: ticket.key, ticket, leafCount: 1 };
};
const valid = { since: "2026-11-22T11:30:00.000Z", until: "2026-11-22T12:30:00.000Z", note: null };
const lods = ["dot", "chip", "compact", "full"] as const;

function content(node: MapNode, lod: SpatialNodeContent<MapNode>["lod"]) {
  return render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 0, descendantCount: 0 })}</>).container;
}
const marker = (container: HTMLElement) => container.querySelector(".node-agent-work");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("agent-work marker on the map card", () => {
  it.each(lods)("marks the card at the %s level while the marker is valid", (lod) => {
    expect(marker(content(ticketNode(valid), lod))).not.toBeNull();
  });

  it.each(lods)("marks nothing at the %s level without a marker or with an absent field", (lod) => {
    expect(marker(content(ticketNode(null), lod))).toBeNull();
    expect(marker(content(ticketNode(undefined), lod))).toBeNull();
  });

  it("does not mark a card whose marker has already expired", () => {
    expect(marker(content(ticketNode({ ...valid, until: "2026-11-22T11:59:59.000Z" }), "full"))).toBeNull();
  });

  it("removes the mark when `until` passes, without any new fetch or render from outside", () => {
    const container = content(ticketNode(valid), "compact");
    expect(marker(container)).not.toBeNull();
    act(() => vi.advanceTimersByTime(29 * 60_000));
    expect(marker(container)).not.toBeNull();
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(marker(container)).toBeNull();
  });

  it("says 'em trabalho pela IA' to a screen reader on the card", () => {
    expect(marker(content(ticketNode(valid), "full"))).toHaveTextContent("Em trabalho pela IA");
  });

  it("does not mark the parent because a child is being worked on", () => {
    const parent = makeTicket("p1", "alfa", 1, "Pai", { status: "in_progress" });
    const child = makeTicket("c1", "alfa", 2, "Filho", { parentId: "p1", status: "in_progress", agentWork: valid });
    const org = { orgId: "org", name: "Equipe", slug: "e" };
    const project = { id: "alfa", name: "Alfa", key: "ALFA", visibility: "organization" as const, archivedAt: null, members: [], teamIds: [] };
    const items = buildMapItems(org, [project], { alfa: [parent, child] });
    const byId = new Map(items.map((node) => [node.id, node]));
    for (const lod of lods) {
      expect(marker(content(byId.get("p1")!, lod))).toBeNull();
      expect(marker(content(byId.get("c1")!, lod))).not.toBeNull();
    }
  });

  it("is a different thing from the dashed draft card", () => {
    const draft: MapNode = { id: "assistant-draft", parentId: "alfa", kind: "draft", label: "Novo", color: "#a99bff", key: "Novo", ticket: null, leafCount: 1 };
    const container = content(draft, "full");
    expect(container.querySelector(".node-draft")).not.toBeNull();
    expect(marker(container)).toBeNull();
    expect(marker(content(ticketNode(valid), "full"))?.closest(".node-draft")).toBeNull();
  });

  it("marks the detail card too", () => {
    const node = ticketNode(valid);
    const { container } = render(
      <MapDetailProvider data={buildDetailData([node], [])} store={createMapScaleStore()}>
        <DetailCard node={node} childCount={0} />
      </MapDetailProvider>,
    );
    expect(marker(container)).not.toBeNull();
  });
});
