import { describe, expect, it } from "vitest";
import { explodedFocus } from "./focus.js";
import type { FocusNode } from "./focus.js";

// ADR 0070, seção 2: entram os tickets sem filhos dentro do que está em foco no mapa: o projeto, ou um ticket com filhos.
const nodes: FocusNode[] = [
  { id: "org", parentId: null, kind: "organization", projectId: null },
  { id: "p1", parentId: "org", kind: "project", projectId: "p1" },
  { id: "p2", parentId: "org", kind: "project", projectId: "p2" },
  { id: "pai", parentId: "p1", kind: "ticket", projectId: "p1" },
  { id: "folha", parentId: "pai", kind: "ticket", projectId: "p1" },
  { id: "solta", parentId: "p2", kind: "ticket", projectId: "p2" },
];
const byId = new Map(nodes.map((node) => [node.id, node] as const));
const hasChildren = (id: string) => nodes.some((node) => node.parentId === id);
const focus = (mapFocus: string, open: string | null = null, projectIds = ["p1", "p2"]) => explodedFocus({ byId, hasChildren, mapFocus, openTicketId: open, projectIds });

describe("explodedFocus", () => {
  it("um projeto em foco: o projeto inteiro", () => {
    expect(focus("p2")).toEqual({ projectId: "p2", ticketId: null });
  });
  it("um ticket com filhos em foco: ele", () => {
    expect(focus("pai")).toEqual({ projectId: "p1", ticketId: "pai" });
  });
  it("um ticket sem filhos em foco: o pai dele, ou o projeto na raiz", () => {
    expect(focus("folha")).toEqual({ projectId: "p1", ticketId: "pai" });
    expect(focus("solta")).toEqual({ projectId: "p2", ticketId: null });
  });
  it("a organização em foco: o projeto do ticket aberto; sem ele, o primeiro projeto", () => {
    expect(focus("org", "solta")).toEqual({ projectId: "p2", ticketId: null });
    expect(focus("org")).toEqual({ projectId: "p1", ticketId: null });
    expect(focus("org", null, [])).toBeNull();
  });
});
