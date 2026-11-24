import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketDetail, TicketSummary } from "../api/client.js";
import { RecentPlacesProvider } from "../assistant/RecentPlacesContext.js";
import { createRecentPlaces } from "../assistant/recentPlaces.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { CreateTicket } from "./CreateTicket.js";
import { TicketPage } from "./TicketPage.js";

// Os lugares recentes da pessoa (TREEPM-358): mover um ticket e criar à mão registram o pai.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t5", "p1", 5, "Fase vazia", { key: "ALFA-5" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "x", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const recents = () => createRecentPlaces("org-1", "person-1");

afterEach(() => window.localStorage.clear());

function page(client: ReturnType<typeof makeClient>) {
  render(
    <RecentPlacesProvider value={recents()}>
      <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t2" creating={null} onOpenTicket={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} onRemoved={vi.fn()} onStartCreate={vi.fn()} onCancelCreate={vi.fn()} onCreated={vi.fn()} />
    </RecentPlacesProvider>,
  );
}
function clientWithMove() {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
  });
  return client;
}
const move = async (name: string | RegExp) => {
  const pageEl = await screen.findByRole("complementary", { name: "Página do ticket" });
  await screen.findByRole("heading", { level: 1 });
  await userEvent.click(within(pageEl).getByRole("button", { name: "Mudar" }));
  await userEvent.click(within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getByRole("button", { name }));
};

describe("recent places from the ticket page", () => {
  it("moving a ticket records its new parent", async () => {
    const client = clientWithMove();
    page(client);
    await move(/Fase vazia/);
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t2", { parentId: "t5" }));
    await waitFor(() => expect(recents().read("p1")).toEqual(["t5"]));
  });

  it("a move that fails records nothing", async () => {
    const client = clientWithMove();
    Object.assign(client, { updateTicket: vi.fn(async () => failed("conflict", "ticket_cycle")) });
    page(client);
    await move(/Fase vazia/);
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalled());
    expect(recents().read("p1")).toEqual([]);
  });

  it("moving a ticket to the root records nothing", async () => {
    const client = clientWithMove();
    page(client);
    await move("Raiz do projeto");
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t2", { parentId: null }));
    expect(recents().read("p1")).toEqual([]);
  });

  it("creating a ticket by hand records its parent", async () => {
    const client = makeClient({ projects: [project], tickets: { p1: summaries } });
    Object.assign(client, { createTicket: vi.fn(async () => ok(detailOf(makeTicket("t9", "p1", 9, "Novo", { key: "ALFA-9" })))) });
    render(
      <RecentPlacesProvider value={recents()}>
        <CreateTicket client={client} project={project} request={{ projectId: "p1", parentId: "t1", draft: { title: "Novo", description: "" } }} onChanged={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} />
      </RecentPlacesProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(recents().read("p1")).toEqual(["t1"]));
  });

  it("creating at the root records nothing", async () => {
    const client = makeClient({ projects: [project], tickets: { p1: summaries } });
    Object.assign(client, { createTicket: vi.fn(async () => ok(detailOf(makeTicket("t9", "p1", 9, "Novo", { key: "ALFA-9" })))) });
    const onCreated = vi.fn();
    render(
      <RecentPlacesProvider value={recents()}>
        <CreateTicket client={client} project={project} request={{ projectId: "p1", parentId: null, draft: { title: "Novo", description: "" } }} onChanged={vi.fn()} onCreated={onCreated} onCancel={vi.fn()} />
      </RecentPlacesProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(recents().read("p1")).toEqual([]);
  });
});
