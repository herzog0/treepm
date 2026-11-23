import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { randomTickets, seeded } from "../test/randomTree.js";
import { ACCENT_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS, buildMapItems, mixMapColors } from "./items.js";
import { SITUATION_COLORS } from "./situation.js";

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

const blockedTicket = (id: string, projectId: string, number: number, title: string, parentId: string | null = null, status: TicketSummary["status"] = "todo"): TicketSummary => ({ ...ticket(id, projectId, number, title, parentId, status), blocked: true });

describe("a branch shows its most worrying situation (ADR 0051)", () => {
  const a = project("a", "AAA", "Alfa");
  const colorOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)?.color;
  const nodeOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)!;
  const C = SITUATION_COLORS;

  it("paints a ticket without children with its own status and weighs it as one leaf", () => {
    const items = buildMapItems(org, [a], { a: [ticket("t", "a", 1, "Solto", null, "in_review")] });
    expect(nodeOf(items, "t").color).toBe(C.in_review);
    expect(nodeOf(items, "t").leafCount).toBe(1);
  });

  it("paints a blocked ticket red, whatever the recorded status, unless it is concluded or cancelled", () => {
    const items = buildMapItems(org, [a], { a: [blockedTicket("b1", "a", 1, "X", null, "todo"), blockedTicket("b2", "a", 2, "X", null, "in_progress"), blockedTicket("b3", "a", 3, "X", null, "in_review"), blockedTicket("b4", "a", 4, "X", null, "done"), blockedTicket("b5", "a", 5, "X", null, "cancelled")] });
    expect(["b1", "b2", "b3", "b4", "b5"].map((id) => colorOf(items, id))).toEqual([C.blocked, C.blocked, C.blocked, C.done, STATUS_COLORS.cancelled]);
  });

  it("paints a parent by its leaves, not by its own status", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 1 }, null, "done"), ticket("c", "a", 2, "Filho", "g", "in_progress")] });
    expect(colorOf(items, "g")).toBe(C.in_progress);
    expect(nodeOf(items, "g").leafCount).toBe(1);
  });

  it("weighs an open parent as many leaves as it has descendants in the layout", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 2 }), ticket("c", "a", 2, "F1", "g", "todo"), ticket("d", "a", 3, "F2", "g", "todo")] });
    expect(nodeOf(items, "g").leafCount).toBe(2);
  });

  it.each([
    ["blocked beats everything", ["done", "todo", "in_review", "in_progress", "blocked"], C.blocked],
    ["in progress beats review, to do and concluded", ["done", "todo", "in_review", "in_progress"], C.in_progress],
    ["review beats to do and concluded", ["done", "todo", "in_review"], C.in_review],
    ["to do beats concluded: parent with part concluded and nothing active is grey", ["done", "done", "todo"], C.todo],
    ["only concluded is green", ["done", "done"], C.done],
    ["only cancelled is the muted grey", ["cancelled", "cancelled"], STATUS_COLORS.cancelled],
    ["cancelled does not rise over concluded", ["cancelled", "done"], C.done],
    ["cancelled does not rise over to do", ["cancelled", "todo"], C.todo],
  ] as const)("%s", (_name, leaves, expected) => {
    const children = leaves.map((state, at) => (state === "blocked" ? blockedTicket(`c${at}`, "a", at + 2, "F", "g", "todo") : ticket(`c${at}`, "a", at + 2, "F", "g", state)));
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Pai", { done: 0, total: leaves.length }, null, "in_progress"), ...children] });
    expect(colorOf(items, "g")).toBe(expected);
  });

  it("carries a blocked ticket three levels down to every ancestor, the project and the organization", () => {
    const items = buildMapItems(org, [a], {
      a: [
        parent("l1", "a", 1, "N1", { done: 1, total: 4 }),
        parent("l2", "a", 2, "N2", { done: 1, total: 3 }, "l1"),
        parent("l3", "a", 3, "N3", { done: 1, total: 2 }, "l2"),
        blockedTicket("leaf", "a", 4, "Folha bloqueada", "l3", "todo"),
        ticket("busy", "a", 5, "Andando", "l1", "in_progress"),
        ticket("fin", "a", 6, "Pronto", "l3", "done"),
      ],
    });
    for (const id of ["l1", "l2", "l3", "a", "org_1"]) expect(colorOf(items, id), id).toBe(C.blocked);
    expect(colorOf(items, "busy")).toBe(C.in_progress);
  });

  it("does not count a concluded blocked ticket, and a blocked parent is red itself over an active child", () => {
    const concluded = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Pai", { done: 1, total: 1 }), blockedTicket("c", "a", 2, "F", "g", "done")] });
    expect(colorOf(concluded, "g")).toBe(C.done);
    const blockedParent = buildMapItems(org, [a], { a: [{ ...parent("g", "a", 1, "Pai", { done: 0, total: 1 }), blocked: true }, ticket("c", "a", 2, "F", "g", "in_progress")] });
    expect(colorOf(blockedParent, "g")).toBe(C.blocked);
  });

  it("paints the project and the organization by their tickets, and keeps the accent without tickets or with ideas only", () => {
    const items = buildMapItems(org, [a, project("b", "BBB", "Beta")], { a: [ticket("t", "a", 1, "X", null, "done"), ticket("u", "a", 2, "Y", null, "todo")] });
    expect(colorOf(items, "a")).toBe(C.todo);
    expect(colorOf(items, "b")).toBe(ACCENT_COLOR);
    expect(colorOf(items, "org_1")).toBe(C.todo);
    const ideasOnly = buildMapItems(org, [a], { a: [{ ...ticket("i", "a", 1, "Ideia"), idea: { root: true, stage: "new" } }] });
    expect(colorOf(ideasOnly, "a")).toBe(ACCENT_COLOR);
    expect(colorOf(ideasOnly, "org_1")).toBe(ACCENT_COLOR);
  });

  it("keeps a ticket at the root next to a parent, each with its own color", () => {
    const items = buildMapItems(org, [a], { a: [parent("g", "a", 1, "Fase 1", { done: 0, total: 1 }), ticket("t", "a", 2, "Solto", null, "done"), ticket("c", "a", 3, "Filho", "g", "in_progress")] });
    expect(items.filter((item) => item.parentId === "a").map((item) => item.id)).toEqual(["g", "t"]);
    expect(colorOf(items, "t")).toBe(C.done);
    expect(colorOf(items, "g")).toBe(C.in_progress);
  });
});

describe("node colors", () => {
  const a = project("a", "AAA", "Alfa");
  const colorOf = (items: ReturnType<typeof buildMapItems>, id: string) => items.find((item) => item.id === id)?.color;

  it("paints the organization and the projects with the accent when they have no tickets", () => {
    const items = buildMapItems(org, [a], {});
    expect(colorOf(items, "org_1")).toBe(ACCENT_COLOR);
    expect(colorOf(items, "a")).toBe(ACCENT_COLOR);
  });

  it("paints a leaf ticket with the color of its status", () => {
    const tickets = { a: (["todo", "in_progress", "in_review", "done", "cancelled"] as const).map((status, i) => ticket(`t${i}`, "a", i + 1, "X", null, status)) };
    const items = buildMapItems(org, [a], tickets);
    expect(["t0", "t1", "t2", "t3", "t4"].map((id) => colorOf(items, id))).toEqual([STATUS_COLORS.todo, STATUS_COLORS.in_progress, STATUS_COLORS.in_review, STATUS_COLORS.done, STATUS_COLORS.cancelled]);
  });
});

describe("mixMapColors (merged squares): the most worrying color, never a mix", () => {
  const a = project("a", "AAA", "Alfa");
  const member = (color: string) => ({ color, weight: 1 });
  it("returns the most worrying member color, whatever the weights", () => {
    const tickets = { a: [parent("p", "a", 1, "Pai", { done: 0, total: 2 }), ticket("l1", "a", 2, "F1", "p", "in_progress"), ticket("l2", "a", 3, "F2", "p", "in_progress"), ticket("solo", "a", 4, "Solo", null, "todo")] };
    const items = buildMapItems(org, [a], tickets);
    const members = [items.find((item) => item.id === "p")!, items.find((item) => item.id === "solo")!];
    expect(mixMapColors(members.map((m) => member(m.color)), members)).toBe(SITUATION_COLORS.in_progress);
  });

  it("returns a single member unchanged", () => {
    const items = buildMapItems(org, [a], {});
    expect(mixMapColors([member(ACCENT_COLOR)], [items[1]!])).toBe(ACCENT_COLOR);
  });

  it("never returns a color that is not one of the inputs (random groups, fixed seed)", () => {
    const allowed = [...Object.values(SITUATION_COLORS), ACCENT_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS.cancelled];
    const random = seeded(7);
    const items = buildMapItems(org, [a], {});
    for (let round = 0; round < 500; round += 1) {
      const picked = Array.from({ length: 1 + Math.floor(random() * 8) }, () => allowed[Math.floor(random() * allowed.length)]!);
      const result = mixMapColors(picked.map(member), picked.map(() => items[1]!));
      expect(picked).toContain(result);
    }
  });
});

describe("every node of a random map has a color of the palette (property, seeded trees)", () => {
  const allowed = new Set<string>([...Object.values(SITUATION_COLORS), ACCENT_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, STATUS_COLORS.cancelled]);
  for (let seed = 1; seed <= 25; seed += 1) {
    it(`seed ${seed}`, () => {
      const tickets = randomTickets(50 + seed * 13, seed, "a", { blocked: 0.07, chain: seed % 2 ? 0.2 : 0.8 });
      const items = buildMapItems(org, [project("a", "AAA", "Alfa")], { a: tickets });
      for (const node of items) expect(allowed.has(node.color), `${node.id} ${node.color}`).toBe(true);
    });
  }
});
