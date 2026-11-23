import { describe, expect, it, vi } from "vitest";
import type { Person, Project, TicketSummary } from "../api/client.js";
import { makePerson, makeProject } from "../test/fakes.js";
import { randomTickets, seeded } from "../test/randomTree.js";
import { mergeMapData } from "./mapData.js";
import type { MapData as ReadonlyMapData } from "./mapData.js";

/** O mesmo formato, com as listas graváveis para os testes montarem as mutações. */
type MapData = { -readonly [K in keyof ReadonlyMapData]: K extends "ticketsByProject" ? Record<string, readonly TicketSummary[]> : ReadonlyMapData[K] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A versão de antes (comparação por `JSON.stringify`), guardada como referência de equivalência. */
function mergeReference(current: MapData, next: MapData): MapData {
  const projects = same(current.projects, next.projects) ? current.projects : next.projects;
  const people = same(current.people, next.people) ? current.people : next.people;
  const ids = Object.keys(next.ticketsByProject);
  let ticketsChanged = ids.length !== Object.keys(current.ticketsByProject).length;
  const ticketsByProject: Record<string, readonly TicketSummary[]> = {};
  for (const id of ids) {
    const before = current.ticketsByProject[id];
    const after = next.ticketsByProject[id]!;
    if (before !== undefined && same(before, after)) ticketsByProject[id] = before;
    else {
      ticketsByProject[id] = after;
      ticketsChanged = true;
    }
  }
  if (projects === current.projects && people === current.people && !ticketsChanged) return current;
  return { projects, people, ticketsByProject: ticketsChanged ? ticketsByProject : current.ticketsByProject };
}

const baseData = (seed: number): MapData => ({
  projects: [makeProject("p1", "ALFA", "Alfa"), makeProject("p2", "BETA", "Beta")],
  people: [makePerson("a", "Ana"), makePerson("b", "Bia")],
  ticketsByProject: { p1: randomTickets(60, seed, "p1"), p2: randomTickets(25, seed + 1000, "p2") },
});

/** Cada mutação muda um campo do esquema do resumo (ou de projeto ou pessoa) que pode mudar sem outro. */
const mutations: [string, (data: MapData, pick: () => number) => void][] = [
  ["title", (d, r) => edit(d, r, (t) => ({ ...t, title: `${t.title}!` }))],
  ["status", (d, r) => edit(d, r, (t) => ({ ...t, status: t.status === "done" ? "todo" : "done" }))],
  ["parentId", (d, r) => edit(d, r, (t) => ({ ...t, parentId: t.parentId === null ? "t0" : null }))],
  ["progress", (d, r) => edit(d, r, (t) => ({ ...t, progress: t.progress ? { ...t.progress, done: t.progress.done + 1 } : { done: 0, total: 1, excluded: 0 } }))],
  ["progress.ideas", (d, r) => edit(d, r, (t) => ({ ...t, progress: { done: 0, total: 1, excluded: 0, ideas: (t.progress?.ideas ?? 0) + 1 } }))],
  ["idea", (d, r) => edit(d, r, (t) => ({ ...t, idea: t.idea ? null : { root: true, stage: "new" } }))],
  ["idea.stage", (d, r) => edit(d, r, (t) => ({ ...t, idea: { root: true, stage: t.idea && t.idea.root && t.idea.stage === "new" ? "ready" : "new" } }))],
  ["assigneeIds", (d, r) => edit(d, r, (t) => ({ ...t, assigneeIds: [...t.assigneeIds, "a"] }))],
  ["excerpt", (d, r) => edit(d, r, (t) => ({ ...t, descriptionExcerpt: `${t.descriptionExcerpt}x` }))],
  ["agentWork", (d, r) => edit(d, r, (t) => ({ ...t, agentWork: { since: "2026-11-22T12:00:00.000Z", until: "2026-11-22T13:00:00.000Z", note: null } }))],
  ["agentWork.note", (d, r) => edit(d, r, (t) => ({ ...t, agentWork: { since: "s", until: "u", note: t.agentWork?.note === "n" ? "m" : "n" } }))],
  ["agentWork.by", (d, r) => edit(d, r, (t) => ({ ...t, agentWork: { since: "s", until: "u", note: null, by: { id: "x", displayName: "X", avatarUrl: null } } }))],
  ["number", (d, r) => edit(d, r, (t) => ({ ...t, number: t.number + 100 }))],
  ["remove one", (d, r) => { const id = Object.keys(d.ticketsByProject)[Math.floor(r() * 2)]!; d.ticketsByProject[id] = d.ticketsByProject[id]!.slice(1); }],
  ["add one", (d) => { d.ticketsByProject["p1"] = [...d.ticketsByProject["p1"]!, { ...d.ticketsByProject["p1"]![0]!, id: "extra", number: 999 }]; }],
  ["swap order", (d) => { const l = [...d.ticketsByProject["p2"]!]; [l[0], l[1]] = [l[1]!, l[0]!]; d.ticketsByProject["p2"] = l; }],
  ["drop a project's tickets", (d) => { delete d.ticketsByProject["p2"]; }],
  ["project name", (d) => { d.projects = [d.projects[0]!, { ...d.projects[1]!, name: "Beta 2" }]; }],
  ["project archived", (d) => { d.projects = [{ ...d.projects[0]!, archivedAt: "2026-11-22T00:00:00.000Z" }, d.projects[1]!]; }],
  ["project members", (d) => { d.projects = [{ ...d.projects[0]!, members: [{ personId: "a", role: "manager" } as Project["members"][number]] }, d.projects[1]!]; }],
  ["person name", (d) => { d.people = [{ ...d.people[0]!, displayName: "Ana M." } as Person, d.people[1]!]; }],
  ["person removed", (d) => { d.people = d.people.slice(1); }],
];
function edit(data: MapData, pick: () => number, change: (ticket: TicketSummary) => TicketSummary): void {
  const ids = Object.keys(data.ticketsByProject);
  const id = ids[Math.floor(pick() * ids.length)]!;
  const list = [...data.ticketsByProject[id]!];
  const at = Math.floor(pick() * list.length);
  list[at] = change(list[at]!);
  data.ticketsByProject[id] = list;
}
const clone = (data: MapData): MapData => structuredClone(data);

describe("mergeMapData: same decision as the JSON.stringify version", () => {
  it("nothing changed: the very same object", () => {
    const current = baseData(1);
    expect(mergeMapData(current, clone(current))).toBe(current);
  });

  for (const [name, mutate] of mutations) {
    it(`one change: ${name}`, () => {
      for (let seed = 1; seed <= 6; seed += 1) {
        const current = baseData(seed);
        const next = clone(current);
        mutate(next, seeded(seed * 31));
        const merged = mergeMapData(current, next);
        const expected = mergeReference(current, next);
        expect(merged).toEqual(expected);
        expect(merged === current).toBe(expected === current);
        expect(merged.projects === current.projects).toBe(expected.projects === current.projects);
        expect(merged.people === current.people).toBe(expected.people === current.people);
        expect(merged.ticketsByProject === current.ticketsByProject).toBe(expected.ticketsByProject === current.ticketsByProject);
        for (const id of Object.keys(next.ticketsByProject)) expect(merged.ticketsByProject[id] === current.ticketsByProject[id]).toBe(expected.ticketsByProject[id] === current.ticketsByProject[id]);
      }
    });
  }

  it("several changes at once, over many random pairs", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const pick = seeded(seed);
      const current = baseData(seed);
      const next = clone(current);
      const times = 1 + Math.floor(pick() * 3);
      for (let k = 0; k < times; k += 1) mutations[Math.floor(pick() * mutations.length)]![1](next, pick);
      const merged = mergeMapData(current, next);
      const expected = mergeReference(current, next);
      expect(merged).toEqual(expected);
      expect(merged === current).toBe(expected === current);
    }
  });

  it("empty data and an empty project", () => {
    const empty: MapData = { projects: [], people: [], ticketsByProject: {} };
    expect(mergeMapData(empty, clone(empty))).toBe(empty);
    const withEmptyList: MapData = { projects: [makeProject("p1", "A", "A")], people: [], ticketsByProject: { p1: [] } };
    expect(mergeMapData(withEmptyList, clone(withEmptyList))).toBe(withEmptyList);
  });

  it("an optional field that is absent equals one that is undefined (as JSON.stringify saw it), but not one that is null", () => {
    const [ticket] = randomTickets(1, 1, "p1");
    const without: Record<string, unknown> = { ...ticket! };
    delete without["agentWork"];
    const current: MapData = { projects: [], people: [], ticketsByProject: { p1: [without as TicketSummary] } };
    const withUndefined: MapData = { projects: [], people: [], ticketsByProject: { p1: [{ ...without, agentWork: undefined } as TicketSummary] } };
    const withNull: MapData = { projects: [], people: [], ticketsByProject: { p1: [{ ...without, agentWork: null } as TicketSummary] } };
    expect(mergeMapData(current, withUndefined)).toBe(current);
    expect(mergeMapData(current, withNull)).not.toBe(current);
  });
});

describe("mergeMapData: cheap comparison", () => {
  it("does not serialize the lists to compare them", () => {
    const current = baseData(3);
    const next = clone(current);
    const spy = vi.spyOn(JSON, "stringify");
    try {
      mergeMapData(current, next);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("compares a ticket object that is already the same reference without reading it", () => {
    const current = baseData(4);
    const next: MapData = { ...current, ticketsByProject: { p1: [...current.ticketsByProject["p1"]!], p2: current.ticketsByProject["p2"]! } };
    expect(mergeMapData(current, next)).toBe(current);
  });
});
