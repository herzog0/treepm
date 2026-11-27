import { describe, expect, it } from "vitest";
import { makeMe, makeProject, makeTicket, makeTreeClient } from "./fakes.js";

const project = makeProject("p1", "ALFA", "Alfa");
function setup() {
  return makeTreeClient({
    projects: [project],
    tickets: {
      p1: [
        makeTicket("g1", "p1", 1, "Fase 1", { status: "in_review" }),
        makeTicket("t1", "p1", 2, "Feito", { parentId: "g1", status: "done" }),
        makeTicket("t2", "p1", 3, "A fazer", { parentId: "g1" }),
        makeTicket("g2", "p1", 4, "Sem filhos"),
        makeTicket("t3", "p1", 5, "Solto"),
        makeTicket("n1", "p1", 6, "Neto", { parentId: "t2" }),
      ],
    },
  });
}
const code = (result: { ok: boolean; error?: { code?: string } }) => (result.ok ? null : result.error?.code);
const listed = async (client: ReturnType<typeof setup>) => {
  const result = await client.listTickets("p1");
  return result.ok ? result.data : [];
};

describe("the tree fake follows the ADR 0034 contract", () => {
  it("has no `kind`, always has a status, and progress only when there are children, over every descendant", async () => {
    const all = await listed(setup());
    for (const entry of all) {
      expect("kind" in entry).toBe(false);
      expect(entry.status).not.toBeNull();
    }
    expect(all.find((entry) => entry.id === "g1")).toMatchObject({ status: "in_review", progress: { done: 1, total: 3, excluded: 0 } });
    expect(all.find((entry) => entry.id === "t2")?.progress).toEqual({ done: 0, total: 1, excluded: 0 });
    expect(all.find((entry) => entry.id === "t3")?.progress).toBeNull();
  });

  it("creates a ticket under any ticket, with no `kind` and status todo", async () => {
    const client = setup();
    const created = await client.createTicket("p1", { title: "Novo", parentId: "t3" });
    expect(created).toMatchObject({ ok: true, data: { parentId: "t3", status: "todo", progress: null, number: 7 } });
    expect("kind" in (created.ok ? created.data : {})).toBe(false);
    expect(await client.createTicket("p1", { title: "Raiz" })).toMatchObject({ ok: true });
  });

  it("accepts any ticket as a parent, refusing only itself or a descendant with ticket_cycle", async () => {
    const client = setup();
    expect((await client.updateTicket("t3", { parentId: "g2" })).ok).toBe(true);
    expect(code(await client.updateTicket("g1", { parentId: "n1" }))).toBe("ticket_cycle");
    expect(code(await client.updateTicket("g1", { parentId: "g1" }))).toBe("ticket_cycle");
    expect(code(await client.createTicket("p1", { title: "X", parentId: "g2" }))).toBeNull();
  });

  it("refuses to set by hand the status of a ticket with children (409 status_is_derived); a leaf changes freely", async () => {
    const client = setup();
    expect(code(await client.updateTicket("g1", { status: "done" }))).toBe("status_is_derived");
    expect(code(await client.updateTicket("g1", { status: "cancelled" }))).toBe("status_is_derived");
    expect(code(await client.updateTicket("t3", { status: "done" }))).toBeNull();
  });

  it("computes a parent from its children, up to the root (ADR 0068)", async () => {
    const client = setup();
    await client.updateTicket("n1", { status: "done" });
    const all = await listed(client);
    expect(all.find((entry) => entry.id === "t2")?.status).toBe("done");
    expect(all.find((entry) => entry.id === "g1")?.status).toBe("done");
  });

  it("recomputes the progress of a ticket from all its descendants", async () => {
    const client = setup();
    await client.updateTicket("n1", { status: "in_review" });
    const all = await listed(client);
    expect(all.find((entry) => entry.id === "g1")?.progress).toEqual({ done: 1, total: 3, excluded: 0 });
  });

  it("refuses to remove a ticket with items, and removes one without", async () => {
    const client = setup();
    expect(code(await client.removeTicket("g1"))).toBe("ticket_has_children");
    expect((await client.removeTicket("g2")).ok).toBe(true);
    expect((await listed(client)).map((entry) => entry.id)).not.toContain("g2");
  });

  it("serves the ticket detail from the same tree", async () => {
    const detail = await setup().getTicket("t3");
    expect(detail).toMatchObject({ ok: true, data: { id: "t3", description: "" } });
    expect("kind" in (detail.ok ? detail.data : {})).toBe(false);
  });
});

describe("the tree fake computes the status of a parent from its children (ADR 0068)", () => {
  // d1 (concluído) > d2 (concluído) > d3 (concluído, folha); c1 (cancelado) > c2 (concluído); o1 (aberto, solto); f1 (finalizado, solto).
  const make = () =>
    makeTreeClient({
      projects: [project],
      tickets: {
        p1: [
          makeTicket("d1", "p1", 1, "Avô", { status: "done" }),
          makeTicket("d2", "p1", 2, "Pai", { parentId: "d1", status: "done" }),
          makeTicket("d3", "p1", 3, "Filho", { parentId: "d2", status: "done" }),
          makeTicket("c1", "p1", 4, "Cancelado", { status: "cancelled" }),
          makeTicket("c2", "p1", 5, "Dentro do cancelado", { parentId: "c1", status: "done" }),
          makeTicket("o1", "p1", 6, "Aberto solto"),
          makeTicket("f1", "p1", 7, "Finalizado solto", { status: "done" }),
          makeTicket("r1", "p1", 8, "Raiz concluída", { status: "done" }),
        ],
      },
    });
  const statusOf = async (client: ReturnType<typeof make>, id: string) => (await listed(client)).find((entry) => entry.id === id)?.status;

  it("a done ticket that receives an open child follows it, and the computation climbs to the root", async () => {
    const client = make();
    await client.createTicket("p1", { title: "Novo", parentId: "d3" });
    expect(await statusOf(client, "d3")).toBe("todo");
    expect(await statusOf(client, "d2")).toBe("todo");
    expect(await statusOf(client, "d1")).toBe("todo");
  });

  it("a finished child keeps the parent finished", async () => {
    const client = make();
    await client.createTicket("p1", { title: "Novo", parentId: "d3", status: "done" });
    await client.createTicket("p1", { title: "Outro", parentId: "d3", status: "cancelled" });
    expect(await statusOf(client, "d3")).toBe("done");
    expect(await statusOf(client, "d1")).toBe("done");
  });

  it("a cancelled parent follows its children too", async () => {
    const client = make();
    await client.createTicket("p1", { title: "Dentro do cancelado", parentId: "c1" });
    expect(await statusOf(client, "c1")).toBe("in_progress");
  });

  it("moving recomputes the old and the new parent", async () => {
    const client = make();
    await client.updateTicket("f1", { parentId: "r1" });
    expect(await statusOf(client, "r1")).toBe("done");
    await client.updateTicket("o1", { parentId: "r1" });
    expect(await statusOf(client, "r1")).toBe("in_progress");
    await client.updateTicket("o1", { parentId: "d3" });
    expect(await statusOf(client, "r1")).toBe("done");
    expect(await statusOf(client, "d1")).toBe("todo");
  });

  it("a child that starts again moves the parent and the grandparent to in progress", async () => {
    const client = make();
    await client.updateTicket("d3", { status: "in_progress" });
    expect(await statusOf(client, "d3")).toBe("in_progress");
    expect(await statusOf(client, "d2")).toBe("in_progress");
    expect(await statusOf(client, "d1")).toBe("in_progress");
  });

  it("the destination follows a ticket created from the conversation", async () => {
    const client = make();
    const loose = await client.createTicketFromConversation("c1", { parentId: "d3", placedBy: "search" });
    expect(loose).toMatchObject({ ok: true, data: { ticket: { parentId: "d3", status: "todo" } } });
    expect(await statusOf(client, "d3")).toBe("todo");
    expect(await statusOf(client, "d1")).toBe("todo");
  });

  it("the destination follows the new parent ticket of a confirmed proposal, with the chosen tickets inside it", async () => {
    const client = make();
    const created = await client.createTicketFromConversation("c1", { parentId: "r1", placedBy: "search", group: { title: "Grupo novo", description: "", ticketIds: ["o1"] } });
    expect(created.ok).toBe(true);
    const all = await listed(client);
    const group = all.find((entry) => entry.title === "Grupo novo");
    expect(group).toMatchObject({ parentId: "r1", status: "todo" });
    expect(all.find((entry) => entry.id === "o1")?.parentId).toBe(group?.id);
    expect(all.find((entry) => entry.id === (created.ok ? created.data.ticket.id : ""))?.parentId).toBe(group?.id);
    expect(await statusOf(client, "r1")).toBe("todo");
  });
});

describe("the summary fake follows the ADR 0033 contract, as ADR 0034 changed it", () => {
  const me = (clerk: "admin" | "member", role?: "reader" | "contributor") => ({ ...makeMe({ clerk }), roles: { clerk, teams: [], projects: role ? [{ projectId: "p1", role }] : [] } });
  const make = (extra: { me?: ReturnType<typeof me>; archived?: boolean; providerUp?: boolean } = {}) =>
    makeTreeClient({
      me: extra.me ?? me("admin"),
      projects: [extra.archived ? makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project],
      tickets: { p1: [makeTicket("g1", "p1", 1, "Fase 1"), makeTicket("t1", "p1", 2, "Feito", { parentId: "g1" }), makeTicket("g2", "p1", 3, "Sem filhos"), makeTicket("t2", "p1", 4, "Solto")] },
      summaries: { texts: { g1: { text: "Fase um", source: "assistant", updatedAt: "2026-11-20T10:00:00.000Z" } }, providerUp: extra.providerUp ?? true },
    });

  it("reads null without text, for any ticket (children or not), and 404 for an unknown one", async () => {
    const client = make();
    expect(await client.getTicketSummary("g2")).toEqual({ ok: true, data: { summary: null } });
    expect(await client.getTicketSummary("t2")).toEqual({ ok: true, data: { summary: null } });
    expect(await client.getTicketSummary("nada")).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  it("writes as a person, trimming, and enforces 1 to 1.000 characters", async () => {
    const client = make();
    expect(await client.putTicketSummary("g1", { text: "  Novo  " })).toMatchObject({ ok: true, data: { summary: { text: "Novo", source: "person" } } });
    expect(code(await client.putTicketSummary("g1", { text: "   " }))).toBe("validation_error");
    expect(code(await client.putTicketSummary("g1", { text: "a".repeat(1001) }))).toBe("validation_error");
    expect(await client.putTicketSummary("g1", { text: "a".repeat(1000) })).toMatchObject({ ok: true });
    expect(code(await client.putTicketSummary("t2", { text: "x" }))).toBe("ticket_has_no_items");
  });

  it("only editors write: a reader gets 403, an archived project 409 project_archived", async () => {
    expect(await make({ me: me("member", "reader") }).putTicketSummary("g1", { text: "x" })).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await make({ me: me("member", "contributor") }).putTicketSummary("g1", { text: "x" })).toMatchObject({ ok: true });
    expect(code(await make({ archived: true }).putTicketSummary("g1", { text: "x" }))).toBe("project_archived");
    expect(code(await make({ archived: true }).regenerateTicketSummary("g1"))).toBe("project_archived");
  });

  it("regenerates as the assistant, refusing a ticket without items and an unavailable provider", async () => {
    expect(await make().regenerateTicketSummary("g1")).toMatchObject({ ok: true, data: { summary: { source: "assistant" } } });
    expect(code(await make().regenerateTicketSummary("g2"))).toBe("ticket_has_no_items");
    expect(await make({ providerUp: false }).regenerateTicketSummary("g1")).toMatchObject({ ok: false, error: { kind: "unavailable", code: "assistant_unavailable" } });
    expect(await make({ me: me("member", "reader") }).regenerateTicketSummary("g1")).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });
});
