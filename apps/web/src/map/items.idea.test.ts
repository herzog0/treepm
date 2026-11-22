import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { makeTicket } from "../test/fakes.js";
import { ACCENT_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS, buildMapItems } from "./items.js";

const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project: Project = { id: "p", name: "Alfa", key: "ALFA", visibility: "organization", archivedAt: null, members: [], teamIds: [] };
const inside = (root: TicketSummary): TicketSummary["idea"] => ({ root: false, rootId: root.id, rootKey: root.key });
const colorsOf = (tickets: TicketSummary[]) => Object.fromEntries(buildMapItems(org, [project], { p: tickets }).map((node) => [node.id, node.color]));
const colorOf = (tickets: TicketSummary[], id: string) => colorsOf(tickets)[id];

describe("idea colors on the map (ADR 0042)", () => {
  const root = makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage: "refining" }, status: "todo" });

  it("paints the idea root and everything inside it with the idea color, whatever the status", () => {
    const tickets = [
      root,
      makeTicket("a", "p", 2, "Dentro", { parentId: "i", status: "todo", idea: inside(root) }),
      makeTicket("b", "p", 3, "Mais dentro", { parentId: "a", status: "done", idea: inside(root) }),
      makeTicket("c", "p", 4, "Cancelado dentro", { parentId: "a", status: "cancelled", idea: inside(root) }),
    ];
    const colors = colorsOf(tickets);
    expect(colors).toMatchObject({ i: IDEA_COLOR, a: IDEA_COLOR, b: IDEA_COLOR, c: IDEA_COLOR });
  });

  it("paints a discarded idea, the root and everything inside, with the muted idea color", () => {
    const discarded = makeTicket("i", "p", 1, "Ideia", { idea: { root: true, stage: "discarded" } });
    const tickets = [discarded, makeTicket("a", "p", 2, "Dentro", { parentId: "i", idea: inside(discarded) })];
    expect(colorsOf(tickets)).toMatchObject({ i: IDEA_DISCARDED_COLOR, a: IDEA_DISCARDED_COLOR });
    expect(IDEA_DISCARDED_COLOR).not.toBe(IDEA_COLOR);
  });

  it("keeps an idea inside an idea in the idea color; discarding the outer one mutes the inner one too", () => {
    const outer = makeTicket("o", "p", 1, "Fora", { idea: { root: true, stage: "discarded" } });
    const inner = makeTicket("n", "p", 2, "Dentro", { parentId: "o", idea: { root: true, stage: "new" } });
    expect(colorOf([outer, inner], "n")).toBe(IDEA_DISCARDED_COLOR);
    const live = makeTicket("o", "p", 1, "Fora", { idea: { root: true, stage: "ready" } });
    expect(colorOf([live, inner], "n")).toBe(IDEA_COLOR);
  });

  it("leaves the mix of the outer parent out of the idea: the parent mixes only the work below it", () => {
    const work = makeTicket("w", "p", 3, "Trabalho", { parentId: "t", status: "in_progress" });
    const parentWith = makeTicket("t", "p", 1, "Pai", { status: "todo", progress: { done: 0, total: 1, excluded: 0, ideas: 1 } });
    const parentWithout = makeTicket("t", "p", 1, "Pai", { status: "todo", progress: { done: 0, total: 1, excluded: 0 } });
    const withIdea = [parentWith, work, root, makeTicket("a", "p", 5, "Dentro", { parentId: "i", idea: inside(root) })].map((entry) => (entry.id === "i" ? { ...entry, parentId: "t" } : entry));
    expect(colorOf(withIdea, "t")).toBe(colorOf([parentWithout, work], "t"));
    expect(colorOf(withIdea, "t")).toBe(STATUS_COLORS.in_progress);
  });

  it("a plain parent with only ideas below keeps the color of its own status, like a leaf", () => {
    for (const status of ["todo", "done", "in_progress"] as const) {
      const parent = makeTicket("t", "p", 1, "Pai", { status, progress: { done: 0, total: 0, excluded: 0, ideas: 1 } });
      const tickets = [parent, { ...root, parentId: "t" }];
      expect(colorOf(tickets, "t")).toBe(STATUS_COLORS[status]);
    }
  });

  it("does not change the color of a project or the organization", () => {
    const colors = colorsOf([root]);
    expect(colors["p"]).toBe(ACCENT_COLOR);
    expect(colors["org_1"]).toBe(ACCENT_COLOR);
  });
});
