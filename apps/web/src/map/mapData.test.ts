import { describe, expect, it, vi } from "vitest";
import { makePerson, makeProject, makeTicket } from "../test/fakes.js";
import { loadMapData, mergeMapData } from "./mapData.js";
import type { Person, Project, TicketSummary } from "../api/client.js";
import type { MapData } from "./mapData.js";
import { makeClient, ok } from "../test/fakes.js";

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

describe("loadMapData with versions (ADR 0046)", () => {
  const projects = [makeProject("p1", "ALFA", "Alfa"), makeProject("p2", "BETA", "Beta")];
  const lists = { p1: [makeTicket("t1", "p1", 1, "Um")], p2: [makeTicket("t2", "p2", 1, "Dois")] };
  const clientWith = (answer: (projectId: string, version: string | null) => ReturnType<typeof ok>) => {
    const client = makeClient({ projects, tickets: lists, people: [makePerson("a", "Ana")] });
    client.listTicketsIfChanged = vi.fn(async (projectId: string, version: string | null) => answer(projectId, version)) as typeof client.listTicketsIfChanged;
    return client;
  };

  it("the first load sends no version and keeps the version each project came with", async () => {
    const client = clientWith((projectId, version) => {
      expect(version).toBeNull();
      return ok({ changed: true, tickets: lists[projectId as "p1" | "p2"], version: `W/"v1.${projectId}"` });
    });
    const result = await loadMapData(client);
    expect(result.ok && result.data.versions).toEqual({ p1: 'W/"v1.p1"', p2: 'W/"v1.p2"' });
    expect(result.ok && result.data.ticketsByProject.p1).toBe(lists.p1);
  });

  it("a refresh sends the version it has; a 304 reuses the very same list object", async () => {
    const first = await loadMapData(clientWith((projectId) => ok({ changed: true, tickets: lists[projectId as "p1" | "p2"], version: `W/"v1.${projectId}"` })));
    if (!first.ok) throw new Error("falhou");
    const sent: Record<string, string | null> = {};
    const client = clientWith((projectId, version) => {
      sent[projectId] = version;
      return ok({ changed: false });
    });
    const again = await loadMapData(client, first.data);
    expect(sent).toEqual({ p1: 'W/"v1.p1"', p2: 'W/"v1.p2"' });
    if (!again.ok) throw new Error("falhou");
    expect(again.data.ticketsByProject.p1).toBe(first.data.ticketsByProject.p1);
    expect(again.data.ticketsByProject.p2).toBe(first.data.ticketsByProject.p2);
    // Nada mudou: o resultado do merge é o próprio objeto da tela, então nada se redesenha.
    expect(mergeMapData(first.data, again.data)).toBe(first.data);
  });

  it("only the project that changed is replaced; a project without a version is fetched whole", async () => {
    const first = await loadMapData(clientWith((projectId) => ok({ changed: true, tickets: lists[projectId as "p1" | "p2"], version: projectId === "p1" ? 'W/"v1.p1"' : null })));
    if (!first.ok) throw new Error("falhou");
    const changedP1 = [makeTicket("t1", "p1", 1, "Um, editado")];
    const sent: Record<string, string | null> = {};
    const again = await loadMapData(
      clientWith((projectId, version) => {
        sent[projectId] = version;
        return projectId === "p1" ? ok({ changed: true, tickets: changedP1, version: 'W/"v1.p1b"' }) : ok({ changed: true, tickets: structuredClone(lists.p2), version: null });
      }),
      first.data,
    );
    expect(sent).toEqual({ p1: 'W/"v1.p1"', p2: null });
    if (!again.ok) throw new Error("falhou");
    const merged: MapData = mergeMapData(first.data, again.data);
    expect(merged.ticketsByProject.p1).toBe(changedP1);
    expect(merged.ticketsByProject.p2).toBe(first.data.ticketsByProject.p2);
    expect(merged.versions?.p1).toBe('W/"v1.p1b"');
  });

  it("an error in any project fails the load, as before", async () => {
    const client = clientWith((projectId) => (projectId === "p2" ? ({ ok: false, error: { kind: "unavailable" } } as never) : ok({ changed: false })));
    expect(await loadMapData(client)).toEqual({ ok: false, error: { kind: "unavailable" } });
  });
});
