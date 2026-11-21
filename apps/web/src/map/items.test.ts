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
  status,
  progress: null,
  assigneeIds: [],
  descriptionExcerpt: "",
});

/** Ticket com filhos: o progresso conta todos os descendentes (contrato da ADR 0034). */
const parent = (id: string, projectId: string, number: number, title: string, progress: { done: number; total: number; excluded?: number }, parentId: string | null = null, status: TicketSummary["status"] = "todo"): TicketSummary => ({
  ...ticket(id, projectId, number, title, parentId, status),
  progress: { excluded: 0, ...progress },
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
      parent("t1", "a", 1, "Raiz um", { done: 0, total: 3 }),
      ticket("t2", "a", 2, "Raiz dois"),
      parent("t3", "a", 3, "Filho do um", { done: 0, total: 1 }, "t1"),
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

describe("a ticket with an open descendant is painted by its descendants (ADR 0034)", () => {
  const a = project("a", "AAA", "Alfa");
  const colorOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)?.color;
  const nodeOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)!;

  it("paints a ticket without children with its own status and weighs it as one leaf", () => {
    const items = buildMapItems(org, [a], { a: [ticket("t", "a", 1, "Solto", null, "in_review")] });
    expect(nodeOf(items, "t").color).toBe(STATUS_COLORS.in_review);
    expect(nodeOf(items, "t").leafCount).toBe(1);
  });

  it("paints a parent with an open child by the mix of its descendants, not by its own status", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 1 }, null, "done"), ticket("c", "a", 2, "Filho", "g", "in_progress")] });
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.in_progress);
    expect(nodeOf(items, "g").leafCount).toBe(1);
  });

  it("weighs an open parent as many leaves as it has descendants in a merged square", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 2 }), ticket("c", "a", 2, "F1", "g", "todo"), ticket("d", "a", 3, "F2", "g", "todo")] });
    expect(nodeOf(items, "g").leafCount).toBe(2);
  });

  it("paints a parent whose children are all finalized with its own status", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 1, total: 1, excluded: 1 }, null, "in_review"), ticket("c", "a", 2, "Filho", "g", "done"), ticket("x", "a", 3, "Outro", "g", "cancelled")] });
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.in_review);
    expect(nodeOf(items, "g").leafCount).toBe(1);
  });

  it("paints a parent whose children are all cancelled with its own status", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 0, excluded: 2 }, null, "todo"), ticket("c", "a", 2, "Filho", "g", "cancelled"), ticket("x", "a", 3, "Outro", "g", "cancelled")] });
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.todo);
  });

  it("counts the descendants that are parents themselves, each with its own status", () => {
    const items = buildMapItems(org, [a], {
      a: [
        parent("p", "a", 1, "Pai", { done: 1, total: 3 }),
        parent("m", "a", 2, "Meio", { done: 1, total: 1 }, "p", "done"),
        ticket("l1", "a", 3, "Folha 1", "m", "done"),
        ticket("l2", "a", 4, "Folha 2", "p", "in_review"),
      ],
    });
    const p = nodeOf(items, "p");
    expect(p.color).toBe(mixWeightedColors([{ color: STATUS_COLORS.done, weight: 2 }, { color: STATUS_COLORS.in_review, weight: 1 }]));
    expect(p.leafCount).toBe(3);
    expect(colorOf(items, "m")).toBe(STATUS_COLORS.done);
  });

  it("paints a finalized grandchild's open sibling through the parent that has an open descendant", () => {
    const items = buildMapItems(org, [a], {
      a: [
        parent("p", "a", 1, "Pai", { done: 1, total: 2 }),
        ticket("c", "a", 2, "Filho concluído", "p", "done"),
        parent("m", "a", 3, "Filho com neto aberto", { done: 0, total: 1 }, "p", "done"),
        ticket("n", "a", 4, "Neto", "m", "todo"),
      ],
    });
    expect(colorOf(items, "p")).toBe(mixWeightedColors([{ color: STATUS_COLORS.done, weight: 2 }, { color: STATUS_COLORS.todo, weight: 1 }]));
    expect(colorOf(items, "m")).toBe(STATUS_COLORS.todo);
  });

  it("keeps a ticket at the root next to a parent, each with its own color", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 1 }), ticket("t", "a", 2, "Solto", null, "done"), ticket("c", "a", 3, "Filho", "g", "in_progress")] });
    expect(items.filter((item) => item.parentId === "a").map((item) => item.id)).toEqual(["g", "t"]);
    expect(colorOf(items, "t")).toBe(STATUS_COLORS.done);
    expect(colorOf(items, "g")).toBe(STATUS_COLORS.in_progress);
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

  it("paints a ticket with open descendants with the mix of all of them", () => {
    const tickets = {
      a: [
        parent("p", "a", 1, "Pai", { done: 2, total: 3 }),
        parent("m", "a", 2, "Meio", { done: 2, total: 2 }, "p", "done"),
        ticket("l1", "a", 3, "Folha 1", "m", "done"),
        ticket("l2", "a", 4, "Folha 2", "m", "done"),
        ticket("l3", "a", 5, "Folha 3", "p", "in_review"),
      ],
    };
    const items = buildMapItems(org, [a], tickets);
    expect(colorOf(items, "p")).toBe(mixWeightedColors([{ color: STATUS_COLORS.done, weight: 3 }, { color: STATUS_COLORS.in_review, weight: 1 }]));
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
        parent("p", "a", 1, "Pai", { done: 0, total: 2 }),
        ticket("l1", "a", 2, "F1", "p", "in_progress"),
        ticket("l2", "a", 3, "F2", "p", "in_progress"),
        ticket("solo", "a", 4, "Solo", null, "todo"),
      ],
    };
    const items = buildMapItems(org, [a], tickets);
    const members = [items.find((item) => item.id === "p")!, items.find((item) => item.id === "solo")!];
    const colors = members.map((member) => ({ color: member.color, weight: 1 }));
    const expected = mixWeightedColors([{ color: STATUS_COLORS.in_progress, weight: 2 }, { color: STATUS_COLORS.todo, weight: 1 }]);
    expect(mixMapColors(colors, members)).toBe(expected);
  });

  it("counts a project or the organization as one leaf", () => {
    const items = buildMapItems(org, [a], {});
    expect(mixMapColors([{ color: ACCENT_COLOR, weight: 1 }], [items[1]!])).toBe(ACCENT_COLOR);
  });
});
