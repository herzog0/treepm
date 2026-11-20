import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import {
  canAssignTicket,
  canCreateTicket,
  canEditTicket,
  canImportTickets,
  canRemoveTicket,
  canViewTickets,
  canHaveChildren,
  descriptionExcerpt,
  kindChangeAllowed,
  parentWouldCreateCycle,
  ticketProgress,
} from "./tickets.js";
import type { TicketNode } from "./tickets.js";

const privateProject = { id: "internal", visibility: "private" } as const;
const organizationProject = { id: "roadmap", visibility: "organization" } as const;

const member: Actor = { clerkRole: "member", teamRoles: new Map([["design", "member"]]), projectRoles: new Map() };
const orgAdmin: Actor = { ...member, clerkRole: "admin" };
const teamAdmin: Actor = { ...member, teamRoles: new Map([["design", "admin"]]) };
const manager: Actor = { ...member, projectRoles: new Map([[privateProject.id, "manager"]]) };
const contributor: Actor = { ...member, projectRoles: new Map([[privateProject.id, "contributor"]]) };
const reader: Actor = { ...member, projectRoles: new Map([[privateProject.id, "reader"]]) };

const roles = [
  ["organization admin", orgAdmin],
  ["team admin", teamAdmin],
  ["project manager", manager],
  ["contributor", contributor],
  ["reader", reader],
  ["member without project role", member],
] as const;

describe.each([
  { action: "view tickets of a private project", check: (a: Actor) => canViewTickets(a, privateProject), allowed: [true, false, true, true, true, false] },
  { action: "view tickets of an organization project", check: (a: Actor) => canViewTickets(a, organizationProject), allowed: [true, true, true, true, true, true] },
  { action: "create a ticket", check: (a: Actor) => canCreateTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "edit a ticket", check: (a: Actor) => canEditTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "assign people", check: (a: Actor) => canAssignTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "import a list", check: (a: Actor) => canImportTickets(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "remove a ticket", check: (a: Actor) => canRemoveTicket(a, privateProject.id), allowed: [true, false, true, false, false, false] },
])("$action", ({ check, allowed }) => {
  it.each(roles.map(([name, actor], index) => [name, actor, allowed[index]] as const))("%s", (_name, actor, expected) => {
    expect(check(actor)).toBe(expected);
  });
});

it("ties the project role to the target project", () => {
  expect(canEditTicket(contributor, organizationProject.id)).toBe(false);
  expect(canRemoveTicket(manager, organizationProject.id)).toBe(false);
  expect(canEditTicket(orgAdmin, organizationProject.id)).toBe(true);
});

const node = (
  id: string,
  parentId: string | null,
  status: TicketNode["status"] = "todo",
  kind: TicketNode["kind"] = "ticket",
): TicketNode => ({ id, parentId, status, kind });
const group = (id: string, parentId: string | null, status: TicketNode["status"] = "todo"): TicketNode =>
  node(id, parentId, status, "group");

describe("ticketProgress", () => {
  it("has no entry for a ticket and none for an empty list", () => {
    expect(ticketProgress([]).size).toBe(0);
    expect(ticketProgress([node("a", null, "done")]).get("a")).toBeUndefined();
  });

  it("an empty group has zero of zero", () => {
    expect(ticketProgress([group("g", null)]).get("g")).toEqual({ done: 0, total: 0, excluded: 0 });
  });

  it("is decided by kind, not by having children", () => {
    const progress = ticketProgress([group("g", null), node("t", null, "done")]);
    expect(progress.has("g")).toBe(true);
    expect(progress.has("t")).toBe(false);
  });

  it("counts descendant tickets: done, total without cancelled, and excluded", () => {
    const tickets = [
      group("root", null),
      node("a", "root", "done"),
      node("b", "root", "in_progress"),
      node("c", "root", "cancelled"),
      node("d", "root", "in_review"),
      node("e", "root", "todo"),
    ];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 1, total: 4, excluded: 1 });
  });

  it("ignores the stored status of groups, does not count groups as items, and recurses through levels", () => {
    const tickets = [
      group("root", null, "done"),
      group("mid", "root", "cancelled"),
      node("leaf1", "mid", "done"),
      node("leaf2", "mid", "todo"),
      node("leaf3", "root", "cancelled"),
      group("empty", "root", "done"),
    ];
    const progress = ticketProgress(tickets);
    expect(progress.get("root")).toEqual({ done: 1, total: 2, excluded: 1 });
    expect(progress.get("mid")).toEqual({ done: 1, total: 2, excluded: 0 });
    expect(progress.get("empty")).toEqual({ done: 0, total: 0, excluded: 0 });
    expect(progress.has("leaf1")).toBe(false);
  });

  it("a group inside a group counts for the outer one through any depth", () => {
    const tickets = [
      group("a", null),
      group("b", "a"),
      group("c", "b"),
      node("t1", "c", "done"),
      node("t2", "b", "todo"),
    ];
    const progress = ticketProgress(tickets);
    expect(progress.get("a")).toEqual({ done: 1, total: 2, excluded: 0 });
    expect(progress.get("b")).toEqual({ done: 1, total: 2, excluded: 0 });
    expect(progress.get("c")).toEqual({ done: 1, total: 1, excluded: 0 });
  });

  it("does not depend on the input order", () => {
    const tickets = [node("leaf", "root", "done"), group("root", null)];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 1, total: 1, excluded: 0 });
  });

  it("handles all tickets cancelled", () => {
    const tickets = [group("root", null), node("a", "root", "cancelled")];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 0, total: 0, excluded: 1 });
  });
});

describe("kind rules", () => {
  it("only a group can have children", () => {
    expect(canHaveChildren("group")).toBe(true);
    expect(canHaveChildren("ticket")).toBe(false);
  });

  it("a ticket becomes a group always, whatever it has", () => {
    expect(kindChangeAllowed("ticket", "group", 0)).toBe(true);
    expect(kindChangeAllowed("ticket", "group", 3)).toBe(true);
  });

  it("a group becomes a ticket only when empty", () => {
    expect(kindChangeAllowed("group", "ticket", 0)).toBe(true);
    expect(kindChangeAllowed("group", "ticket", 1)).toBe(false);
  });

  it("keeping the kind is always allowed", () => {
    expect(kindChangeAllowed("group", "group", 2)).toBe(true);
    expect(kindChangeAllowed("ticket", "ticket", 0)).toBe(true);
  });
});

describe("parentWouldCreateCycle", () => {
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["x", null],
  ]);

  it("rejects the ticket itself as parent", () => {
    expect(parentWouldCreateCycle(parents, "a", "a")).toBe(true);
  });

  it("rejects a descendant as parent", () => {
    expect(parentWouldCreateCycle(parents, "a", "b")).toBe(true);
    expect(parentWouldCreateCycle(parents, "a", "c")).toBe(true);
  });

  it("accepts siblings, ancestors, other trees and root", () => {
    expect(parentWouldCreateCycle(parents, "c", "a")).toBe(false);
    expect(parentWouldCreateCycle(parents, "b", "x")).toBe(false);
    expect(parentWouldCreateCycle(parents, "c", null)).toBe(false);
    expect(parentWouldCreateCycle(parents, "x", "a")).toBe(false);
  });
});

describe("descriptionExcerpt", () => {
  it("devolve vazio para descrição vazia e o texto inteiro até 600 caracteres", () => {
    expect(descriptionExcerpt("")).toBe("");
    expect(descriptionExcerpt("curta")).toBe("curta");
    expect(descriptionExcerpt("a".repeat(600))).toBe("a".repeat(600));
  });

  it("corta em 600 e acrescenta reticências depois deles", () => {
    expect(descriptionExcerpt("a".repeat(601))).toBe(`${"a".repeat(600)}…`);
  });

  it("conta por ponto de código, sem partir par substituto", () => {
    const emoji = "😀";
    expect(descriptionExcerpt(emoji.repeat(600))).toBe(emoji.repeat(600));
    expect(descriptionExcerpt(emoji.repeat(601))).toBe(`${emoji.repeat(600)}…`);
    expect(descriptionExcerpt(`${"a".repeat(599)}${emoji}b`)).toBe(`${"a".repeat(599)}${emoji}…`);
  });
});
