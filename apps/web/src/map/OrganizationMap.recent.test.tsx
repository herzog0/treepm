import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { createRecentPlaces } from "../assistant/recentPlaces.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// A página de um ticket aberta vira lugar recente da pessoa (TREEPM-358).
const SLOW = 20_000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
const tickets: TicketSummary[] = [makeTicket("t1", "p1", 1, "Fechar a fase", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }), makeTicket("t2", "p1", 2, "Escrever", { key: "ALFA-2", parentId: "t1" })];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });

afterEach(() => window.localStorage.clear());

function mapWith(openTicketId: string | null) {
  const client = makeClient({ projects, tickets: { p1: tickets }, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, { getTicket: vi.fn(async (id: string) => ok(detailOf(tickets.find((entry) => entry.id === id)!))) } as Partial<ApiClient>);
  render(<OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openTicketId} onOpenTicketChange={vi.fn()} />);
}

describe("recent places from the map", () => {
  it("records the ticket whose page is open, under this organization, project and person", async () => {
    mapWith("t2");
    await screen.findByRole("heading", { level: 1, name: "Escrever" }, { timeout: SLOW });
    expect(createRecentPlaces("org-1", "person-1").read("p1")).toEqual(["t2"]);
  }, SLOW);

  it("records nothing when no page is open", async () => {
    mapWith(null);
    await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }, { timeout: SLOW });
    expect(createRecentPlaces("org-1", "person-1").read("p1")).toEqual([]);
  }, SLOW);
});
