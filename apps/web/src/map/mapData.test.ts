import { describe, expect, it } from "vitest";
import { makePerson, makeProject, makeTicket } from "../test/fakes.js";
import { mergeMapData } from "./mapData.js";
import type { Person, Project, TicketSummary } from "../api/client.js";

type Draft = { projects: Project[]; people: Person[]; ticketsByProject: Record<string, TicketSummary[]> };

const base = (): Draft => ({
  projects: [makeProject("p1", "ALFA", "Alfa"), makeProject("p2", "BETA", "Beta")],
  people: [makePerson("a", "Ana")],
  ticketsByProject: {
    p1: [makeTicket("t1", "p1", 1, "Um"), makeTicket("t2", "p1", 2, "Dois")],
    p2: [makeTicket("t3", "p2", 1, "Três")],
  },
});
/** Uma cópia profunda: a resposta nova da API nunca é o mesmo objeto da anterior. */
const clone = (data: Draft): Draft => structuredClone(data);

describe("mergeMapData", () => {
  it("returns the very same object when the new answer equals what is on screen", () => {
    const current = base();
    expect(mergeMapData(current, clone(current))).toBe(current);
  });

  it("keeps the identity of every part that did not change", () => {
    const current = base();
    const next = clone(current);
    next.ticketsByProject.p1 = [next.ticketsByProject.p1![0]!, { ...next.ticketsByProject.p1![1]!, agentWork: { since: "2026-11-22T12:00:00.000Z", until: "2026-11-22T13:00:00.000Z", note: null } }];
    const merged = mergeMapData(current, next);
    expect(merged).not.toBe(current);
    expect(merged.projects).toBe(current.projects);
    expect(merged.people).toBe(current.people);
    expect(merged.ticketsByProject.p2).toBe(current.ticketsByProject.p2);
    expect(merged.ticketsByProject.p1).not.toBe(current.ticketsByProject.p1);
    expect(merged.ticketsByProject.p1![1]!.agentWork?.until).toBe("2026-11-22T13:00:00.000Z");
  });

  it("notices a ticket that appeared, one that left and a project that was archived", () => {
    const current = base();
    const added = clone(current);
    added.ticketsByProject.p2 = [...added.ticketsByProject.p2!, makeTicket("t4", "p2", 2, "Quatro")];
    expect(mergeMapData(current, added).ticketsByProject.p2).toHaveLength(2);
    const left = clone(current);
    left.ticketsByProject.p1 = [left.ticketsByProject.p1![0]!];
    expect(mergeMapData(current, left).ticketsByProject.p1).toHaveLength(1);
    const archived = clone(current);
    archived.projects = [archived.projects[0]!, { ...archived.projects[1]!, archivedAt: "2026-11-22T00:00:00.000Z" }];
    delete archived.ticketsByProject.p2;
    const merged = mergeMapData(current, archived);
    expect(merged.projects[1]!.archivedAt).not.toBeNull();
    expect(merged.ticketsByProject.p2).toBeUndefined();
  });
});
