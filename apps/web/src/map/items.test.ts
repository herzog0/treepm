import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { ACCENT_COLOR, STATUS_COLORS, buildMapItems, mixMapColors, mixWeightedColors } from "./items.js";

const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project = (id: string, key: string, name: string, archivedAt: string | null = null): Project => ({
  id,
  name,
  key,
  visibility: "organization",
  archivedAt,
  members: [],
  teamIds: [],
});

const ticket = (id: string, projectId: string, number: number, title: string, parentId: string | null = null, status: TicketSummary["status"] = "todo"): TicketSummary => ({
  id,
  projectId,
  number,
  key: `K-${number}`,
  parentId,
  title,
  kind: "ticket",
  status,
  progress: null,
  assigneeIds: [],
  descriptionExcerpt: "",
});

const group = (id: string, projectId: string, number: number, title: string, parentId: string | null = null): TicketSummary => ({
  ...ticket(id, projectId, number, title, parentId, null),
  kind: "group",
  progress: { done: 0, total: 0, excluded: 0 },
});

describe("buildMapItems", () => {
  it("makes the organization the root and projects its children, in API order", () => {
    const items = buildMapItems(org, [project("b", "BBB", "Segundo"), project("a", "AAA", "Primeiro")], {});
    expect(items.map((item) => [item.id, item.parentId, item.label])).toEqual([
      ["org_1", null, "Equipe Alfa"],
      ["b", "org_1", "Segundo"],
      ["a", "org_1", "Primeiro"],
    ]);
    expect(items[1]).toMatchObject({ kind: "project", key: "BBB" });
    expect(items[0]).toMatchObject({ kind: "organization" });
  });

  it("drops archived projects", () => {
    const items = buildMapItems(org, [project("a", "AAA", "A"), project("b", "BBB", "B", "2026-01-01T00:00:00.000Z")], {});
    expect(items.map((item) => item.id)).toEqual(["org_1", "a"]);
  });

  it("returns only the root for an organization without projects", () => {
    expect(buildMapItems(org, [], {}).map((item) => item.id)).toEqual(["org_1"]);
  });
});

describe("buildMapItems with tickets", () => {
  const a = project("a", "AAA", "Alfa");
  const tickets = {
    a: [
      group("t1", "a", 1, "Raiz um"),
      ticket("t2", "a", 2, "Raiz dois"),
      group("t3", "a", 3, "Filho do um", "t1"),
      ticket("t4", "a", 4, "Neto", "t3"),
      ticket("t5", "a", 5, "Outro filho do um", "t1"),
    ],
  };

  it("hangs root tickets under the project and the others under their parent ticket", () => {
    const items = buildMapItems(org, [a], tickets);
    expect(items.filter((item) => item.kind === "ticket").map((item) => [item.id, item.parentId])).toEqual([
      ["t1", "a"],
      ["t2", "a"],
      ["t3", "t1"],
      ["t4", "t3"],
      ["t5", "t1"],
    ]);
  });

  it("keeps sibling order as in the listing (by number)", () => {
    const items = buildMapItems(org, [a], tickets);
    expect(items.filter((item) => item.parentId === "t1").map((item) => item.id)).toEqual(["t3", "t5"]);
    expect(items.filter((item) => item.parentId === "a").map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  it("shows key and title and carries the summary", () => {
    const items = buildMapItems(org, [a], tickets);
    const node = items.find((item) => item.id === "t3");
    expect(node).toMatchObject({ kind: "ticket", key: "K-3", label: "Filho do um" });
    expect(node?.ticket).toEqual(tickets.a[2]);
    expect(items.find((item) => item.id === "a")?.ticket).toBeNull();
  });

  it("drops tickets of archived projects and of unknown projects", () => {
    const archived = project("z", "ZZZ", "Velho", "2026-01-01T00:00:00.000Z");
    const items = buildMapItems(org, [a, archived], { ...tickets, z: [ticket("tz", "z", 1, "Fantasma")], nope: [ticket("tn", "nope", 1, "Órfão")] });
    expect(items.some((item) => item.id === "tz" || item.id === "tn")).toBe(false);
  });

  it("treats a project without an entry as having no tickets", () => {
    expect(buildMapItems(org, [a], {}).map((item) => item.id)).toEqual(["org_1", "a"]);
  });
});

describe("kind decides the node type, not having children", () => {
  const a = project("a", "AAA", "Alfa");
  const colorOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)?.color;

  it("paints an empty group with the neutral 'a fazer' color and weighs it as one leaf", () => {
    const items = buildMapItems(org, [a], { a: [group("g", "a", 1, "Fase 1")] });
    const node = items.find((item) => item.id === "g")!;
    expect(node.color).toBe(STATUS_COLORS.todo);
    expect(node.leafCount).toBe(1);
    expect(node.ticket?.kind).toBe("group");
  });

  it("keeps a ticket at the root next to a group, each with its own color", () => {
    const items = buildMapItems(org, [a], { a: [group("g", "a", 1, "Fase 1"), ticket("t", "a", 2, "Solto", null, "done"), ticket("c", "a", 3, "Filho", "g", "in_progress")] });
    expect(items.filter((item) => item.parentId === "a").map((item) => item.id)).toEqual(["g", "t"]);
    expect(colorOf(items, "t")).toBe(STATUS_COLORS.done);
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.in_progress);
  });

  it("does not let an empty group inside another group count as a leaf of the mix", () => {
    const items = buildMapItems(org, [a], { a: [group("g", "a", 1, "Fase 1"), group("e", "a", 2, "Vazio", "g"), ticket("c", "a", 3, "Filho", "g", "done")] });
    const node = items.find((item) => item.id === "g")!;
    expect(node.color).toBe(STATUS_COLORS.done);
    expect(node.leafCount).toBe(1);
  });

  it("paints a group that holds only empty groups as neutral", () => {
    const items = buildMapItems(org, [a], { a: [group("g", "a", 1, "Fase 1"), group("e", "a", 2, "Vazio", "g")] });
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.todo);
  });
});

describe("node colors", () => {
  const a = project("a", "AAA", "Alfa");
  const colorOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)?.color;

  it("paints the organization and the projects with the accent", () => {
    const items = buildMapItems(org, [a], {});
    expect(colorOf(items, "org_1")).toBe(ACCENT_COLOR);
    expect(colorOf(items, "a")).toBe(ACCENT_COLOR);
  });

  it("paints a leaf ticket with the color of its status", () => {
    const tickets = { a: (["todo", "in_progress", "in_review", "done", "cancelled"] as const).map((status, i) => ticket(`t${i}`, "a", i + 1, "X", null, status)) };
    const items = buildMapItems(org, [a], tickets);
    expect(["t0", "t1", "t2", "t3", "t4"].map((id) => colorOf(items, id))).toEqual([
      STATUS_COLORS.todo,
      STATUS_COLORS.in_progress,
      STATUS_COLORS.in_review,
      STATUS_COLORS.done,
      STATUS_COLORS.cancelled,
    ]);
  });

  it("paints a ticket with children with the mix of its descendant leaves, ignoring the intermediate levels", () => {
    const tickets = {
      a: [
        group("p", "a", 1, "Pai"),
        group("m", "a", 2, "Meio", "p"),
        ticket("l1", "a", 3, "Folha 1", "m", "done"),
        ticket("l2", "a", 4, "Folha 2", "m", "done"),
        ticket("l3", "a", 5, "Folha 3", "p", "in_review"),
      ],
    };
    const items = buildMapItems(org, [a], tickets);
    expect(colorOf(items, "p")).toBe(mixWeightedColors([{ color: STATUS_COLORS.done, weight: 2 }, { color: STATUS_COLORS.in_review, weight: 1 }]));
    expect(colorOf(items, "m")).toBe(STATUS_COLORS.done);
    expect(colorOf(items, "p")).not.toBe(STATUS_COLORS.done);
  });
});

describe("mixWeightedColors", () => {
  it("returns the same color for equal colors and the midpoint in linear light for two", () => {
    expect(mixWeightedColors([{ color: "#4fc48c", weight: 3 }, { color: "#4fc48c", weight: 1 }])).toBe("#4fc48c");
    expect(mixWeightedColors([{ color: "#000000", weight: 1 }, { color: "#ffffff", weight: 1 }])).toBe("#bcbcbc");
  });

  it("weights by leaf count and does not depend on the order", () => {
    const x = { color: "#6ea8ff", weight: 3 };
    const y = { color: "#e7b450", weight: 1 };
    expect(mixWeightedColors([x, y])).toBe(mixWeightedColors([y, x]));
    expect(mixWeightedColors([x, y])).not.toBe(mixWeightedColors([{ ...x, weight: 1 }, y]));
  });
});

describe("mixMapColors (merged squares)", () => {
  const a = project("a", "AAA", "Alfa");
  it("mixes the member colors weighted by how many leaves each member holds", () => {
    const tickets = {
      a: [
        group("p", "a", 1, "Pai"),
        ticket("l1", "a", 2, "F1", "p", "done"),
        ticket("l2", "a", 3, "F2", "p", "done"),
        ticket("solo", "a", 4, "Solo", null, "todo"),
      ],
    };
    const items = buildMapItems(org, [a], tickets);
    const members = [items.find((item) => item.id === "p")!, items.find((item) => item.id === "solo")!];
    const colors = members.map((member) => ({ color: member.color, weight: 1 }));
    const expected = mixWeightedColors([{ color: STATUS_COLORS.done, weight: 2 }, { color: STATUS_COLORS.todo, weight: 1 }]);
    expect(mixMapColors(colors, members)).toBe(expected);
  });

  it("counts a project or the organization as one leaf", () => {
    const items = buildMapItems(org, [a], {});
    expect(mixMapColors([{ color: ACCENT_COLOR, weight: 1 }], [items[1]!])).toBe(ACCENT_COLOR);
  });
});
