import { describe, expect, it } from "vitest";
import { makeGroup, makeProject, makeTicket, makeTreeClient } from "./fakes.js";

const project = makeProject("p1", "ALFA", "Alfa");
function setup() {
  return makeTreeClient({
    projects: [project],
    tickets: {
      p1: [
        makeGroup("g1", "p1", 1, "Fase 1", { progress: { done: 1, total: 2, excluded: 0 } }),
        makeTicket("t1", "p1", 2, "Feito", { parentId: "g1", status: "done" }),
        makeTicket("t2", "p1", 3, "A fazer", { parentId: "g1" }),
        makeGroup("g2", "p1", 4, "Vazio"),
        makeTicket("t3", "p1", 5, "Solto"),
      ],
    },
  });
}
const code = (result: { ok: boolean; error?: { code?: string } }) => (result.ok ? null : result.error?.code);

describe("the tree fake follows the ADR 0031 contract", () => {
  it("creates a group with status null and an empty progress, and a ticket by default", async () => {
    const client = setup();
    const group = await client.createTicket("p1", { title: "Novo", kind: "group" });
    expect(group).toMatchObject({ ok: true, data: { kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 }, number: 6 } });
    const ticket = await client.createTicket("p1", { title: "Outro" });
    expect(ticket).toMatchObject({ ok: true, data: { kind: "ticket", status: "todo", progress: null } });
  });

  it("refuses a ticket as parent with parent_not_group, on create and on move", async () => {
    const client = setup();
    expect(code(await client.createTicket("p1", { title: "X", parentId: "t3" }))).toBe("parent_not_group");
    expect(code(await client.updateTicket("t1", { parentId: "t3" }))).toBe("parent_not_group");
    expect(await client.updateTicket("t1", { parentId: "g2" })).toMatchObject({ ok: true, data: { parentId: "g2" } });
  });

  it("refuses a status on a group with group_has_no_status", async () => {
    expect(code(await setup().updateTicket("g1", { status: "done" }))).toBe("group_has_no_status");
  });

  it("turns a ticket into a group always, and a group into a ticket only when empty", async () => {
    const client = setup();
    expect(await client.updateTicket("t3", { kind: "group" })).toMatchObject({ ok: true, data: { kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 } } });
    expect(code(await client.updateTicket("g1", { kind: "ticket" }))).toBe("ticket_has_children");
    expect(await client.updateTicket("g2", { kind: "ticket" })).toMatchObject({ ok: true, data: { kind: "ticket", status: "todo", progress: null } });
  });

  it("recomputes the progress of a group from its ticket descendants", async () => {
    const client = setup();
    await client.updateTicket("t2", { status: "done" });
    const listed = await client.listTickets("p1");
    expect(listed.ok && listed.data.find((entry) => entry.id === "g1")?.progress).toEqual({ done: 2, total: 2, excluded: 0 });
  });

  it("refuses to remove a group with items, and removes an empty one", async () => {
    const client = setup();
    expect(code(await client.removeTicket("g1"))).toBe("ticket_has_children");
    expect((await client.removeTicket("g2")).ok).toBe(true);
    const listed = await client.listTickets("p1");
    expect(listed.ok && listed.data.map((entry) => entry.id)).not.toContain("g2");
  });

  it("serves the ticket detail from the same tree", async () => {
    expect(await setup().getTicket("t3")).toMatchObject({ ok: true, data: { id: "t3", kind: "ticket", description: "" } });
  });
});
